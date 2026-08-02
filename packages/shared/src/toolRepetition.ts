/**
 * ROB-1: 工具调用重复检测（stationarity guard）纯契约。
 *
 * 目标：模型对同一工具以相同参数连续重复调用（轮询式死循环、卡在同一修复
 * 步骤）时，本地计数并在阈值处提醒/中止，避免 token 空转。
 *
 * 语义：
 * - 以「轮」为单位（一次 provider 响应的 tool_calls 批）。连续两轮的工具调用
 *   指纹序列完全相同则计数 +1；序列变化或本轮无工具调用则重置。
 * - 达到 warn 阈值提醒换策略；达到 abort 阈值硬停（由 core 执行）。
 * - 指纹 = 工具名 + 参数稳定哈希（参数 JSON 键排序后哈希；无法解析时用原文）。
 * - 纯函数、无副作用；状态由调用方持有。
 */
export const TOOL_REPETITION_WARN_THRESHOLD = 8
export const TOOL_REPETITION_ABORT_THRESHOLD = 16

export type ToolCallFingerprint = {
  name: string
  argsHash: string
}

export type ToolRepetitionState = {
  /** 当前连续相同调用序列的轮次数（0 = 无连续重复） */
  count: number
  /** 上一轮的调用指纹序列；空 = 上一轮无工具调用 */
  lastCalls: readonly ToolCallFingerprint[]
}

function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** 参数 JSON 键排序规范化，保证语义相同的参数得到同一指纹。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`)
  }
  return `{${parts.join(',')}}`
}

export function fingerprintToolCall(
  name: string,
  argumentsJson?: string,
): ToolCallFingerprint {
  let normalized = ''
  if (argumentsJson && argumentsJson.trim()) {
    try {
      normalized = stableStringify(JSON.parse(argumentsJson))
    } catch {
      normalized = argumentsJson
    }
  }
  return { name, argsHash: hashString(normalized) }
}

function sameSequence(
  a: readonly ToolCallFingerprint[],
  b: readonly ToolCallFingerprint[],
): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]!.name !== b[index]!.name) return false
    if (a[index]!.argsHash !== b[index]!.argsHash) return false
  }
  return true
}

export function createToolRepetitionState(): ToolRepetitionState {
  return { count: 0, lastCalls: [] }
}

/**
 * 用本轮的工具调用推进状态。返回新状态；调用方在下一轮开始时读取。
 */
export function advanceToolRepetition(
  state: ToolRepetitionState,
  calls: readonly { name: string; argumentsJson?: string }[],
): ToolRepetitionState {
  if (calls.length === 0) {
    return { count: 0, lastCalls: [] }
  }
  const fingerprints = calls.map((call) =>
    fingerprintToolCall(call.name, call.argumentsJson),
  )
  if (sameSequence(state.lastCalls, fingerprints)) {
    return { count: state.count + 1, lastCalls: fingerprints }
  }
  return { count: 1, lastCalls: fingerprints }
}

export type ToolRepetitionStage = 'none' | 'warn' | 'abort'

export function toolRepetitionStage(count: number): ToolRepetitionStage {
  if (count >= TOOL_REPETITION_ABORT_THRESHOLD) return 'abort'
  if (count >= TOOL_REPETITION_WARN_THRESHOLD) return 'warn'
  return 'none'
}

export function formatToolRepetitionReminder(
  count: number,
  fingerprint: ToolCallFingerprint | undefined,
): string {
  const detail = fingerprint
    ? `\n  ${fingerprint.name} (args ${fingerprint.argsHash})`
    : ''
  return (
    `[Tool repetition reminder]\n` +
    `You have called the same tool with identical arguments ${count} times ` +
    `in a row${detail}. If the previous attempts did not make progress, ` +
    `stop repeating and change strategy (read the error, adjust inputs, or ` +
    `try a different tool).`
  )
}
