/**
 * F-OR6-WS：Responses WebSocket 入口最小。
 * 默认仍用 HTTP SSE；未完整实现时明确失败（禁止 stub 假完成）。
 */

import type { LlmProvider } from './types.ts'

export function createOpenAIResponsesWsProvider(_config?: {
  apiKey?: string
  baseUrl?: string
  model?: string
}): LlmProvider {
  return {
    id: 'openai-responses-ws',
    async *completeStream() {
      yield {
        type: 'error',
        message:
          'Responses WebSocket transport is not fully implemented; use HTTP SSE (openai-responses).',
      }
      yield { type: 'done' }
    },
    async completeText() {
      throw new Error(
        'Responses WebSocket not implemented; use createOpenAIResponsesProvider (HTTP SSE)',
      )
    },
  }
}