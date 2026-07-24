/**
 * 统一错误分类 — 对照 HelsincyCode withRetry / errors 语义（简化，无遥测）。
 *
 * - retryable：429 / 5xx / 超时 / 网络中断等，可有限退避重试
 * - user_abort：用户 AbortSignal（不重试）
 * - fatal：鉴权、参数错误、PTL 等（不重试；PTL 由 queryLoop 专用路径处理）
 */

export type ErrorClass = 'retryable' | 'fatal' | 'user_abort'

export type ClassifiedError = {
  class: ErrorClass
  message: string
  status?: number
  /** 简短原因标签，便于日志 */
  reason: string
}

export type ClassifyErrorOptions = {
  /** 若已 abort，优先归为 user_abort */
  signal?: AbortSignal
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

/** 从 Error / 字符串 / 带 status 的对象提取可读 message */
export function errorMessageOf(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (input instanceof Error) return input.message || input.name || String(input)
  if (typeof input === 'object') {
    const o = input as { message?: unknown; error?: unknown }
    if (typeof o.message === 'string') return o.message
    if (typeof o.error === 'string') return o.error
  }
  return String(input)
}

/** 从 message / 字段解析 HTTP status */
export function extractHttpStatus(
  input: unknown,
  message?: string,
): number | undefined {
  if (input && typeof input === 'object') {
    const o = input as { status?: unknown; statusCode?: unknown }
    if (typeof o.status === 'number' && o.status > 0) return o.status
    if (typeof o.statusCode === 'number' && o.statusCode > 0) return o.statusCode
  }
  const msg = message ?? errorMessageOf(input)
  // "HTTP 429", "HTTP 503:", "status 502"
  const m =
    msg.match(/\bHTTP\s+(\d{3})\b/i) ||
    msg.match(/\bstatus(?:Code)?[:\s]+(\d{3})\b/i) ||
    msg.match(/\b(\d{3})\s+(?:Too Many Requests|Service Unavailable|Bad Gateway|Gateway Timeout|Internal Server Error)\b/i)
  if (m) {
    const n = Number(m[1])
    if (n >= 100 && n <= 599) return n
  }
  // bare "429 " prefix (SDK style)
  const bare = msg.match(/^(\d{3})\s+/)
  if (bare) {
    const n = Number(bare[1])
    if (n >= 400 && n <= 599) return n
  }
  return undefined
}

function isUserAbort(
  input: unknown,
  message: string,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return true
  if (input && typeof input === 'object') {
    const name = (input as { name?: string }).name
    if (name === 'AbortError' || name === 'APIUserAbortError') {
      // 超时 abort 常也是 AbortError；仅当 message 不像 timeout 时当作用户取消
      if (!/timeout|timed?\s*out/i.test(message)) return true
    }
  }
  if (/user\s*abort|aborted by user|The user aborted|signal is aborted/i.test(message)) {
    return true
  }
  // DOMException abort without timeout wording
  if (
    input instanceof Error &&
    input.name === 'AbortError' &&
    !/timeout|timed?\s*out/i.test(message)
  ) {
    return true
  }
  return false
}

function looksLikeTimeout(message: string, name?: string): boolean {
  if (name === 'TimeoutError') return true
  return (
    /timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError/i.test(message)
  )
}

function looksLikeNetwork(message: string, name?: string): boolean {
  if (name === 'FetchError' || name === 'NetworkError') return true
  return (
    /ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|fetch failed|Failed to fetch|connection (reset|refused|error)|UND_ERR_/i.test(
      message,
    )
  )
}

function looksLikeRateLimit(message: string): boolean {
  return (
    /rate\s*limit|too many requests|overloaded|overloaded_error|capacity|529/i.test(
      message,
    )
  )
}

/**
 * 将任意错误 / provider stream error message 分为 retryable | fatal | user_abort。
 * PTL（上下文过长）归 fatal，由 queryLoop 的 truncate 路径处理，不走退避重试。
 */
export function classifyError(
  input: unknown,
  opts?: ClassifyErrorOptions,
): ClassifiedError {
  const message = errorMessageOf(input)
  const status = extractHttpStatus(input, message)
  const name =
    input instanceof Error
      ? input.name
      : input && typeof input === 'object'
        ? String((input as { name?: string }).name ?? '')
        : undefined

  if (isUserAbort(input, message, opts?.signal)) {
    return {
      class: 'user_abort',
      message: message || 'aborted',
      status,
      reason: 'user_abort',
    }
  }

  // PTL：不作为 HTTP 退避重试（queryLoop 专用）
  if (looksLikePromptTooLong(message, status)) {
    return {
      class: 'fatal',
      message,
      status,
      reason: 'prompt_too_long',
    }
  }

  if (status !== undefined && RETRYABLE_STATUS.has(status)) {
    return {
      class: 'retryable',
      message,
      status,
      reason: status === 429 ? 'rate_limit' : `http_${status}`,
    }
  }

  if (status !== undefined && status >= 500 && status <= 599) {
    return {
      class: 'retryable',
      message,
      status,
      reason: `http_${status}`,
    }
  }

  // 鉴权 / 客户端错误：不重试
  if (status === 401 || status === 403 || status === 404) {
    return {
      class: 'fatal',
      message,
      status,
      reason: `http_${status}`,
    }
  }
  if (status === 400 || status === 422) {
    return {
      class: 'fatal',
      message,
      status,
      reason: `http_${status}`,
    }
  }

  if (looksLikeRateLimit(message)) {
    return {
      class: 'retryable',
      message,
      status: status ?? 429,
      reason: 'rate_limit',
    }
  }

  if (looksLikeTimeout(message, name)) {
    return {
      class: 'retryable',
      message,
      status,
      reason: 'timeout',
    }
  }

  if (looksLikeNetwork(message, name)) {
    return {
      class: 'retryable',
      message,
      status,
      reason: 'network',
    }
  }

  return {
    class: 'fatal',
    message: message || 'unknown error',
    status,
    reason: 'fatal',
  }
}

function looksLikePromptTooLong(
  message: string,
  status?: number,
): boolean {
  if (status === 413) return true
  return (
    /prompt\s*is\s*too\s*long|context_length_exceeded|maximum context length|context window|too many tokens|token.?limit|request too large|payload too large/i.test(
      message,
    )
  )
}

/** 是否应在 callModel 层做有限退避重试 */
export function isRetryableError(
  input: unknown,
  opts?: ClassifyErrorOptions,
): boolean {
  return classifyError(input, opts).class === 'retryable'
}