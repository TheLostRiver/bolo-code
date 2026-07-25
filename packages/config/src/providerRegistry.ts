/**
 * 多 provider 配置归一化（纯函数，不实例化网络）。
 * 旧 `provider` ↔ 新 `providers` + `defaultProvider`。
 * 见 docs/ROADMAP.md §9.4
 */

import type { BoloConfigJson, ProviderConfigJson } from './types.ts'
import { DEFAULT_CONFIG } from './types.ts'

export type ProviderKindName =
  | 'mock'
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic'

/** 归一化后的命名 profile（仍可序列化；不含运行时 client） */
export type ProviderProfile = {
  id: string
  kind?: ProviderKindName
  label?: string
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  maxTokens?: number
  /**
   * Effort 方言：内置 id 字符串，或内联 dialect 对象。
   * 交给 createProviderFromProfile → provider config.effortDialect
   */
  effortDialect?: string | Record<string, unknown>
}

export type ProviderRegistry = {
  profiles: Record<string, ProviderProfile>
  /** 启动 / 缺省 active id */
  defaultId: string
}

export type ProviderProfileSummary = {
  id: string
  kind?: ProviderKindName
  model?: string
  label?: string
  baseUrl?: string
  /** 是否声明了 apiKey / apiKeyEnv（不暴露值） */
  hasKeyConfig: boolean
  isDefault: boolean
}

function normalizeKind(
  raw?: string,
): ProviderKindName | undefined {
  if (!raw) return undefined
  const k = raw.toLowerCase().trim()
  if (k === 'mock') return 'mock'
  if (k === 'openai-responses' || k === 'responses' || k === 'openai_responses') {
    return 'openai-responses'
  }
  if (k === 'openai' || k === 'openai-compatible') return 'openai-compatible'
  if (k === 'anthropic' || k === 'claude') return 'anthropic'
  return undefined
}

/** 浅合并两个 profile JSON（后写覆盖） */
export function mergeProviderConfigJson(
  base?: ProviderConfigJson,
  over?: ProviderConfigJson,
): ProviderConfigJson | undefined {
  if (!base && !over) return undefined
  return { ...(base ?? {}), ...(over ?? {}) }
}

/**
 * 合并 user/project 的 providers 表：同 id 字段浅合并；后层赢。
 */
export function mergeProvidersMaps(
  base?: Record<string, ProviderConfigJson>,
  over?: Record<string, ProviderConfigJson>,
): Record<string, ProviderConfigJson> | undefined {
  if (!base && !over) return undefined
  const ids = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(over ?? {}),
  ])
  const out: Record<string, ProviderConfigJson> = {}
  for (const id of ids) {
    const merged = mergeProviderConfigJson(base?.[id], over?.[id])
    if (merged) out[id] = merged
  }
  return out
}

/** 从 config.effort 抽出 dialect id 或内联对象 */
export function normalizeEffortDialectFromConfig(
  effort?: ProviderConfigJson['effort'],
): string | Record<string, unknown> | undefined {
  if (effort == null) return undefined
  if (typeof effort === 'string') {
    const t = effort.trim()
    return t || undefined
  }
  if (typeof effort === 'object' && !Array.isArray(effort)) {
    const o = effort as Record<string, unknown>
    if (typeof o.dialect === 'string' && o.dialect.trim()) {
      return o.dialect.trim()
    }
    if (o.dialect && typeof o.dialect === 'object') {
      return o.dialect as Record<string, unknown>
    }
    // 整段当作内联 dialect（含 levels/map/wire）
    if (o.levels || o.map || o.wire || o.id) {
      return o
    }
  }
  return undefined
}

export function profileFromConfigJson(
  id: string,
  raw?: ProviderConfigJson,
): ProviderProfile {
  const p = raw ?? {}
  const kind = normalizeKind(p.kind)
  const label = p.label?.trim() || undefined
  const apiKeyEnv = p.apiKeyEnv?.trim() || undefined
  const apiKey = p.apiKey?.trim() || undefined
  const baseUrl = p.baseUrl?.trim() || undefined
  const model = p.model?.trim() || undefined
  const effortDialect = normalizeEffortDialectFromConfig(p.effort)
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(label ? { label } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(p.timeoutMs != null && Number.isFinite(p.timeoutMs)
      ? { timeoutMs: Math.floor(p.timeoutMs) }
      : {}),
    ...(p.maxTokens != null && Number.isFinite(p.maxTokens)
      ? { maxTokens: Math.floor(p.maxTokens) }
      : {}),
    ...(effortDialect != null ? { effortDialect } : {}),
  }
}

/**
 * 将 BoloConfigJson 归一为 ProviderRegistry。
 *
 * 规则：
 * 1. 仅有 `provider` → `{ default: provider }`，defaultId=`default`
 * 2. 仅有 `providers` → 用 defaultProvider 或首个 key
 * 3. 两者都有 → providers 为主；若无 `default` 且未指定 defaultProvider，
 *    可用旧 provider 填 `default`（便于过渡）
 */
export function normalizeProviderRegistry(
  config: BoloConfigJson,
): ProviderRegistry {
  const profiles: Record<string, ProviderProfile> = {}
  const rawMap = config.providers
  const hasMap = rawMap && Object.keys(rawMap).length > 0

  if (hasMap) {
    for (const [rawId, raw] of Object.entries(rawMap!)) {
      const id = rawId.trim()
      if (!id) continue
      profiles[id] = profileFromConfigJson(id, raw)
    }
    // 过渡：无 default 条目且未点名 defaultProvider 时，把旧 provider 挂到 default
    if (
      config.provider &&
      !profiles.default &&
      !(config.defaultProvider && config.defaultProvider.trim())
    ) {
      profiles.default = profileFromConfigJson('default', config.provider)
    }
  } else if (config.provider) {
    profiles.default = profileFromConfigJson('default', config.provider)
  } else {
    profiles.default = profileFromConfigJson(
      'default',
      DEFAULT_CONFIG.provider ?? { kind: 'openai-compatible', model: 'gpt-4o-mini' },
    )
  }

  const keys = Object.keys(profiles)
  let defaultId = config.defaultProvider?.trim() || ''
  if (!defaultId || !profiles[defaultId]) {
    defaultId = profiles.default ? 'default' : keys[0]!
  }

  return { profiles, defaultId }
}

export function getProviderProfile(
  registry: ProviderRegistry,
  id: string,
): ProviderProfile | undefined {
  const t = id.trim()
  if (!t) return undefined
  return registry.profiles[t]
}

export function listProviderProfileSummaries(
  registry: ProviderRegistry,
  activeId?: string,
): Array<ProviderProfileSummary & { isActive?: boolean }> {
  return Object.values(registry.profiles)
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      model: p.model,
      label: p.label,
      baseUrl: p.baseUrl,
      hasKeyConfig: Boolean(p.apiKey || p.apiKeyEnv),
      isDefault: p.id === registry.defaultId,
      ...(activeId != null ? { isActive: p.id === activeId } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 脱敏摘要行（日志 /doctor；永不含 key） */
export function formatProviderProfileLine(
  p: ProviderProfileSummary & { isActive?: boolean },
): string {
  const mark = p.isActive ? '*' : p.isDefault ? '·' : ' '
  const kind = p.kind ?? '?'
  const model = p.model ?? '(no model)'
  const label = p.label ? ` "${p.label}"` : ''
  const key = p.hasKeyConfig ? 'key=cfg' : 'key=env?'
  return `${mark} ${p.id}${label}  kind=${kind}  model=${model}  ${key}`
}