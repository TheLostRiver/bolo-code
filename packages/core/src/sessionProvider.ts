/**
 * 会话多 provider 热切（P2）
 * - 换 session.provider + 重挂 deps.callModel
 * - 重绑 compactSummarizer
 * - 本地 prompt-cache forced break（无遥测）
 * - 失败保留旧实例
 */

import {
  createCompactSummarizerFromProvider,
  createProviderFromProfile,
  detectEffortDialectId,
  listEffortChoosable,
  type LlmProvider,
} from '../../providers/src/index.ts'
import {
  getProviderProfile,
  listProviderProfileSummaries,
  formatProviderProfileLine,
  type ProviderProfile,
  type ProviderRegistry,
} from '../../config/src/providerRegistry.ts'
import {
  resolveModelMetadata,
  type ResolvedModelMetadata,
} from '../../config/src/modelMetadata.ts'
import {
  formatModelMetadataSummary,
  toModelMetadataView,
  type ModelMetadataView,
} from '../../config/src/modelMetadataView.ts'
import {
  formatSkillCatalog,
  type LoadedSkill,
} from '../../skills/src/index.ts'
import {
  createCallModelFromProvider,
  type QueryDeps,
} from './deps.ts'
import type { CompactSummarizer } from '../../compact/src/index.ts'
import type { AutoClassifyFn } from '../../permissions/src/index.ts'
import { createAutoClassifyFromCompleteText } from '../../permissions/src/index.ts'
import { clampEffortForSession } from './effortClamp.ts'
import { replaceSkillCatalogSection } from './systemPrompt.ts'

export type SwitchableProviderSession = {
  provider: LlmProvider
  deps: QueryDeps
  model?: string
  providerId?: string
  providerRegistry?: ProviderRegistry
  providerProfile?: ProviderProfile
  resolvedModel?: ResolvedModelMetadata
  contextWindowTokens?: number
  maxOutputTokens?: number
  legacyContextWindowTokens?: number
  skills?: LoadedSkill[]
  systemPromptSections?: string[]
  /** E 轨：当前方言（热切后更新） */
  effortDialect?: string | Record<string, unknown>
  effortLevel?: string
  compactSummarizer?: CompactSummarizer
  classifyPermission?: AutoClassifyFn
  promptCacheState?: {
    lastBreakReason?: string
    lastBreakDetail?: string
    lastCheckedAt?: number
    breakCount?: number
    lastCacheAt?: number
    lastModel?: string
    stablePrefixHash?: string
  }
}

export type SwitchSessionProviderResult =
  | {
      ok: true
      providerId: string
      kind: string
      model?: string
      baseUrl?: string
      previousId?: string
      modelMetadata: ModelMetadataView
      message: string
    }
  | { ok: false; reason: string }

export type SwitchSessionModelResult =
  | {
      ok: true
      model: string
      providerId?: string
      modelMetadata: ModelMetadataView
      message: string
      cacheBreak?: boolean
    }
  | { ok: false; reason: string }

function sessionProviderProfile(
  session: SwitchableProviderSession,
): ProviderProfile | undefined {
  return (
    session.providerProfile ??
    (session.providerRegistry && session.providerId
      ? getProviderProfile(session.providerRegistry, session.providerId)
      : undefined)
  )
}

function legacySessionSnapshot(
  session: SwitchableProviderSession,
  providerId: string,
): ResolvedModelMetadata | undefined {
  const contextWindowTokens = session.contextWindowTokens
  const maxOutputTokens = session.maxOutputTokens
  if (
    typeof contextWindowTokens !== 'number' ||
    contextWindowTokens <= 0 ||
    typeof maxOutputTokens !== 'number' ||
    maxOutputTokens <= 0 ||
    maxOutputTokens > contextWindowTokens
  ) {
    return undefined
  }
  return {
    providerId,
    ...(session.model ? { model: session.model } : {}),
    contextWindowTokens,
    maxOutputTokens,
    sources: {
      contextWindow: 'snapshot',
      maxOutput: 'snapshot',
    },
    usedFallback: false,
    warnings: [],
  }
}

export function getSessionModelMetadataView(
  session: SwitchableProviderSession,
): ModelMetadataView {
  if (session.resolvedModel) {
    return toModelMetadataView(session.resolvedModel)
  }
  const profile = sessionProviderProfile(session)
  const providerId =
    session.providerId?.trim() ||
    profile?.id?.trim() ||
    String(session.provider?.id || 'default')
  return toModelMetadataView(
    resolveModelMetadata({
      providerId,
      model: session.model ?? profile?.model,
      profile,
      legacyContextWindowTokens:
        session.legacyContextWindowTokens ?? session.contextWindowTokens,
      snapshot: legacySessionSnapshot(session, providerId),
    }),
  )
}

function forcePromptCacheBreak(
  session: SwitchableProviderSession,
  detail: string,
) {
  const st = session.promptCacheState
  if (!st) return
  st.lastBreakReason = 'forced'
  st.lastBreakDetail = detail
  st.lastCheckedAt = Date.now()
  st.breakCount = (st.breakCount ?? 0) + 1
  // 清空稳定前缀 / lastCache，下一轮 note 会当作新布局
  st.lastCacheAt = undefined
  st.stablePrefixHash = undefined
}

function rebindSessionRuntime(
  session: SwitchableProviderSession,
  built: {
    provider: LlmProvider
    model?: string
    profileId?: string
    profile?: ProviderProfile
    resolvedModel: ResolvedModelMetadata
    systemPromptSections?: string[]
  },
  opts?: { rebindSummarizer?: boolean },
) {
  const prevCall = session.deps.callModel
  const nextCall = createCallModelFromProvider(built.provider)
  const nextSummarizer =
    opts?.rebindSummarizer === false
      ? session.compactSummarizer
      : createCompactSummarizerFromProvider(built.provider)
  const nextClassifier = built.provider.completeText
    ? createAutoClassifyFromCompleteText(
        (messages, o) => built.provider.completeText!(messages, o),
        { model: built.model },
      )
    : undefined

  // 保留 prepareMessages / uuid，只换 callModel
  session.provider = built.provider
  session.deps = {
    ...session.deps,
    callModel: nextCall,
  }
  // 若外部曾完全替换 deps，仍确保 callModel 更新
  if (session.deps.callModel === prevCall) {
    session.deps.callModel = nextCall
  }
  session.model = built.model
  if (built.profileId) session.providerId = built.profileId
  if (built.profile) session.providerProfile = built.profile
  session.resolvedModel = built.resolvedModel
  session.contextWindowTokens = built.resolvedModel.contextWindowTokens
  session.maxOutputTokens = built.resolvedModel.maxOutputTokens
  if (built.systemPromptSections) {
    session.systemPromptSections = built.systemPromptSections
  }

  session.compactSummarizer = nextSummarizer
  session.classifyPermission = nextClassifier
}

function targetSkillCatalogSections(
  session: SwitchableProviderSession,
  resolvedModel: ResolvedModelMetadata,
): string[] | undefined {
  if (!session.systemPromptSections?.length || !session.skills?.length) {
    return undefined
  }
  const catalog = formatSkillCatalog(session.skills, {
    contextWindowTokens: resolvedModel.contextWindowTokens,
  })
  return replaceSkillCatalogSection(
    session.systemPromptSections,
    catalog || undefined,
  )
}

/**
 * 热切命名 provider；messages 保留；缺 key / 未知 id → 失败且不改 session。
 */
export function switchSessionProvider(
  session: SwitchableProviderSession,
  id: string,
  opts?: {
    model?: string
    rebindSummarizer?: boolean
    /** Resume-only fallback; resolver still prefers current profile/catalog. */
    snapshot?: ResolvedModelMetadata
  },
): SwitchSessionProviderResult {
  const rawId = id.trim()
  if (!rawId) {
    return { ok: false, reason: 'provider id required' }
  }
  const registry = session.providerRegistry
  if (!registry || !Object.keys(registry.profiles).length) {
    return {
      ok: false,
      reason:
        'no provider registry on session (load via createSessionFromWorkspace / attachProviderRegistry)',
    }
  }
  const profile = getProviderProfile(registry, rawId)
  if (!profile) {
    const known = Object.keys(registry.profiles).sort().join(', ')
    return {
      ok: false,
      reason: `unknown provider "${rawId}" (known: ${known || 'none'})`,
    }
  }

  const targetModel =
    opts?.model?.trim() || profile.model || undefined
  const resolvedModel = resolveModelMetadata({
    providerId: rawId,
    model: targetModel,
    profile,
    legacyContextWindowTokens: session.legacyContextWindowTokens,
    snapshot: opts?.snapshot ?? session.resolvedModel,
  })
  const built = createProviderFromProfile(profile, {
    modelOverride: targetModel,
    maxTokensOverride: resolvedModel.maxOutputTokens,
  })
  if (built.missingKey && built.kind === 'mock' && profile.kind !== 'mock') {
    const envHint = profile.apiKeyEnv
      ? `set env ${profile.apiKeyEnv}`
      : 'set BOLO_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY or profile.apiKeyEnv'
    return {
      ok: false,
      reason: `provider "${rawId}" missing API key (${envHint}); kept previous provider`,
    }
  }

  const previousId = session.providerId
  const prevKind = session.provider?.id
  const prevModel = session.model
  let systemPromptSections: string[] | undefined
  try {
    systemPromptSections = targetSkillCatalogSections(session, resolvedModel)
  } catch (error) {
    return {
      ok: false,
      reason: `provider "${rawId}" metadata preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }; kept previous provider`,
    }
  }

  rebindSessionRuntime(
    session,
    {
      provider: built.provider,
      // 显式 model 覆盖 > 工厂返回 > profile 默认
      model:
        targetModel ?? built.model,
      profileId: rawId,
      profile,
      resolvedModel,
      systemPromptSections,
    },
    { rebindSummarizer: opts?.rebindSummarizer },
  )

  // E 轨：方言随 profile 走（供 /effort 预览）
  session.effortDialect = profile.effortDialect

  forcePromptCacheBreak(
    session,
    `provider ${previousId ?? prevKind ?? '?'}→${rawId}` +
      (prevModel && session.model && prevModel !== session.model
        ? ` model ${prevModel}→${session.model}`
        : ''),
  )
  if (session.promptCacheState && session.model) {
    session.promptCacheState.lastModel = session.model
  }

  // CX6：保留意图；不可选则 clamp → auto
  const clamp = clampEffortForSession(session)

  // CX4：热切后 tip — dialect + choosable 摘要
  const dialect =
    session.effortDialect ??
    profile.effortDialect ??
    detectEffortDialectId({
      kind: built.kind,
      baseUrl: profile.baseUrl,
      model: session.model ?? profile.model,
    })
  const choosable = listEffortChoosable(dialect as string | undefined, {
    isAgent: true,
    model: session.model ?? profile.model,
  })
  const dialectId =
    typeof dialect === 'string'
      ? dialect
      : dialect && typeof dialect === 'object' && 'id' in dialect
        ? String((dialect as { id?: string }).id ?? 'custom')
        : String(dialect ?? 'max-tokens')

  let message =
    `provider set to ${rawId} (kind=${built.kind}, model=${session.model ?? '(unset)'})` +
    `\n  dialect=${dialectId}` +
    (choosable.length ? ` · choosable: ${choosable.join(', ')}` : '')
  if (clamp.warning) {
    message += `\n${clamp.warning}`
  }
  const modelMetadata = getSessionModelMetadataView(session)
  message += `\n${formatModelMetadataSummary(modelMetadata)}`

  return {
    ok: true,
    providerId: rawId,
    kind: built.kind,
    model: session.model,
    baseUrl: built.baseUrl ?? profile.baseUrl,
    previousId,
    modelMetadata,
    message,
  }
}

/**
 * 仅改当前后端 model；可选 `id/model` 糖由 slash 解析后先 switch 再调本函数。
 */
export function switchSessionModel(
  session: SwitchableProviderSession,
  model: string,
): SwitchSessionModelResult {
  const name = model.trim()
  if (!name) return { ok: false, reason: 'model name required' }
  const prev = session.model
  const profile =
    session.providerProfile ??
    (session.providerRegistry && session.providerId
      ? getProviderProfile(session.providerRegistry, session.providerId)
      : undefined)
  if (profile) {
    const providerId =
      session.providerId?.trim() || profile.id?.trim() || 'default'
    const resolvedModel = resolveModelMetadata({
      providerId,
      model: name,
      profile,
      legacyContextWindowTokens: session.legacyContextWindowTokens,
      snapshot: session.resolvedModel,
    })
    const built = createProviderFromProfile(profile, {
      modelOverride: name,
      maxTokensOverride: resolvedModel.maxOutputTokens,
    })
    if (built.missingKey && built.kind === 'mock' && profile.kind !== 'mock') {
      return {
        ok: false,
        reason: `model switch could not rebuild provider "${providerId}" because its API key is unavailable; kept previous model`,
      }
    }
    let systemPromptSections: string[] | undefined
    try {
      systemPromptSections = targetSkillCatalogSections(session, resolvedModel)
    } catch (error) {
      return {
        ok: false,
        reason: `model metadata preparation failed: ${
          error instanceof Error ? error.message : String(error)
        }; kept previous model`,
      }
    }
    rebindSessionRuntime(session, {
      provider: built.provider,
      model: name,
      profileId: providerId,
      profile,
      resolvedModel,
      systemPromptSections,
    })
  } else {
    const resolvedModel = resolveModelMetadata({
      providerId:
        session.providerId?.trim() || String(session.provider.id || 'default'),
      model: name,
      legacyContextWindowTokens:
        session.legacyContextWindowTokens ?? session.contextWindowTokens,
      snapshot: session.resolvedModel,
    })
    session.model = name
    session.resolvedModel = resolvedModel
    session.contextWindowTokens = resolvedModel.contextWindowTokens
    session.maxOutputTokens = resolvedModel.maxOutputTokens
  }
  let cacheBreak = false
  if (prev && prev !== name) {
    forcePromptCacheBreak(session, `model ${prev}→${name}`)
    cacheBreak = true
  }
  if (session.promptCacheState) {
    session.promptCacheState.lastModel = name
  }
  // 分类器跟 model
  if (session.provider.completeText) {
    const p = session.provider
    session.classifyPermission = createAutoClassifyFromCompleteText(
      (messages, o) => p.completeText!(messages, o),
      { model: name },
    )
  }
  // CX2/CX6：换 model 后重新 clamp effort
  const clamp = clampEffortForSession(session)
  let message = session.providerId
    ? `model set to ${name} (provider ${session.providerId})`
    : `model set to ${name}`
  if (clamp.warning) message += `\n${clamp.warning}`
  const modelMetadata = getSessionModelMetadataView(session)
  message += `\n${formatModelMetadataSummary(modelMetadata)}`
  return {
    ok: true,
    model: name,
    providerId: session.providerId,
    modelMetadata,
    cacheBreak,
    message,
  }
}

export function listSessionProviders(session: SwitchableProviderSession) {
  const reg = session.providerRegistry
  if (!reg) return []
  return listProviderProfileSummaries(reg, session.providerId).map((p) => ({
    ...p,
    isActive: p.isActive === true,
    modelMetadata: toModelMetadataView(
      resolveModelMetadata({
        providerId: p.id,
        model: p.model,
        profile: getProviderProfile(reg, p.id),
        legacyContextWindowTokens: session.legacyContextWindowTokens,
        snapshot: session.resolvedModel,
      }),
    ),
  }))
}

export function formatSessionProvidersSlash(
  session: SwitchableProviderSession,
): string {
  const list = listSessionProviders(session)
  if (!list.length) {
    const metadata = getSessionModelMetadataView(session)
    return [
      `active: kind=${session.provider?.id ?? '(unset)'} model=${session.model ?? '(unset)'}`,
      `metadata: ${formatModelMetadataSummary(metadata)}`,
      '(no providers map — only legacy single provider; add config.providers to enable /provider use)',
    ].join('\n')
  }
  const lines = [
    `active: ${session.providerId ?? '(unset)'}  kind=${session.provider?.id ?? '?'}  model=${session.model ?? '(unset)'}`,
    'providers (* = active, · = default):',
    ...list.map(
      (p) =>
        `${formatProviderProfileLine(p)} · ${formatModelMetadataSummary(
          p.modelMetadata,
        )}`,
    ),
    'usage: /provider use <id> [model] · /provider help',
  ]
  return lines.join('\n')
}

/** CLI arrowPicker 用：一行摘要（无密钥） */
export function formatProviderPickerLabel(p: {
  id: string
  kind?: string
  model?: string
  label?: string
  isActive?: boolean
  isDefault?: boolean
}): string {
  const mark = p.isActive ? '*' : p.isDefault ? '·' : ' '
  const name = p.label?.trim() ? `${p.id} "${p.label.trim()}"` : p.id
  const kind = p.kind ?? '?'
  const model = p.model ?? '(no model)'
  return `${mark} ${name}  ${kind}  ${model}`
}

export function buildProviderPickerItems(
  session: SwitchableProviderSession,
): Array<{ id: string; label: string }> {
  return listSessionProviders(session).map((p) => ({
    id: p.id,
    label: formatProviderPickerLabel(p),
  }))
}

/** 当前 active 在列表中的下标；无则 0 */
export function activeProviderPickerIndex(
  session: SwitchableProviderSession,
): number {
  const list = listSessionProviders(session)
  const i = list.findIndex((p) => p.isActive)
  return i >= 0 ? i : 0
}

/** 把 registry 挂到已有 session（workspace 装配 / 测试） */
export function attachProviderRegistry(
  session: SwitchableProviderSession,
  registry: ProviderRegistry,
  activeId?: string,
): void {
  session.providerRegistry = registry
  const id = activeId?.trim() || registry.defaultId
  session.providerId = id
  const profile = getProviderProfile(registry, id)
  if (profile) session.providerProfile = profile
}
