/**
 * Effort 方言引擎（E 轨）
 * 意图字符串 → body patch；厂商差异用数据表，不用永久 if。
 * 见 docs/EFFORT.md
 */

import { mapEffort, DEFAULT_EFFORT_BASE_MAX_TOKENS } from './effort.ts'

/** 产品层常用意图（超集；不要求每家都实现） */
export const CANONICAL_EFFORT_LEVELS = [
  'auto',
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type CanonicalEffortLevel = (typeof CANONICAL_EFFORT_LEVELS)[number]

export type EffortWireOp =
  | {
      shape: 'body_field'
      field: string
      valueFrom: 'resolved' | 'fixed'
      fixed?: string | boolean | number | null
    }
  | {
      shape: 'nested_object'
      /** dot path，如 reasoning.effort */
      path: string
      valueFrom: 'resolved' | 'fixed'
      fixed?: string | boolean | number | null
    }
  | {
      shape: 'output_config'
      key?: string
      valueFrom: 'resolved' | 'fixed'
      fixed?: string | number | null
    }
  | { shape: 'none' }

export type EffortDialect = {
  id?: string
  /** 该后端原生可接受的 wire 值 */
  levels: string[]
  /** 非 agent 时 auto → 此 wire；null/缺省 = 不写强度字段 */
  default?: string | null
  /** agent 主循环 auto 时默认 wire（对照 DS Agent → max） */
  agentDefault?: string | null
  /** 意图 → wire；null = 不写强度（走 onNone） */
  map: Record<string, string | null>
  aliases?: Record<string, string>
  wire: EffortWireOp[]
  onNone?: EffortWireOp[]
  missing?: 'reject' | 'passthrough' | 'clamp'
  /**
   * 是否叠旧 mapEffort 的 max_tokens 倍率。
   * true / 缺省且 id=max-tokens：开；有 reasoning wire 的方言默认 false。
   */
  applyTokenScale?: boolean
  /**
   * 当 resolvedWire 非 null 时合并进请求 Header（如 Anthropic effort beta）。
   * 多值用逗号与已有同名 header 合并去重。
   */
  requestHeaders?: Record<string, string>
  notes?: string
}

export type EffortResolveContext = {
  /** 主 agent loop / 带 tools 的 completion */
  isAgent?: boolean
  model?: string
  baseMaxTokens?: number
}

export type EffortWirePlan = {
  ok: true
  /** 归一后的意图（别名展开后） */
  intent: string
  /** 写入 API 的值；null = 未写强度字段 */
  resolvedWire: string | null
  /** 人类可读：low → high */
  display: string
  patches: Array<{ path: string[]; value: unknown; op: 'set' | 'delete' }>
  maxTokens?: number
  dialectId?: string
  /** 有强度 wire 时附带的请求头（如 anthropic-beta） */
  requestHeaders?: Record<string, string>
  notes?: string
}

export type EffortWireError = {
  ok: false
  reason: string
  intent?: string
  dialectId?: string
}

export type EffortResolveResult = EffortWirePlan | EffortWireError

// ── builtins（数据，非厂商 if 分支）──

export const DIALECT_MAX_TOKENS: EffortDialect = {
  id: 'max-tokens',
  levels: ['low', 'medium', 'high', 'max'],
  default: null,
  agentDefault: null,
  map: {
    none: null,
    off: null,
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'max',
    max: 'max',
    ultra: 'max',
  },
  aliases: { ultra: 'max' },
  wire: [{ shape: 'none' }],
  applyTokenScale: true,
  notes: 'legacy: only scales max_tokens; not API reasoning strength',
}

export const DIALECT_OFF: EffortDialect = {
  id: 'off',
  levels: [],
  default: null,
  map: {},
  wire: [{ shape: 'none' }],
  applyTokenScale: false,
  missing: 'passthrough',
  notes: 'no reasoning field, no token scale',
}

/** DeepSeek Chat Completions · 官方 high|max + 兼容折叠 */
export const DIALECT_DEEPSEEK_CHAT: EffortDialect = {
  id: 'deepseek-chat',
  levels: ['high', 'max'],
  default: null,
  agentDefault: 'max',
  map: {
    none: null,
    off: null,
    minimal: 'high',
    low: 'high',
    medium: 'high',
    high: 'high',
    xhigh: 'max',
    max: 'max',
    ultra: 'max',
  },
  aliases: { ultra: 'max' },
  wire: [
    {
      shape: 'body_field',
      field: 'reasoning_effort',
      valueFrom: 'resolved',
    },
  ],
  onNone: [
    {
      shape: 'nested_object',
      path: 'thinking.type',
      valueFrom: 'fixed',
      fixed: 'disabled',
    },
  ],
  missing: 'reject',
  applyTokenScale: false,
  notes:
    'DeepSeek: reasoning_effort high|max; low/medium→high; xhigh→max; agent auto→max',
}

/** OpenAI Responses API · reasoning.effort */
export const DIALECT_OPENAI_RESPONSES: EffortDialect = {
  id: 'openai-responses',
  levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  default: null,
  agentDefault: null,
  map: {
    none: 'none',
    off: 'none',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
    ultra: 'max',
  },
  aliases: { ultra: 'max', off: 'none' },
  wire: [
    {
      shape: 'nested_object',
      path: 'reasoning.effort',
      valueFrom: 'resolved',
    },
  ],
  missing: 'passthrough',
  applyTokenScale: false,
  notes: 'OpenAI Responses reasoning.effort; ultra→max',
}

/** Anthropic Messages · output_config.effort（对照 HC / Claude） */
export const DIALECT_ANTHROPIC_OUTPUT: EffortDialect = {
  id: 'anthropic-output',
  levels: ['low', 'medium', 'high', 'max'],
  default: null,
  agentDefault: null,
  map: {
    none: null,
    off: null,
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'max',
    max: 'max',
    ultra: 'max',
  },
  aliases: { ultra: 'max', off: 'none' },
  wire: [
    {
      shape: 'output_config',
      key: 'effort',
      valueFrom: 'resolved',
    },
  ],
  missing: 'reject',
  applyTokenScale: false,
  // HelsincyCode constants/betas.ts
  requestHeaders: {
    'anthropic-beta': 'effort-2025-11-24',
  },
  notes:
    'Anthropic/HC: output_config.effort low|medium|high|max; xhigh/ultra→max; thinking 独立',
}

/** 顶栏 reasoning_effort 透传（自定义 levels 可再配） */
export const DIALECT_PASSTHROUGH_REASONING_EFFORT: EffortDialect = {
  id: 'passthrough-reasoning-effort',
  levels: ['high', 'max', 'low', 'medium', 'xhigh', 'minimal', 'none'],
  default: null,
  map: {
    none: null,
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
    ultra: 'max',
  },
  aliases: { ultra: 'max' },
  wire: [
    {
      shape: 'body_field',
      field: 'reasoning_effort',
      valueFrom: 'resolved',
    },
  ],
  missing: 'passthrough',
  applyTokenScale: false,
}

const BUILTIN: Record<string, EffortDialect> = {
  'max-tokens': DIALECT_MAX_TOKENS,
  off: DIALECT_OFF,
  'deepseek-chat': DIALECT_DEEPSEEK_CHAT,
  'openai-responses': DIALECT_OPENAI_RESPONSES,
  'anthropic-output': DIALECT_ANTHROPIC_OUTPUT,
  'passthrough-reasoning-effort': DIALECT_PASSTHROUGH_REASONING_EFFORT,
  // 别名
  deepseek: DIALECT_DEEPSEEK_CHAT,
  responses: DIALECT_OPENAI_RESPONSES,
  anthropic: DIALECT_ANTHROPIC_OUTPUT,
  claude: DIALECT_ANTHROPIC_OUTPUT,
  legacy: DIALECT_MAX_TOKENS,
}

export function listBuiltinEffortDialectIds(): string[] {
  return Object.keys(BUILTIN).filter(
    (k) =>
      !['deepseek', 'responses', 'legacy', 'anthropic', 'claude'].includes(k),
  )
}

export function getBuiltinEffortDialect(
  id: string,
): EffortDialect | undefined {
  const k = id.trim().toLowerCase()
  const d = BUILTIN[k]
  return d ? cloneDialect(d) : undefined
}

function cloneDialect(d: EffortDialect): EffortDialect {
  return {
    ...d,
    levels: [...d.levels],
    map: { ...d.map },
    ...(d.aliases ? { aliases: { ...d.aliases } } : {}),
    wire: d.wire.map((w) => ({ ...w })),
    ...(d.onNone ? { onNone: d.onNone.map((w) => ({ ...w })) } : {}),
    ...(d.requestHeaders ? { requestHeaders: { ...d.requestHeaders } } : {}),
  }
}

/**
 * 解析方言：内置 id 字符串 | 内联对象。
 */
export function resolveEffortDialect(
  raw?: string | EffortDialect | null,
): EffortDialect {
  if (raw == null) return cloneDialect(DIALECT_MAX_TOKENS)
  if (typeof raw === 'string') {
    const b = getBuiltinEffortDialect(raw)
    if (b) return b
    // 未知 id → 保守 max-tokens，避免瞎写字段
    return cloneDialect(DIALECT_MAX_TOKENS)
  }
  // 内联：可 dialect: "deepseek-chat" 混在对象里？仅对象
  const base =
    raw.id && BUILTIN[raw.id]
      ? cloneDialect(BUILTIN[raw.id]!)
      : cloneDialect(DIALECT_MAX_TOKENS)
  return {
    ...base,
    ...raw,
    levels: raw.levels?.length ? [...raw.levels] : base.levels,
    map: { ...base.map, ...(raw.map ?? {}) },
    aliases: { ...(base.aliases ?? {}), ...(raw.aliases ?? {}) },
    wire: raw.wire?.length ? raw.wire.map((w) => ({ ...w })) : base.wire,
    onNone: raw.onNone ?? base.onNone,
    requestHeaders: raw.requestHeaders
      ? { ...(base.requestHeaders ?? {}), ...raw.requestHeaders }
      : base.requestHeaders,
    id: raw.id ?? base.id,
  }
}

/**
 * 可选指纹（可关）：猜内置方言 id。
 */
export function detectEffortDialectId(opts: {
  kind?: string
  baseUrl?: string
  model?: string
}): string {
  const kind = (opts.kind ?? '').toLowerCase()
  const blob = `${opts.baseUrl ?? ''} ${opts.model ?? ''}`.toLowerCase()
  if (kind === 'openai-responses' || kind === 'responses') {
    return 'openai-responses'
  }
  if (kind === 'anthropic' || kind === 'claude') {
    return 'anthropic-output'
  }
  if (kind === 'mock') return 'off'
  if (blob.includes('deepseek')) return 'deepseek-chat'
  // 兼容口默认不瞎写 reasoning_effort
  return 'max-tokens'
}

export function isCanonicalEffortLevel(v: string): boolean {
  const t = v.trim().toLowerCase()
  return (CANONICAL_EFFORT_LEVELS as readonly string[]).includes(t)
}

/** /effort 可接受：超集 + 任意非空（passthrough 方言用） */
export function isAcceptableEffortInput(v: string): boolean {
  const t = v.trim().toLowerCase()
  if (!t) return false
  if (isCanonicalEffortLevel(t)) return true
  // 允许原生 wire 串（high/max/xhigh 等已在超集）；其它短 token
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(t)
}

function opToPatches(
  op: EffortWireOp,
  resolved: string | null,
): EffortWirePlan['patches'] {
  if (op.shape === 'none') return []

  let value: unknown
  if (op.valueFrom === 'fixed') {
    value = op.fixed ?? null
  } else {
    value = resolved
  }

  if (op.shape === 'body_field') {
    if (value == null) {
      return [{ path: [op.field], value: null, op: 'delete' }]
    }
    return [{ path: [op.field], value, op: 'set' }]
  }

  if (op.shape === 'nested_object') {
    const path = op.path.split('.').map((p) => p.trim()).filter(Boolean)
    if (!path.length) return []
    if (value == null) {
      return [{ path, value: null, op: 'delete' }]
    }
    return [{ path, value, op: 'set' }]
  }

  if (op.shape === 'output_config') {
    const key = op.key ?? 'effort'
    if (value == null) {
      return [{ path: ['output_config', key], value: null, op: 'delete' }]
    }
    return [{ path: ['output_config', key], value, op: 'set' }]
  }

  return []
}

/**
 * 纯函数：dialect + 意图 → wire plan。
 */
export function resolveEffortWire(
  dialect: EffortDialect,
  level: string | null | undefined,
  ctx?: EffortResolveContext,
): EffortResolveResult {
  const dialectId = dialect.id
  let intent = (level ?? 'auto').toLowerCase().trim() || 'auto'

  if (dialect.aliases?.[intent]) {
    intent = dialect.aliases[intent]!.toLowerCase().trim()
  }

  let resolvedWire: string | null

  if (intent === 'auto') {
    if (ctx?.isAgent && dialect.agentDefault != null) {
      resolvedWire = dialect.agentDefault
    } else if (dialect.default !== undefined) {
      resolvedWire = dialect.default
    } else {
      resolvedWire = null
    }
  } else if (Object.prototype.hasOwnProperty.call(dialect.map, intent)) {
    resolvedWire = dialect.map[intent] ?? null
  } else {
    const missing = dialect.missing ?? 'reject'
    if (
      missing === 'passthrough' &&
      (dialect.levels.includes(intent) || dialect.levels.length === 0)
    ) {
      resolvedWire = intent
    } else if (missing === 'passthrough' && dialect.levels.length > 0) {
      // levels 非空且不在列表：reject 更安全
      return {
        ok: false,
        reason: `effort "${intent}" not in dialect levels [${dialect.levels.join(', ')}]`,
        intent,
        dialectId,
      }
    } else {
      return {
        ok: false,
        reason: `effort "${intent}" not mapped in dialect ${dialectId ?? '(custom)'} (levels: ${dialect.levels.join(', ') || 'any'})`,
        intent,
        dialectId,
      }
    }
  }

  const patches: EffortWirePlan['patches'] = []
  if (resolvedWire == null) {
    for (const op of dialect.onNone ?? []) {
      patches.push(...opToPatches(op, null))
    }
  } else {
    for (const op of dialect.wire) {
      patches.push(...opToPatches(op, resolvedWire))
    }
  }

  const useScale =
    dialect.applyTokenScale === true ||
    (dialect.applyTokenScale !== false && dialect.id === 'max-tokens')

  let maxTokens: number | undefined
  if (useScale) {
    const scaleKey =
      intent === 'auto'
        ? 'auto'
        : resolvedWire &&
            ['low', 'medium', 'high', 'max'].includes(resolvedWire)
          ? resolvedWire
          : intent
    maxTokens = mapEffort(
      scaleKey,
      ctx?.baseMaxTokens ?? DEFAULT_EFFORT_BASE_MAX_TOKENS,
    ).maxTokens
  }

  const display =
    intent === 'auto' && resolvedWire == null
      ? 'auto (omit field)'
      : intent === 'auto'
        ? `auto → ${resolvedWire}`
        : resolvedWire == null
          ? `${intent} → (none)`
          : intent === resolvedWire
            ? intent
            : `${intent} → ${resolvedWire}`

  return {
    ok: true,
    intent,
    resolvedWire,
    display,
    patches,
    ...(maxTokens != null ? { maxTokens } : {}),
    dialectId,
    ...(resolvedWire != null && dialect.requestHeaders
      ? { requestHeaders: { ...dialect.requestHeaders } }
      : {}),
    ...(dialect.notes ? { notes: dialect.notes } : {}),
  }
}

/** 将 plan.patches 打进请求体（就地修改并返回） */
export function applyBodyPatches<T extends Record<string, unknown>>(
  body: T,
  patches: EffortWirePlan['patches'],
): T {
  for (const p of patches) {
    if (p.op === 'delete') {
      deleteAtPath(body, p.path)
      continue
    }
    setAtPath(body, p.path, p.value)
  }
  return body
}

/**
 * 合并 requestHeaders 进 headers 对象（anthropic-beta 逗号去重合并）。
 */
export function mergeEffortRequestHeaders(
  headers: Record<string, string>,
  extra?: Record<string, string> | null,
): Record<string, string> {
  if (!extra) return headers
  const out = { ...headers }
  for (const [k, v] of Object.entries(extra)) {
    if (!v?.trim()) continue
    const key = k.toLowerCase() === 'anthropic-beta' ? 'anthropic-beta' : k
    const prev = out[key] ?? out[k]
    if (key === 'anthropic-beta' && prev) {
      const parts = new Set(
        [...prev.split(','), ...v.split(',')]
          .map((s) => s.trim())
          .filter(Boolean),
      )
      out[key] = [...parts].join(',')
      if (k !== key) delete out[k]
    } else {
      out[key] = v.trim()
    }
  }
  return out
}

function setAtPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
) {
  if (!path.length) return
  let cur: Record<string, unknown> = root
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!
    const next = cur[k]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[k] = {}
    }
    cur = cur[k] as Record<string, unknown>
  }
  cur[path[path.length - 1]!] = value
}

function deleteAtPath(root: Record<string, unknown>, path: string[]) {
  if (!path.length) return
  if (path.length === 1) {
    delete root[path[0]!]
    return
  }
  let cur: unknown = root
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return
    cur = (cur as Record<string, unknown>)[path[i]!]
  }
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    delete (cur as Record<string, unknown>)[path[path.length - 1]!]
  }
}

/**
 * 一次解析并打补丁；失败返回 reason（调用方可忽略 patch 仅用 maxTokens）。
 */
export function applyEffortToRequestBody(
  body: Record<string, unknown>,
  opts: {
    dialect?: string | EffortDialect | null
    effort?: string | null
    isAgent?: boolean
    model?: string
    baseMaxTokens?: number
    /** 已算好的 max_tokens；若 plan 带 maxTokens 且此项未强制则可覆盖 */
    maxTokensKey?: 'max_tokens' | 'max_output_tokens'
  },
): {
  ok: boolean
  reason?: string
  plan?: EffortWirePlan
  body: Record<string, unknown>
} {
  const dialect = resolveEffortDialect(opts.dialect)
  const plan = resolveEffortWire(dialect, opts.effort, {
    isAgent: opts.isAgent,
    model: opts.model,
    baseMaxTokens: opts.baseMaxTokens,
  })
  if (!plan.ok) {
    return { ok: false, reason: plan.reason, body }
  }
  applyBodyPatches(body, plan.patches)
  if (plan.maxTokens != null && opts.maxTokensKey) {
    // 仅当 body 已有该键或方言要求 token scale 时写入
    if (body[opts.maxTokensKey] != null || dialect.applyTokenScale) {
      body[opts.maxTokensKey] = plan.maxTokens
    }
  }
  return { ok: true, plan, body }
}

/** 格式化 /effort 无参展示 */
export function formatEffortStatusLine(opts: {
  effortLevel?: string | null
  dialect?: string | EffortDialect | null
  isAgent?: boolean
  model?: string
}): string {
  const dialect = resolveEffortDialect(opts.dialect)
  const level = opts.effortLevel?.trim() || 'auto'
  const plan = resolveEffortWire(dialect, level, {
    isAgent: opts.isAgent ?? true,
    model: opts.model,
  })
  const lines = [
    `effort: ${level}`,
    `dialect: ${dialect.id ?? '(custom)'}`,
  ]
  if (plan.ok) {
    lines.push(`wire: ${plan.display}`)
    if (plan.resolvedWire != null) {
      lines.push(`api value: ${plan.resolvedWire}`)
    } else {
      lines.push('api value: (omit)')
    }
    if (plan.maxTokens != null) {
      lines.push(`max_tokens scale: ${plan.maxTokens}`)
    }
  } else {
    lines.push(`wire: error — ${plan.reason}`)
  }
  if (dialect.levels.length) {
    lines.push(`dialect levels: ${dialect.levels.join(', ')}`)
  }
  if (dialect.notes) lines.push(`note: ${dialect.notes}`)
  return lines.join('\n')
}