import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'

export type ProviderId =
  | 'openai-compatible'
  | 'openai-responses'
  | 'openai-responses-ws'
  | 'anthropic'
  | 'mock'
  | (string & {})

/** 可选 token 用量（本地累计；无遥测） */
export type ProviderUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** 缓存命中（读）token；Anthropic cache_read / OpenAI cached */
  cacheReadInputTokens?: number
  /** 缓存写入 token；Anthropic cache_creation */
  cacheCreationInputTokens?: number
  /** 服务端搜索请求次数（Anthropic `server_tool_use.web_search_requests`）；单独计费 */
  webSearchRequests?: number
  /**
   * `inputTokens` 是否**不含**缓存部分。
   *
   * 两家语义不同，必须显式标注而不是猜：
   * - Anthropic：`input_tokens` 不含 cache_read/cache_creation，三者相加才是真实 prompt
   * - OpenAI：`prompt_tokens` 已含 cached，`cached_tokens` 只是明细
   *
   * 消费方（如 usage 锚）据此决定要不要把 cache 加回来。
   */
  inputExcludesCache?: boolean
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
  /**
   * 流里出现了本客户端不认识的内容块 / delta。
   *
   * 存在的理由：各家的流解析都是**白名单**（防止服务端块被误当本地工具执行），
   * 但白名单没有兜底就等于静默丢弃——provider 侧新加的块（如服务端搜索的
   * `server_tool_use` / `web_search_tool_result`）会让用户付了钱、拿不到结果、
   * 且完全看不出发生过什么。报错可以诊断，静默不能。
   *
   * 这是**诊断信号**，不是错误：不终止本轮，也不写进 ChatMessage。
   */
  | { type: 'provider_notice'; kind: 'unknown_block'; detail: string }
  /**
   * 服务端搜索的可观测信号。
   *
   * **不是** `tool_call`——那个语义是「Bolo 去本地执行」。搜索在 provider 侧
   * 已经跑完，这里只是让用户看见发生过什么：搜了什么词、回了几条、引了哪些源。
   * 没有它，用户会为一次看不见的搜索付费。
   */
  | {
      type: 'web_search'
      phase: 'query' | 'results' | 'citation'
      query?: string
      resultCount?: number
      url?: string
      title?: string
    }
  | {
      type: 'error'
      message: string
      /** HTTP 状态（若可得）；供分类器判断可重试性 */
      status?: number
      /**
       * 服务端要求的等待时长（ms），来自 `retry-after` / `retry-after-ms`。
       * 缺省表示服务端没说，调用方应退回自己的退避策略——**不要猜**。
       */
      retryAfterMs?: number
    }

export type CompleteStreamOptions = {
  tools?: ToolSpec[]
  /**
   * Web search 意图（`auto` = 按该 provider 方言的默认值）。
   * 只是意图；厂商 wire 片段住在 webSearchDialect 表里。
   */
  webSearch?: import('./webSearchDialect.ts').WebSearchIntent
  signal?: AbortSignal
  disableTools?: boolean
  /**
   * 本轮覆盖 model（缺省用 provider 构造时的 config.model）。
   * 子 agent 解析链可传入。
   */
  model?: string
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

export type CompleteTextOptions = Pick<
  CompleteStreamOptions,
  | 'signal'
  | 'effort'
  | 'maxTokens'
  | 'enablePromptCaching'
  | 'promptCacheKey'
>

export interface LlmProvider {
  id: ProviderId
  completeStream(
    messages: ChatMessage[],
    options?: CompleteStreamOptions,
  ): AsyncIterable<ProviderStreamEvent>
  completeText?(
    messages: ChatMessage[],
    options?: CompleteTextOptions,
  ): Promise<string>
}
