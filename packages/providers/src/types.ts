import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'

export type ProviderId = 'openai-compatible' | 'anthropic' | 'mock'

export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type CompleteStreamOptions = {
  tools?: ToolSpec[]
  signal?: AbortSignal
  disableTools?: boolean
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