/**
 * Provider 消息转换 + SSE usage 解析 + mapEffort（不联网）
 * 运行：npx tsx scripts/test-provider-unit.ts
 */
import {
  toOpenAIMessages,
  toolsToOpenAI,
} from '../packages/providers/src/openaiCompatible.ts'
import {
  toAnthropicMessages,
  toolsToAnthropic,
} from '../packages/providers/src/anthropic.ts'
import {
  mapEffort,
  DEFAULT_EFFORT_BASE_MAX_TOKENS,
  parseOpenAIStreamUsage,
  parseAnthropicStreamUsage,
  mergeProviderUsage,
} from '../packages/providers/src/index.ts'
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

// --- OpenAI SSE usage（mock 末包片段）---
const oaiUsage = parseOpenAIStreamUsage({
  id: 'chatcmpl-x',
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
})
assert(oaiUsage?.inputTokens === 12, 'oai usage input')
assert(oaiUsage?.outputTokens === 34, 'oai usage output')
assert(oaiUsage?.totalTokens === 46, 'oai usage total')
assert(
  parseOpenAIStreamUsage({ choices: [{ delta: { content: 'hi' } }] }) === null,
  'oai no usage → null',
)

// --- Anthropic SSE usage（mock message_start / message_delta）---
const antStart = parseAnthropicStreamUsage({
  type: 'message_start',
  message: {
    id: 'msg_1',
    usage: { input_tokens: 100, output_tokens: 0 },
  },
})
assert(antStart?.inputTokens === 100, 'ant message_start input')
const antDelta = parseAnthropicStreamUsage({
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 50 },
})
assert(antDelta?.outputTokens === 50, 'ant message_delta output')
const antMerged = mergeProviderUsage(antStart, antDelta)
assert(antMerged?.inputTokens === 100, 'merged input')
assert(antMerged?.outputTokens === 50, 'merged output')
assert(antMerged?.totalTokens === 150, 'merged total')
assert(
  parseAnthropicStreamUsage({ type: 'content_block_delta', delta: { text: 'x' } }) ===
    null,
  'ant non-usage → null',
)

// --- mapEffort 纯函数 ---
const base = DEFAULT_EFFORT_BASE_MAX_TOKENS
assert(mapEffort('low', base).maxTokens === Math.floor(base * 0.5), 'effort low')
assert(mapEffort('medium', base).maxTokens === base, 'effort medium')
assert(mapEffort('high', base).maxTokens === Math.floor(base * 1.5), 'effort high')
assert(mapEffort('max', base).maxTokens === Math.floor(base * 2), 'effort max')
assert(mapEffort('auto', base).maxTokens === base, 'effort auto')
assert(mapEffort(undefined, base).maxTokens === base, 'effort default')
assert(mapEffort('low', 1000).maxTokens === 500, 'effort low custom base')
assert(mapEffort('high', 1000).maxTokens !== mapEffort('low', 1000).maxTokens, 'effort differs')

console.log('PROVIDER UNIT PASS (converters + sse usage + mapEffort)')