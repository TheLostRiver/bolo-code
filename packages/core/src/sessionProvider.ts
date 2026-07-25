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
  createCallModelFromProvider,
  type QueryDeps,
} from './deps.ts'
import type { CompactSummarizer } from '../../compact/src/index.ts'
import type { AutoClassifyFn } from '../../permissions/src/index.ts'
import { createAutoClassifyFromCompleteText } from '../../permissions/src/index.ts'

export type SwitchableProviderSession = {
  provider: LlmProvider
  deps: QueryDeps
  model?: string
  providerId?: string
  providerRegistry?: ProviderRegistry
  providerProfile?: ProviderProfile
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
      message: string
    }
  | { ok: false; reason: string }

export type SwitchSessionModelResult =
  | { ok: true; model: string; providerId?: string; message: string; cacheBreak?: boolean }
  | { ok: false; reason: string }

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
  },
  opts?: { rebindSummarizer?: boolean },
) {
  const prevCall = session.deps.callModel
  // 保留 prepareMessages / uuid，只换 callModel
  session.provider = built.provider
  session.deps = {
    ...session.deps,
    callModel: createCallModelFromProvider(built.provider),
  }
  // 若外部曾完全替换 deps，仍确保 callModel 更新
  if (session.deps.callModel === prevCall) {
    session.deps.callModel = createCallModelFromProvider(built.provider)
  }
  if (built.model) session.model = built.model
  if (built.profileId) session.providerId = built.profileId
  if (built.profile) session.providerProfile = built.profile

  if (opts?.rebindSummarizer !== false) {
    session.compactSummarizer = createCompactSummarizerFromProvider(
      built.provider,
    )
  }

  if (built.provider.completeText) {
    const p = built.provider
    session.classifyPermission = createAutoClassifyFromCompleteText(
      (messages, o) => p.completeText!(messages, o),
      { model: session.model },
    )
  } else {
    session.classifyPermission = undefined
  }
}

/**
 * 热切命名 provider；messages 保留；缺 key / 未知 id → 失败且不改 session。
 */
export function switchSessionProvider(
  session: SwitchableProviderSession,
  id: string,
  opts?: { model?: string; rebindSummarizer?: boolean },
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

  const built = createProviderFromProfile(profile, {
    modelOverride: opts?.model,
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

  rebindSessionRuntime(
    session,
    {
      provider: built.provider,
      // 显式 model 覆盖 > 工厂返回 > profile 默认
      model:
        opts?.model?.trim() ||
        built.model ||
        profile.model ||
        undefined,
      profileId: rawId,
      profile,
    },
    { rebindSummarizer: opts?.rebindSummarizer },
  )

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

  return {
    ok: true,
    providerId: rawId,
    kind: built.kind,
    model: session.model,
    baseUrl: built.baseUrl ?? profile.baseUrl,
    previousId,
    message: `provider set to ${rawId} (kind=${built.kind}, model=${session.model ?? '(unset)'})`,
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
  session.model = name
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
  return {
    ok: true,
    model: name,
    providerId: session.providerId,
    cacheBreak,
    message: session.providerId
      ? `model set to ${name} (provider ${session.providerId})`
      : `model set to ${name}`,
  }
}

export function listSessionProviders(session: SwitchableProviderSession): Array<{
  id: string
  kind?: string
  model?: string
  label?: string
  baseUrl?: string
  hasKeyConfig: boolean
  isDefault: boolean
  isActive: boolean
}> {
  const reg = session.providerRegistry
  if (!reg) return []
  return listProviderProfileSummaries(reg, session.providerId).map((p) => ({
    ...p,
    isActive: p.isActive === true,
  }))
}

export function formatSessionProvidersSlash(
  session: SwitchableProviderSession,
): string {
  const list = listSessionProviders(session)
  if (!list.length) {
    return [
      `active: kind=${session.provider?.id ?? '(unset)'} model=${session.model ?? '(unset)'}`,
      '(no providers map — only legacy single provider; add config.providers to enable /provider use)',
    ].join('\n')
  }
  const lines = [
    `active: ${session.providerId ?? '(unset)'}  kind=${session.provider?.id ?? '?'}  model=${session.model ?? '(unset)'}`,
    'providers (* = active, · = default):',
    ...list.map((p) => formatProviderProfileLine(p)),
    'usage: /provider use <id> [model]',
  ]
  return lines.join('\n')
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