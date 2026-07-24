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
}

export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
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