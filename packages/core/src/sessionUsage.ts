/**
 * 会话内本地 token usage 累计（对照参考实现 /cost 语义）。
 * 无遥测、不上报；可选 USD 仅本地粗算、不强制。
 */

import { estimateUsdCost, formatUsd, formatDurationMs } from './modelCost.ts'

export type ModelUsageBucket = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  estimated?: boolean
  /** 本桶累计 API 墙钟 ms（本地） */
  apiDurationMs?: number
}

/** 最近一次 model call 快照（对照 HC last turn 可读性） */
export type LastCallUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  estimated?: boolean
  model?: string
  at: string
  /** 本 call API 墙钟 ms */
  apiDurationMs?: number
}

export type SessionUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  /** 任一 call 用了 chars/4 估算时为 true */
  estimated?: boolean
  /** API cache 命中（读）累计；无字段则 0 / 省略 */
  cacheReadInputTokens?: number
  /** API cache 写入累计 */
  cacheCreationInputTokens?: number
  /** 按 model 名分桶（session.model 或 "(unknown)"） */
  byModel?: Record<string, ModelUsageBucket>
  /** 最近一次 call（不参与 merge 累加语义；合并时取 child 的 last） */
  lastCall?: LastCallUsage
  /** 会话累计 callModel 墙钟 ms（本地；非厂商账单） */
  apiDurationMs?: number
}

export type UsageDelta = {
  inputTokens: number
  outputTokens: number
  /** 可选；缺省为 input+output */
  totalTokens?: number
  estimated?: boolean
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  /** 本轮使用的 model 标签；缺省不记 byModel */
  model?: string
  /** 本 call API 墙钟 ms */
  apiDurationMs?: number
}

export function createEmptySessionUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    calls: 0,
  }
}

/** 深拷贝 usage（快照 / createSession；兼容旧字段） */
export function cloneSessionUsage(
  usage: SessionUsage | undefined,
): SessionUsage | undefined {
  if (!usage) return undefined
  const out: SessionUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    calls: usage.calls,
  }
  if (usage.estimated) out.estimated = true
  if (usage.cacheReadInputTokens != null && usage.cacheReadInputTokens > 0) {
    out.cacheReadInputTokens = usage.cacheReadInputTokens
  }
  if (
    usage.cacheCreationInputTokens != null &&
    usage.cacheCreationInputTokens > 0
  ) {
    out.cacheCreationInputTokens = usage.cacheCreationInputTokens
  }
  if (usage.byModel && Object.keys(usage.byModel).length > 0) {
    const by: Record<string, ModelUsageBucket> = {}
    for (const [k, b] of Object.entries(usage.byModel)) {
      const nb: ModelUsageBucket = {
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        totalTokens: b.totalTokens,
        calls: b.calls,
      }
      if (b.estimated) nb.estimated = true
      if (b.cacheReadInputTokens != null && b.cacheReadInputTokens > 0) {
        nb.cacheReadInputTokens = b.cacheReadInputTokens
      }
      if (
        b.cacheCreationInputTokens != null &&
        b.cacheCreationInputTokens > 0
      ) {
        nb.cacheCreationInputTokens = b.cacheCreationInputTokens
      }
      if (b.apiDurationMs != null && b.apiDurationMs > 0) {
        nb.apiDurationMs = b.apiDurationMs
      }
      by[k] = nb
    }
    out.byModel = by
  }
  if (usage.lastCall) {
    out.lastCall = { ...usage.lastCall }
  }
  if (usage.apiDurationMs != null && usage.apiDurationMs > 0) {
    out.apiDurationMs = usage.apiDurationMs
  }
  return out
}

/**
 * 字符粗算 token：默认 ≈chars/4（与 compact 正文启发式一致）。
 * 完整 messages 请用 packages/compact 的 estimateTokens（含 tool_calls / 密文）。
 */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0
  return Math.ceil(chars / 4)
}

function modelKey(model: string | undefined): string | undefined {
  if (model == null) return undefined
  const t = model.trim()
  return t.length > 0 ? t : undefined
}

function ensureBucket(
  usage: SessionUsage,
  key: string,
): ModelUsageBucket {
  if (!usage.byModel) usage.byModel = {}
  let b = usage.byModel[key]
  if (!b) {
    b = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
    }
    usage.byModel[key] = b
  }
  return b
}

export function accumulateSessionUsage(
  usage: SessionUsage,
  delta: UsageDelta,
): void {
  const input = Math.max(0, Math.floor(delta.inputTokens) || 0)
  const output = Math.max(0, Math.floor(delta.outputTokens) || 0)
  const total =
    delta.totalTokens !== undefined
      ? Math.max(0, Math.floor(delta.totalTokens) || 0)
      : input + output
  const cacheRead =
    delta.cacheReadInputTokens !== undefined
      ? Math.max(0, Math.floor(delta.cacheReadInputTokens) || 0)
      : 0
  const cacheCreate =
    delta.cacheCreationInputTokens !== undefined
      ? Math.max(0, Math.floor(delta.cacheCreationInputTokens) || 0)
      : 0

  usage.inputTokens += input
  usage.outputTokens += output
  usage.totalTokens += total
  usage.calls += 1
  if (delta.estimated) usage.estimated = true
  if (cacheRead > 0) {
    usage.cacheReadInputTokens = (usage.cacheReadInputTokens ?? 0) + cacheRead
  }
  if (cacheCreate > 0) {
    usage.cacheCreationInputTokens =
      (usage.cacheCreationInputTokens ?? 0) + cacheCreate
  }

  const apiMs =
    delta.apiDurationMs !== undefined
      ? Math.max(0, Math.floor(delta.apiDurationMs) || 0)
      : 0
  if (apiMs > 0) {
    usage.apiDurationMs = (usage.apiDurationMs ?? 0) + apiMs
  }

  const key = modelKey(delta.model)
  if (key) {
    const b = ensureBucket(usage, key)
    b.inputTokens += input
    b.outputTokens += output
    b.totalTokens += total
    b.calls += 1
    if (delta.estimated) b.estimated = true
    if (cacheRead > 0) {
      b.cacheReadInputTokens = (b.cacheReadInputTokens ?? 0) + cacheRead
    }
    if (cacheCreate > 0) {
      b.cacheCreationInputTokens =
        (b.cacheCreationInputTokens ?? 0) + cacheCreate
    }
    if (apiMs > 0) {
      b.apiDurationMs = (b.apiDurationMs ?? 0) + apiMs
    }
  }

  const last: LastCallUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    at: new Date().toISOString(),
  }
  if (cacheRead > 0) last.cacheReadInputTokens = cacheRead
  if (cacheCreate > 0) last.cacheCreationInputTokens = cacheCreate
  if (delta.estimated) last.estimated = true
  if (key) last.model = key
  if (apiMs > 0) last.apiDurationMs = apiMs
  usage.lastCall = last
}

/**
 * 将子 agent usage 合并进父会话（对照 HC fork/subagent totalUsage 回卷）。
 * - 父 totals / cache 累加
 * - byModel 按子桶名合并
 * - lastCall：若 child 有则覆盖
 * - 不修改 child
 */
export function mergeSessionUsage(
  parent: SessionUsage,
  child: SessionUsage | undefined | null,
): void {
  if (!child || child.calls === 0) return

  parent.inputTokens += child.inputTokens
  parent.outputTokens += child.outputTokens
  parent.totalTokens += child.totalTokens
  parent.calls += child.calls
  if (child.estimated) parent.estimated = true

  const cr = child.cacheReadInputTokens ?? 0
  const cc = child.cacheCreationInputTokens ?? 0
  if (cr > 0) {
    parent.cacheReadInputTokens = (parent.cacheReadInputTokens ?? 0) + cr
  }
  if (cc > 0) {
    parent.cacheCreationInputTokens =
      (parent.cacheCreationInputTokens ?? 0) + cc
  }

  if (child.apiDurationMs != null && child.apiDurationMs > 0) {
    parent.apiDurationMs =
      (parent.apiDurationMs ?? 0) + child.apiDurationMs
  }

  if (child.byModel) {
    for (const [name, bucket] of Object.entries(child.byModel)) {
      const b = ensureBucket(parent, name)
      b.inputTokens += bucket.inputTokens
      b.outputTokens += bucket.outputTokens
      b.totalTokens += bucket.totalTokens
      b.calls += bucket.calls
      if (bucket.estimated) b.estimated = true
      const bcr = bucket.cacheReadInputTokens ?? 0
      const bcc = bucket.cacheCreationInputTokens ?? 0
      if (bcr > 0) {
        b.cacheReadInputTokens = (b.cacheReadInputTokens ?? 0) + bcr
      }
      if (bcc > 0) {
        b.cacheCreationInputTokens = (b.cacheCreationInputTokens ?? 0) + bcc
      }
      if (bucket.apiDurationMs != null && bucket.apiDurationMs > 0) {
        b.apiDurationMs = (b.apiDurationMs ?? 0) + bucket.apiDurationMs
      }
    }
  }

  if (child.lastCall) {
    parent.lastCall = { ...child.lastCall }
  }
}

/**
 * cache 命中率：cacheRead / (cacheRead + cacheCreate + 非缓存 input 粗估)
 * 无 cache 字段时返回 null。
 * 粗估非缓存 input ≈ max(0, inputTokens - cacheRead)（与多数 API 语义近似）。
 */
export function computeCacheHitRate(
  usage: SessionUsage | undefined | null,
): number | null {
  if (!usage || usage.calls === 0) return null
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheCreate = usage.cacheCreationInputTokens ?? 0
  if (cacheRead <= 0 && cacheCreate <= 0) return null
  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead)
  const denom = cacheRead + cacheCreate + uncachedInput
  if (denom <= 0) return null
  return cacheRead / denom
}

/** 0–100 百分比字符串，一位小数；null → null */
export function formatCacheHitRatePercent(
  usage: SessionUsage | undefined | null,
): string | null {
  const r = computeCacheHitRate(usage)
  if (r == null) return null
  return `${(r * 100).toFixed(1)}%`
}

/**
 * 从 provider usage 字段归一化；全空则返回 null（调用方应走 estimate）。
 */
export function normalizeProviderUsage(u: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}): UsageDelta | null {
  const hasIn = u.inputTokens != null && Number.isFinite(u.inputTokens)
  const hasOut = u.outputTokens != null && Number.isFinite(u.outputTokens)
  const hasTotal = u.totalTokens != null && Number.isFinite(u.totalTokens)
  const hasCacheRead =
    u.cacheReadInputTokens != null && Number.isFinite(u.cacheReadInputTokens)
  const hasCacheCreate =
    u.cacheCreationInputTokens != null &&
    Number.isFinite(u.cacheCreationInputTokens)
  if (!hasIn && !hasOut && !hasTotal && !hasCacheRead && !hasCacheCreate) {
    return null
  }

  let input = hasIn ? Math.max(0, Math.floor(u.inputTokens!)) : 0
  let output = hasOut ? Math.max(0, Math.floor(u.outputTokens!)) : 0
  let total = hasTotal ? Math.max(0, Math.floor(u.totalTokens!)) : input + output

  if (hasTotal && !hasIn && !hasOut) {
    input = total
    output = 0
  } else if (hasTotal && hasIn && !hasOut) {
    output = Math.max(0, total - input)
  } else if (hasTotal && !hasIn && hasOut) {
    input = Math.max(0, total - output)
  } else if (!hasTotal) {
    total = input + output
  }

  const out: UsageDelta = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
  }
  if (hasCacheRead) {
    out.cacheReadInputTokens = Math.max(
      0,
      Math.floor(u.cacheReadInputTokens!),
    )
  }
  if (hasCacheCreate) {
    out.cacheCreationInputTokens = Math.max(
      0,
      Math.floor(u.cacheCreationInputTokens!),
    )
  }
  return out
}

export function estimateUsageFromCharCounts(opts: {
  inputChars: number
  outputChars: number
}): UsageDelta {
  const inputTokens = estimateTokensFromChars(opts.inputChars)
  const outputTokens = estimateTokensFromChars(opts.outputChars)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  }
}

export function estimateUsageFromTexts(opts: {
  inputText: string
  outputText: string
}): UsageDelta {
  return estimateUsageFromCharCounts({
    inputChars: opts.inputText.length,
    outputChars: opts.outputText.length,
  })
}

export function messageChars(messages: readonly { content?: string }[]): number {
  let n = 0
  for (const m of messages) {
    n += (m.content ?? '').length
  }
  return n
}

function formatNum(n: number): string {
  return String(n)
}

/** 会话级本地 USD 粗算（byModel 分 tier 再加总） */
export function estimateSessionUsd(
  usage: SessionUsage | undefined | null,
): {
  usd: number
  knownAll: boolean
  cacheSavingsUsd: number
  byModel: Array<{
    model: string
    usd: number
    tier: string
    known: boolean
    cacheSavingsUsd: number
  }>
} {
  if (!usage || usage.calls === 0) {
    return { usd: 0, knownAll: true, cacheSavingsUsd: 0, byModel: [] }
  }
  const by = usage.byModel
  if (by && Object.keys(by).length > 0) {
    let total = 0
    let savings = 0
    let knownAll = true
    const rows: Array<{
      model: string
      usd: number
      tier: string
      known: boolean
      cacheSavingsUsd: number
    }> = []
    for (const name of Object.keys(by).sort()) {
      const b = by[name]!
      const r = estimateUsdCost(
        {
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          cacheReadInputTokens: b.cacheReadInputTokens,
          cacheCreationInputTokens: b.cacheCreationInputTokens,
          model: name,
        },
        name,
      )
      total += r.usd
      savings += r.cacheSavingsUsd
      if (!r.known) knownAll = false
      rows.push({
        model: name,
        usd: r.usd,
        tier: r.tier,
        known: r.known,
        cacheSavingsUsd: r.cacheSavingsUsd,
      })
    }
    return { usd: total, knownAll, cacheSavingsUsd: savings, byModel: rows }
  }
  const r = estimateUsdCost({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
  })
  return {
    usd: r.usd,
    knownAll: r.known,
    cacheSavingsUsd: r.cacheSavingsUsd,
    byModel: [],
  }
}

/** /cost · /usage 展示文案（含 cache + hit rate + last call + 本地 USD + API 时长） */
export function formatSessionUsage(
  usage: SessionUsage | undefined,
  opts?: {
    /** prompt-cache 会话观测一行（可选） */
    promptCacheLine?: string
  },
): string {
  if (!usage || usage.calls === 0) {
    const lines = [
      'Session usage (local only, no telemetry):',
      '  (none yet — no model calls this session)',
    ]
    if (opts?.promptCacheLine) lines.push(opts.promptCacheLine)
    return lines.join('\n')
  }
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheCreate = usage.cacheCreationInputTokens ?? 0
  const hitPct = formatCacheHitRatePercent(usage)
  const usdEst = estimateSessionUsd(usage)
  const lines = [
    'Session usage (local only, no telemetry):',
    `  calls:         ${usage.calls}`,
    `  inputTokens:   ${formatNum(usage.inputTokens)}`,
    `  outputTokens:  ${formatNum(usage.outputTokens)}`,
    `  totalTokens:   ${formatNum(usage.totalTokens)}`,
    `  cacheRead:     ${formatNum(cacheRead)}`,
    `  cacheWrite:    ${formatNum(cacheCreate)}`,
  ]
  if (hitPct != null) {
    lines.push(`  cacheHitRate:  ${hitPct}`)
  }
  lines.push(
    `  est. USD:      ${formatUsd(usdEst.usd)}${usdEst.knownAll ? '' : ' (mixed/default tiers)'}` +
      '  — heuristic, not a bill',
  )
  if (usdEst.cacheSavingsUsd > 0) {
    lines.push(
      `  cacheSaved:    ~${formatUsd(usdEst.cacheSavingsUsd)} vs full input pricing (est.)`,
    )
  }
  if (usage.apiDurationMs != null && usage.apiDurationMs > 0) {
    lines.push(`  API duration:  ${formatDurationMs(usage.apiDurationMs)} (wall, local)`)
  }
  if (usage.estimated) {
    lines.push('  note: some/all values estimated (chars/4)')
  }
  if (usage.lastCall) {
    const lc = usage.lastCall
    const lcr = lc.cacheReadInputTokens ?? 0
    const lcw = lc.cacheCreationInputTokens ?? 0
    const lm = lc.model ? ` model=${lc.model}` : ''
    const lest = lc.estimated ? ' est' : ''
    const ldur =
      lc.apiDurationMs != null && lc.apiDurationMs > 0
        ? ` · ${formatDurationMs(lc.apiDurationMs)}`
        : ''
    lines.push(
      `  last call:     ${formatNum(lc.inputTokens)} in / ${formatNum(lc.outputTokens)} out` +
        ` (cache r/w ${formatNum(lcr)}/${formatNum(lcw)})${lm}${lest}${ldur}`,
    )
  }
  if (opts?.promptCacheLine) {
    lines.push(opts.promptCacheLine)
  }
  const by = usage.byModel
  if (by && Object.keys(by).length > 0) {
    lines.push('  by model:')
    const names = Object.keys(by).sort()
    for (const name of names) {
      const b = by[name]!
      const cr = b.cacheReadInputTokens ?? 0
      const cw = b.cacheCreationInputTokens ?? 0
      const est = b.estimated ? ' est' : ''
      const bucketHit = formatCacheHitRatePercent({
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        totalTokens: b.totalTokens,
        calls: b.calls,
        cacheReadInputTokens: b.cacheReadInputTokens,
        cacheCreationInputTokens: b.cacheCreationInputTokens,
        estimated: b.estimated,
      })
      const hitPart = bucketHit != null ? `; hit ${bucketHit}` : ''
      const costPart = usdEst.byModel.find((x) => x.model === name)
      const usdPart = costPart
        ? `; ~${formatUsd(costPart.usd)} (${costPart.tier})`
        : ''
      const durPart =
        b.apiDurationMs != null && b.apiDurationMs > 0
          ? `; ${formatDurationMs(b.apiDurationMs)}`
          : ''
      lines.push(
        `    ${name}: ${formatNum(b.inputTokens)} in / ${formatNum(b.outputTokens)} out / ${formatNum(b.totalTokens)} total` +
          ` (${b.calls} calls; cache r/w ${formatNum(cr)}/${formatNum(cw)}${hitPart}${usdPart}${durPart})${est}`,
      )
    }
  }
  return lines.join('\n')
}

/** /context 附带的一行 */
export function formatUsageOneLiner(usage: SessionUsage | undefined): string {
  if (!usage || usage.calls === 0) {
    return 'usage:           (none)'
  }
  const est = usage.estimated ? ' est' : ''
  const cr = usage.cacheReadInputTokens ?? 0
  const cw = usage.cacheCreationInputTokens ?? 0
  const hitPct = formatCacheHitRatePercent(usage)
  const cachePart =
    cr > 0 || cw > 0
      ? ` cache r/w ${cr}/${cw}${hitPct != null ? ` hit ${hitPct}` : ''}`
      : ''
  const usd = estimateSessionUsd(usage)
  const usdPart = usd.usd > 0 ? ` ~${formatUsd(usd.usd)}` : ''
  const dur =
    usage.apiDurationMs != null && usage.apiDurationMs > 0
      ? ` · ${formatDurationMs(usage.apiDurationMs)}`
      : ''
  return `usage:           ${usage.totalTokens} tokens (${usage.calls} calls)${cachePart}${usdPart}${dur}${est}`
}