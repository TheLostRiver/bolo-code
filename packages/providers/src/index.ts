/** LLM Provider 适配层骨架 */

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export type ProviderId = 'openai-compatible' | 'anthropic' | 'mock'

export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done' }

export interface LlmProvider {
  id: ProviderId
  completeStream(messages: ChatMessage[]): AsyncIterable<ProviderStreamEvent>
}