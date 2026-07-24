/**
 * 会话内本地 token usage 累计（对照参考实现 /cost 语义）。
 * 无遥测、不上报；可选 USD 仅本地粗算、不强制。
 */

export type ModelUsageBucket = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  estimated?: boolean
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
      by[k] = nb
    }
    out.byModel = by
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
  }
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
    // 仅 total：全部记入 input（无法拆分）
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

/** /cost · /usage 展示文案（含 cache + by-model breakdown） */
export function formatSessionUsage(usage: SessionUsage | undefined): string {
  if (!usage || usage.calls === 0) {
    return [
      'Session usage (local only, no telemetry):',
      '  (none yet — no model calls this session)',
    ].join('\n')
  }
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheCreate = usage.cacheCreationInputTokens ?? 0
  const lines = [
    'Session usage (local only, no telemetry):',
    `  calls:         ${usage.calls}`,
    `  inputTokens:   ${formatNum(usage.inputTokens)}`,
    `  outputTokens:  ${formatNum(usage.outputTokens)}`,
    `  totalTokens:   ${formatNum(usage.totalTokens)}`,
    `  cacheRead:     ${formatNum(cacheRead)}`,
    `  cacheWrite:    ${formatNum(cacheCreate)}`,
  ]
  if (usage.estimated) {
    lines.push('  note: some/all values estimated (chars/4)')
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
      lines.push(
        `    ${name}: ${formatNum(b.inputTokens)} in / ${formatNum(b.outputTokens)} out / ${formatNum(b.totalTokens)} total` +
          ` (${b.calls} calls; cache r/w ${formatNum(cr)}/${formatNum(cw)})${est}`,
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
  const cachePart =
    cr > 0 || cw > 0 ? ` cache r/w ${cr}/${cw}` : ''
  return `usage:           ${usage.totalTokens} tokens (${usage.calls} calls)${cachePart}${est}`
}