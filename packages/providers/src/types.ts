import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'

export type ProviderId =
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic'
  | 'mock'

/** 可选 token 用量（本地累计；无遥测） */
export type ProviderUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** 缓存命中（读）token；Anthropic cache_read / OpenAI cached */
  cacheReadInputTokens?: number
  /** 缓存写入 token；Anthropic cache_creation */
  cacheCreationInputTokens?: number
}

/**
 * Provider 流式事件（内部统一）。
 * reasoning_*：思考链增量；无内容则不发，不伪造。
 * 对照 HC thinking_delta / OpenCode openai-compatible reasoning_content。
 */
export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  /** 可选：思考块结束，便于 UI 与正文分段；无则静默 */
  | { type: 'reasoning_end' }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type CompleteStreamOptions = {
  tools?: ToolSpec[]
  signal?: AbortSignal
  disableTools?: boolean
  /**
   * 会话 effort 档位（low|medium|high|max|auto）。
   * provider 用 mapEffort 映射 max_tokens；auto/缺省 = 配置默认。
   */
  effort?: string
  /** 覆盖本轮 max_tokens（优先于 effort 映射结果） */
  maxTokens?: number
  /**
   * 是否在请求体写入 API prompt cache 标记（默认 true）。
   * Anthropic：cache_control；OpenAI 系：prompt_cache_key。
   * 见 packages/providers/src/promptCache.ts / docs/PROMPT_CACHE.md。
   */
  enablePromptCaching?: boolean
  /**
   * OpenAI Chat Completions / Responses 的 prompt_cache_key。
   * 缺省时由 model + system 稳定前缀派生；设空串可关闭 key。
   */
  promptCacheKey?: string
  /**
   * Anthropic 请求侧 thinking 最小开关（对照 HC budget thinking）。
   * - false / 'off'：不写 thinking 字段
   * - true / 'enabled'：enabled + budget_tokens（默认 min(10000, max_tokens-1)）
   * - number：budget_tokens（至少 1024，且 < max_tokens）
   * 仅 anthropic provider 使用；其它 provider 忽略。
   */
  anthropicThinking?: boolean | 'off' | 'enabled' | number
}

export interface LlmProvider {
  id: ProviderId
  completeStream(
    messages: ChatMessage[],
    options?: CompleteStreamOptions,
  ): AsyncIterable<ProviderStreamEvent>
  completeText?(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<string>
}