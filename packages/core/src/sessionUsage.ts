/**
 * 会话内本地 token usage 累计（对照 HC /cost 语义）。
 * 无遥测、不上报。
 */

export type SessionUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  /** 任一 call 用了 chars/4 估算时为 true */
  estimated?: boolean
}

export type UsageDelta = {
  inputTokens: number
  outputTokens: number
  /** 可选；缺省为 input+output */
  totalTokens?: number
  estimated?: boolean
}

export function createEmptySessionUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    calls: 0,
  }
}

/**
 * 字符粗算 token：默认 ≈chars/4（与 compact 正文启发式一致）。
 * 完整 messages 请用 packages/compact 的 estimateTokens（含 tool_calls / 密文）。
 */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0
  return Math.ceil(chars / 4)
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
  usage.inputTokens += input
  usage.outputTokens += output
  usage.totalTokens += total
  usage.calls += 1
  if (delta.estimated) usage.estimated = true
}

/**
 * 从 provider usage 字段归一化；全空则返回 null（调用方应走 estimate）。
 */
export function normalizeProviderUsage(u: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}): UsageDelta | null {
  const hasIn = u.inputTokens != null && Number.isFinite(u.inputTokens)
  const hasOut = u.outputTokens != null && Number.isFinite(u.outputTokens)
  const hasTotal = u.totalTokens != null && Number.isFinite(u.totalTokens)
  if (!hasIn && !hasOut && !hasTotal) return null

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

  return { inputTokens: input, outputTokens: output, totalTokens: total }
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

/** /cost · /usage 展示文案 */
export function formatSessionUsage(usage: SessionUsage | undefined): string {
  if (!usage || usage.calls === 0) {
    return [
      'Session usage (local only, no telemetry):',
      '  (none yet — no model calls this session)',
    ].join('\n')
  }
  const flag = usage.estimated ? '  note: some/all values estimated (chars/4)' : ''
  const lines = [
    'Session usage (local only, no telemetry):',
    `  calls:         ${usage.calls}`,
    `  inputTokens:   ${usage.inputTokens}`,
    `  outputTokens:  ${usage.outputTokens}`,
    `  totalTokens:   ${usage.totalTokens}`,
  ]
  if (flag) lines.push(flag)
  return lines.join('\n')
}

/** /context 附带的一行 */
export function formatUsageOneLiner(usage: SessionUsage | undefined): string {
  if (!usage || usage.calls === 0) {
    return 'usage:           (none)'
  }
  const est = usage.estimated ? ' est' : ''
  return `usage:           ${usage.totalTokens} tokens (${usage.calls} calls)${est}`
}