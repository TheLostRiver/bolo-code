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
  /**
   * E6：显式 UI/校验可选意图；缺省从 map keys 推导。
   * 不含 auto（auto 始终可选）。
   */
  choosable?: string[]
  /**
   * E6：永不展示/不可选的意图（即使 map 能 fold）。
   */
  hide?: string[]
  notes?: string
}

export type EffortResolveContext = {
  /** 主 agent loop / 带 tools 的 completion */
  isAgent?: boolean
  model?: string
  baseMaxTokens?: number
}

/** E6：当前方言+模型下的可选档视图 */
export type EffortCapabilityView = {
  dialectId?: string
  /** UI / 校验允许（含 auto） */
  choosable: string[]
  /** 方言原生 wire levels */
  wireLevels: string[]
  preview: {
    intent: string
    display: string
    resolvedWire: string | null
  }
  warnings: string[]
  gates?: {
    maxAllowed?: boolean
    notes?: string
  }
  loose?: boolean
  notes?: string
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
  /** UI/校验只推原生档；fold 别名走 BOLO_EFFORT_LOOSE */
  choosable: ['low', 'medium', 'high', 'max'],
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
  /** strict：只推 wire 真值；low/medium 等 fold 需 BOLO_EFFORT_LOOSE=1 */
  choosable: ['high', 'max'],
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
  choosable: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
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
  /** max 仍受 model gate；xhigh/ultra fold 需 loose */
  choosable: ['low', 'medium', 'high', 'max'],
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
    ...(d.choosable ? { choosable: [...d.choosable] } : {}),
    ...(d.hide ? { hide: [...d.hide] } : {}),
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
    choosable: raw.choosable ?? base.choosable,
    hide: raw.hide ?? base.hide,
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
  if (kind === 'mock') return 'max-tokens'
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
  return formatEffortCapabilityStatus(opts)
}

// ── E6/E7：能力视图 · choosable · Anthropic max 门控 ──

function envTruthy(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** BOLO_EFFORT_LOOSE=1 → 任意能 resolve 的 canonical 都可设（旧 fold 行为） */
export function isEffortLooseMode(): boolean {
  return envTruthy('BOLO_EFFORT_LOOSE')
}

/**
 * Anthropic max 是否允许（对照 HC modelSupportsMaxEffort，缩小版）。
 * BOLO_EFFORT_ALLOW_MAX=1 强制放开。
 */
export function anthropicMaxAllowed(model?: string | null): boolean {
  if (envTruthy('BOLO_EFFORT_ALLOW_MAX')) return true
  const m = (model ?? '').toLowerCase()
  if (!m) return false
  // Opus 4.6+ 公网常支持 max；可 env 扩展
  return /opus-4-6|opus-4\.6|opus-4-7|opus-4\.7|opus-4-8|opus-4\.8/.test(m)
}

function intentResolvesToMax(
  dialect: EffortDialect,
  intent: string,
  ctx?: EffortResolveContext,
): boolean {
  const plan = resolveEffortWire(dialect, intent, ctx)
  return plan.ok && plan.resolvedWire === 'max'
}

/**
 * 当前方言下用户可选意图（含 auto）。
 * strict：map 有键、不在 hide、能 resolve，且过 model gate。
 * loose：canonical 中能 resolve 的都可。
 */
export function listEffortChoosable(
  dialectInput?: string | EffortDialect | null,
  ctx?: EffortResolveContext,
): string[] {
  const dialect = resolveEffortDialect(dialectInput)
  const loose = isEffortLooseMode()
  const hide = new Set(
    (dialect.hide ?? []).map((h) => h.toLowerCase().trim()).filter(Boolean),
  )

  let candidates: string[]
  if (loose) {
    candidates = [...CANONICAL_EFFORT_LEVELS]
  } else if (dialect.choosable?.length) {
    candidates = [
      'auto',
      ...dialect.choosable.map((c) => c.toLowerCase().trim()).filter(Boolean),
    ]
  } else {
    // 默认：map 的 key（用户意图）∪ wire levels（可直接设原生档）
    const keys = new Set<string>(['auto'])
    for (const k of Object.keys(dialect.map)) {
      keys.add(k.toLowerCase())
    }
    for (const lv of dialect.levels) {
      keys.add(lv.toLowerCase())
    }
    // 不默认塞满整个 canonical（避免 DS 上出现 low 当「推荐档」）
    candidates = [...keys]
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of candidates) {
    const intent = raw.toLowerCase().trim()
    if (!intent || seen.has(intent)) continue
    if (intent !== 'auto' && hide.has(intent)) continue

    if (intent === 'auto') {
      seen.add('auto')
      out.push('auto')
      continue
    }

    const plan = resolveEffortWire(dialect, intent, {
      isAgent: ctx?.isAgent ?? true,
      model: ctx?.model,
      baseMaxTokens: ctx?.baseMaxTokens,
    })
    if (!plan.ok) continue

    // E7：anthropic max 门控
    if (
      (dialect.id === 'anthropic-output' || dialect.id === 'anthropic') &&
      intentResolvesToMax(dialect, intent, ctx) &&
      !anthropicMaxAllowed(ctx?.model)
    ) {
      continue
    }

    // strict：意图应在 map 或等于 wire levels（原生档）
    if (!loose) {
      const inMap = Object.prototype.hasOwnProperty.call(dialect.map, intent)
      const inLevels = dialect.levels.map((l) => l.toLowerCase()).includes(intent)
      if (!inMap && !inLevels) continue
    }

    seen.add(intent)
    out.push(intent)
  }

  // 稳定顺序：auto 先，再按 canonical 序，其余按字母
  const rank = new Map(
    CANONICAL_EFFORT_LEVELS.map((c, i) => [c, i] as const),
  )
  out.sort((a, b) => {
    if (a === 'auto') return -1
    if (b === 'auto') return 1
    const ra = rank.get(a as CanonicalEffortLevel)
    const rb = rank.get(b as CanonicalEffortLevel)
    if (ra != null && rb != null) return ra - rb
    if (ra != null) return -1
    if (rb != null) return 1
    return a.localeCompare(b)
  })
  return out
}

export function describeEffortCapability(opts: {
  effortLevel?: string | null
  dialect?: string | EffortDialect | null
  isAgent?: boolean
  model?: string
  baseMaxTokens?: number
}): EffortCapabilityView {
  const dialect = resolveEffortDialect(opts.dialect)
  const ctx: EffortResolveContext = {
    isAgent: opts.isAgent ?? true,
    model: opts.model,
    baseMaxTokens: opts.baseMaxTokens,
  }
  const level = opts.effortLevel?.trim() || 'auto'
  const plan = resolveEffortWire(dialect, level, ctx)
  const choosable = listEffortChoosable(dialect, ctx)
  const warnings: string[] = []
  const loose = isEffortLooseMode()

  if (loose) {
    warnings.push('BOLO_EFFORT_LOOSE=1: accepting foldable intents beyond choosable')
  }

  const maxOk = anthropicMaxAllowed(opts.model)
  if (dialect.id === 'anthropic-output' || dialect.id === 'anthropic') {
    if (!maxOk) {
      warnings.push(
        'max/xhigh/ultra not choosable for this model (need opus-4.6+ or BOLO_EFFORT_ALLOW_MAX=1)',
      )
    }
  }

  if (plan.ok && plan.intent !== 'auto' && plan.resolvedWire && plan.intent !== plan.resolvedWire) {
    warnings.push(`folds to wire "${plan.resolvedWire}"`)
  }

  if (!plan.ok) {
    warnings.push(plan.reason)
  }

  return {
    dialectId: dialect.id,
    choosable,
    wireLevels: [...dialect.levels],
    preview: {
      intent: level,
      display: plan.ok ? plan.display : `error: ${plan.reason}`,
      resolvedWire: plan.ok ? plan.resolvedWire : null,
    },
    warnings,
    gates: {
      maxAllowed:
        dialect.id === 'anthropic-output' || dialect.id === 'anthropic'
          ? maxOk
          : undefined,
      notes:
        dialect.id === 'anthropic-output'
          ? 'Anthropic max gated by model id; thinking is separate (/thinking · anthropicThinking)'
          : undefined,
    },
    loose,
    ...(dialect.notes ? { notes: dialect.notes } : {}),
  }
}

/**
 * 校验意图是否可设。
 * auto 始终 ok；strict 下须 ∈ choosable；loose 下须 resolve 成功且过 gate。
 */
export function assertEffortChoosable(
  dialectInput: string | EffortDialect | null | undefined,
  level: string,
  ctx?: EffortResolveContext,
): { ok: true; intent: string } | { ok: false; reason: string } {
  const intent = level.trim().toLowerCase() || 'auto'
  if (intent === 'auto') return { ok: true, intent: 'auto' }

  const dialect = resolveEffortDialect(dialectInput)
  const choosable = listEffortChoosable(dialect, ctx)
  const loose = isEffortLooseMode()

  if (!loose && !choosable.includes(intent)) {
    return {
      ok: false,
      reason:
        `effort "${intent}" not available for dialect ${dialect.id ?? '(custom)'}. ` +
        `Choosable: ${choosable.join(', ')}. ` +
        `(Set BOLO_EFFORT_LOOSE=1 to allow foldable aliases.)`,
    }
  }

  const plan = resolveEffortWire(dialect, intent, {
    isAgent: ctx?.isAgent ?? true,
    model: ctx?.model,
    baseMaxTokens: ctx?.baseMaxTokens,
  })
  if (!plan.ok) {
    return { ok: false, reason: plan.reason }
  }

  if (
    (dialect.id === 'anthropic-output' || dialect.id === 'anthropic') &&
    plan.resolvedWire === 'max' &&
    !anthropicMaxAllowed(ctx?.model)
  ) {
    return {
      ok: false,
      reason:
        `effort "${intent}" → max is not allowed for model "${ctx?.model ?? ''}". ` +
        `Use high, or set BOLO_EFFORT_ALLOW_MAX=1, or switch to opus-4.6+.`,
    }
  }

  return { ok: true, intent }
}

/** /effort 无参 · doctor：能力视图文案 */
export function formatEffortCapabilityStatus(opts: {
  effortLevel?: string | null
  dialect?: string | EffortDialect | null
  isAgent?: boolean
  model?: string
}): string {
  const view = describeEffortCapability(opts)
  const lines = [
    `effort: ${opts.effortLevel?.trim() || 'auto'}`,
    `dialect: ${view.dialectId ?? '(custom)'}`,
    `wire: ${view.preview.display}`,
    view.preview.resolvedWire != null
      ? `api value: ${view.preview.resolvedWire}`
      : 'api value: (omit)',
    `choosable: ${view.choosable.join(', ')}`,
  ]
  if (view.wireLevels.length) {
    lines.push(`wire levels: ${view.wireLevels.join(', ')}`)
  }
  if (view.gates?.maxAllowed === false) {
    lines.push('gate: anthropic max blocked for this model')
  } else if (view.gates?.maxAllowed === true) {
    lines.push('gate: anthropic max allowed')
  }
  if (view.warnings.length) {
    for (const w of view.warnings) lines.push(`warning: ${w}`)
  }
  if (view.notes) lines.push(`note: ${view.notes}`)
  lines.push(
    'tip: /effort does not enable Anthropic thinking blocks (use anthropicThinking / separate config)',
  )
  return lines.join('\n')
}

/** TTY picker 条目 */
export function buildEffortPickerItems(opts: {
  dialect?: string | EffortDialect | null
  model?: string
  isAgent?: boolean
  effortLevel?: string | null
}): Array<{ id: string; label: string }> {
  const dialect = resolveEffortDialect(opts.dialect)
  const ctx: EffortResolveContext = {
    isAgent: opts.isAgent ?? true,
    model: opts.model,
  }
  const choosable = listEffortChoosable(dialect, ctx)
  return choosable.map((id) => {
    const plan = resolveEffortWire(dialect, id, ctx)
    const wire =
      plan.ok && plan.resolvedWire != null && plan.resolvedWire !== id
        ? ` → ${plan.resolvedWire}`
        : plan.ok && plan.resolvedWire == null && id === 'auto'
          ? ' (omit / default)'
          : ''
    const mark =
      (opts.effortLevel?.trim() || 'auto').toLowerCase() === id ? '*' : ' '
    return {
      id,
      label: `${mark} ${id}${wire}`,
    }
  })
}

export function activeEffortPickerIndex(opts: {
  dialect?: string | EffortDialect | null
  model?: string
  isAgent?: boolean
  effortLevel?: string | null
}): number {
  const items = buildEffortPickerItems(opts)
  const cur = (opts.effortLevel?.trim() || 'auto').toLowerCase()
  const i = items.findIndex((it) => it.id === cur)
  return i >= 0 ? i : 0
}