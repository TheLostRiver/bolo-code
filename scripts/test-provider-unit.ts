/**
 * Provider 消息转换单测（不联网）
 */
import {
  toOpenAIMessages,
  toolsToOpenAI,
} from '../packages/providers/src/openaiCompatible.ts'
import {
  toAnthropicMessages,
  toolsToAnthropic,
} from '../packages/providers/src/anthropic.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import { BUILTIN_TOOLS } from '../packages/tools/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const msgs: ChatMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: 'running',
    tool_calls: [
      { id: 'c1', name: 'Bash', arguments: '{"command":"echo 1"}' },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'c1',
    name: 'Bash',
    content: '1',
  },
  { role: 'user', content: 'thanks' },
]

// --- OpenAI ---
const oai = toOpenAIMessages(msgs)
assert(oai.length === 5, 'openai message count')
assert((oai[2] as { tool_calls?: unknown[] }).tool_calls?.[0], 'oai tool_calls')
assert((oai[3] as { role: string }).role === 'tool', 'oai tool role')

const oaiTools = toolsToOpenAI(BUILTIN_TOOLS)
assert(oaiTools.some((t) => t.function.name === 'Bash'), 'oai Bash tool')

// --- Anthropic ---
const ant = toAnthropicMessages(msgs)
assert(ant.system?.includes('helpful'), 'anthropic system')
assert(ant.messages.length >= 3, 'anthropic messages')
const asst = ant.messages.find((m) => m.role === 'assistant')
assert(Array.isArray(asst?.content), 'assistant content blocks')
const blocks = asst!.content as Array<{ type: string; name?: string }>
assert(blocks.some((b) => b.type === 'tool_use' && b.name === 'Bash'), 'tool_use')
const toolUser = ant.messages.find(
  (m) =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'),
)
assert(toolUser, 'tool_result user message')

const antTools = toolsToAnthropic(BUILTIN_TOOLS)
assert(antTools.some((t) => t.name === 'Bash'), 'ant Bash tool')
assert(antTools[0].input_schema, 'input_schema')

console.log('PROVIDER UNIT PASS (openai + anthropic converters)')