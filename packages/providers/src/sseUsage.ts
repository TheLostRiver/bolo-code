/**
 * 从 OpenAI / Anthropic SSE JSON 片段提取 usage（无网络）。
 * 无字段则返回 null，调用方回落 estimate。
 */

import type { ProviderUsage } from './types.ts'

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * OpenAI-compatible chat.completions stream chunk。
 * 常见于末包：`{ usage: { prompt_tokens, completion_tokens, total_tokens }, choices: [] }`
 * 需请求时带 `stream_options.include_usage`（本仓库在 stream 路径已加）。
 */
export function parseOpenAIStreamUsage(chunk: unknown): ProviderUsage | null {
  if (!chunk || typeof chunk !== 'object') return null
  const usage = (chunk as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const inputTokens = num(u.prompt_tokens) ?? num(u.input_tokens)
  const outputTokens = num(u.completion_tokens) ?? num(u.output_tokens)
  const totalTokens =
    num(u.total_tokens) ??
    (inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    return null
  }
  return { inputTokens, outputTokens, totalTokens }
}

/**
 * Anthropic Messages SSE 事件：
 * - message_start.message.usage（input_tokens 等）
 * - message_delta.usage（output_tokens 等）
 */
export function parseAnthropicStreamUsage(evt: unknown): ProviderUsage | null {
  if (!evt || typeof evt !== 'object') return null
  const e = evt as {
    type?: string
    message?: { usage?: Record<string, unknown> }
    usage?: Record<string, unknown>
  }
  let raw: Record<string, unknown> | undefined
  if (e.type === 'message_start' && e.message?.usage) {
    raw = e.message.usage
  } else if (
    (e.type === 'message_delta' || e.type === 'message_start') &&
    e.usage
  ) {
    raw = e.usage
  } else if (e.usage && !e.type) {
    raw = e.usage
  }
  if (!raw) return null

  const inputTokens = num(raw.input_tokens) ?? num(raw.prompt_tokens)
  const outputTokens = num(raw.output_tokens) ?? num(raw.completion_tokens)
  const totalTokens =
    num(raw.total_tokens) ??
    (inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    return null
  }
  return { inputTokens, outputTokens, totalTokens }
}

/** 合并多次 SSE usage（后写覆盖；Anthropic 常分 input / output 两包） */
export function mergeProviderUsage(
  a: ProviderUsage | null | undefined,
  b: ProviderUsage | null | undefined,
): ProviderUsage | null {
  if (!a && !b) return null
  if (!a) return b ?? null
  if (!b) return a
  const inputTokens = b.inputTokens ?? a.inputTokens
  const outputTokens = b.outputTokens ?? a.outputTokens
  // 半包 total 不可信（如 start total=input、delta total=output）；有 i/o 则重算
  const totalTokens =
    inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : (b.totalTokens ?? a.totalTokens)
  return { inputTokens, outputTokens, totalTokens }
}