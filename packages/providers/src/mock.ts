/**
 * Mock provider — 窄链路测试
 */

import type { ChatMessage } from '../../shared/src/index.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
} from './types.ts'

export function createMockProvider(options?: {
  bashCommand?: string
}): LlmProvider {
  const bashCommand = options?.bashCommand ?? 'echo bolo-ok'
  return {
    id: 'mock',
    async *completeStream(
      messages: ChatMessage[],
      _options?: CompleteStreamOptions,
    ): AsyncIterable<ProviderStreamEvent> {
      const hasToolResult = messages.some((m) => m.role === 'tool')
      if (!hasToolResult) {
        yield { type: 'text_delta', text: 'I will run a shell command.\n' }
        yield {
          type: 'tool_call',
          id: 'call_mock_bash_1',
          name: 'Bash',
          arguments: JSON.stringify({ command: bashCommand }),
        }
        yield { type: 'done' }
        return
      }
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
      yield {
        type: 'text_delta',
        text: `Tool finished. Output:\n${lastTool?.content ?? ''}\n`,
      }
      yield { type: 'done' }
    },
    async completeText(messages: ChatMessage[]) {
      return `mock-summary of ${messages.length} messages`
    },
  }
}