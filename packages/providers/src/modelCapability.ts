/**
 * CX2：按模型轻表裁 effort 可选档（与 dialect choosable 求交）。
 * 见 docs/PROVIDER_UX.md — 稳健优先，不接全量 catalog。
 */

export type ModelCapRule = {
  /** 小写子串匹配 model id */
  match: string
  /** 有则与 choosable 求交（仍含 auto 逻辑由调用方保证） */
  effortAllow?: string[]
  effortDeny?: string[]
  /**
   * 显式覆盖 anthropic-style max 是否允许。
   * undefined = 不干预（仍走 anthropicMaxAllowed）。
   */
  maxAllowed?: boolean
  notes?: string
}

/** 内置少而准（子串，小写比） */
export const BUILTIN_MODEL_CAPS: readonly ModelCapRule[] = [
  {
    match: 'opus-4-6',
    maxAllowed: true,
    notes: 'Opus 4.6+ max effort',
  },
  {
    match: 'opus-4.6',
    maxAllowed: true,
  },
  {
    match: 'opus-4-7',
    maxAllowed: true,
  },
  {
    match: 'opus-4.7',
    maxAllowed: true,
  },
  {
    match: 'sonnet',
    maxAllowed: false,
    effortDeny: ['max', 'xhigh', 'ultra'],
    notes: 'Sonnet: no max',
  },
  {
    match: 'haiku',
    maxAllowed: false,
    effortDeny: ['max', 'xhigh', 'ultra'],
  },
  {
    match: 'gpt-4o',
    effortDeny: ['xhigh', 'ultra'],
    notes: 'gpt-4o family: no xhigh',
  },
  {
    match: 'gpt-4-turbo',
    effortDeny: ['xhigh', 'ultra', 'max'],
  },
  {
    match: 'gpt-3.5',
    effortDeny: ['xhigh', 'ultra', 'max', 'high'],
    effortAllow: ['auto', 'none', 'minimal', 'low', 'medium'],
  },
] as const

function normList(xs?: string[]): string[] | undefined {
  if (!xs?.length) return undefined
  return xs.map((x) => x.toLowerCase().trim()).filter(Boolean)
}

/** 合并规则：后写覆盖同 match 的字段（浅） */
export function mergeModelCapRules(
  ...layers: Array<ModelCapRule[] | undefined | null>
): ModelCapRule[] {
  const byMatch = new Map<string, ModelCapRule>()
  for (const layer of layers) {
    if (!layer) continue
    for (const r of layer) {
      const m = r.match?.toLowerCase().trim()
      if (!m) continue
      const prev = byMatch.get(m)
      byMatch.set(m, {
        match: m,
        effortAllow: normList(r.effortAllow) ?? prev?.effortAllow,
        effortDeny: normList(r.effortDeny) ?? prev?.effortDeny,
        maxAllowed: r.maxAllowed !== undefined ? r.maxAllowed : prev?.maxAllowed,
        notes: r.notes ?? prev?.notes,
      })
    }
  }
  return [...byMatch.values()]
}

/**
 * 收集命中 model 的规则（全部命中都应用：deny 并集、allow 交集、maxAllowed 任一 false 则 false）。
 */
export function matchingModelCapRules(
  model: string | null | undefined,
  rules: ModelCapRule[] = [...BUILTIN_MODEL_CAPS],
): ModelCapRule[] {
  const m = (model ?? '').toLowerCase().trim()
  if (!m || !rules.length) return []
  return rules.filter((r) => m.includes(r.match.toLowerCase()))
}

/**
 * 对已有 choosable 列表应用 model caps。
 * - effortDeny：剔除
 * - effortAllow：若存在，只保留 allow ∪ {auto}
 * - maxAllowed===false：剔除 max/xhigh/ultra
 */
export function filterChoosableByModelCaps(
  choosable: string[],
  model?: string | null,
  extraRules?: ModelCapRule[] | null,
): string[] {
  const rules = mergeModelCapRules(
    [...BUILTIN_MODEL_CAPS],
    extraRules ?? undefined,
  )
  const hit = matchingModelCapRules(model, rules)
  if (!hit.length) return choosable

  let out = [...choosable]
  const deny = new Set<string>()
  let allow: Set<string> | null = null
  let maxBlocked = false

  for (const r of hit) {
    for (const d of r.effortDeny ?? []) deny.add(d)
    if (r.effortAllow?.length) {
      const a = new Set(r.effortAllow.map((x) => x.toLowerCase()))
      a.add('auto')
      allow = allow
        ? new Set([...allow].filter((x) => a.has(x)))
        : a
    }
    if (r.maxAllowed === false) maxBlocked = true
  }

  if (maxBlocked) {
    deny.add('max')
    deny.add('xhigh')
    deny.add('ultra')
  }

  out = out.filter((c) => !deny.has(c.toLowerCase()))
  if (allow) {
    out = out.filter((c) => allow!.has(c.toLowerCase()))
  }

  // 保 auto
  if (!out.includes('auto') && choosable.includes('auto')) {
    out = ['auto', ...out]
  }
  return out
}

/**
 * 解析 maxAllowed：命中规则有显式 true/false 时优先；
 * 否则 undefined（调用方回落 anthropicMaxAllowed）。
 */
export function modelCapMaxAllowed(
  model?: string | null,
  extraRules?: ModelCapRule[] | null,
): boolean | undefined {
  const rules = mergeModelCapRules(
    [...BUILTIN_MODEL_CAPS],
    extraRules ?? undefined,
  )
  const hit = matchingModelCapRules(model, rules)
  if (!hit.length) return undefined
  // 任一 false → false；否则若有 true → true；全 undefined → undefined
  let sawTrue = false
  for (const r of hit) {
    if (r.maxAllowed === false) return false
    if (r.maxAllowed === true) sawTrue = true
  }
  return sawTrue ? true : undefined
}

/** 从未知 JSON 抽规则（config 用） */
export function parseModelCapRules(raw: unknown): ModelCapRule[] {
  if (!Array.isArray(raw)) return []
  const out: ModelCapRule[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const match = typeof o.match === 'string' ? o.match.trim() : ''
    if (!match) continue
    const effortAllow = Array.isArray(o.effortAllow)
      ? o.effortAllow.filter((x): x is string => typeof x === 'string')
      : undefined
    const effortDeny = Array.isArray(o.effortDeny)
      ? o.effortDeny.filter((x): x is string => typeof x === 'string')
      : undefined
    const maxAllowed =
      typeof o.maxAllowed === 'boolean' ? o.maxAllowed : undefined
    const notes = typeof o.notes === 'string' ? o.notes : undefined
    out.push({
      match,
      ...(effortAllow ? { effortAllow } : {}),
      ...(effortDeny ? { effortDeny } : {}),
      ...(maxAllowed !== undefined ? { maxAllowed } : {}),
      ...(notes ? { notes } : {}),
    })
  }
  return out
}