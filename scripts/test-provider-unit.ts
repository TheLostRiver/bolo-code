/**
 * Provider 消息转换 + SSE usage 解析 + mapEffort（不联网）
 * 运行：npx tsx scripts/test-provider-unit.ts
 */
import {
  toOpenAIMessages,
  toolsToOpenAI,
  buildOpenAICompatibleRequestBody,
} from '../packages/providers/src/openaiCompatible.ts'
import {
  toAnthropicMessages,
  toolsToAnthropic,
  buildAnthropicRequestBody,
} from '../packages/providers/src/anthropic.ts'
import {
  mapEffort,
  DEFAULT_EFFORT_BASE_MAX_TOKENS,
  parseOpenAIStreamUsage,
  parseAnthropicStreamUsage,
  mergeProviderUsage,
  toResponsesPayload,
  toolsToResponses,
  buildResponsesRequest,
  processResponsesSseJson,
  parseResponsesUsage,
  createOpenAIResponsesProvider,
  detectProviderKind,
  getCacheControl,
  buildAnthropicSystemBlocks,
  partitionSystemForCache,
  derivePromptCacheKey,
  withToolsCacheBreakpoint,
  addMessageCacheBreakpoint,
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

// --- OpenAI Responses 映射 + SSE（不联网）---
const rsp = toResponsesPayload(msgs)
assert(rsp.instructions.includes('helpful'), 'responses instructions from system')
assert(
  rsp.input.some(
    (i) => 'type' in i && i.type === 'function_call' && i.name === 'Bash',
  ),
  'responses function_call',
)
assert(
  rsp.input.some(
    (i) => 'type' in i && i.type === 'function_call_output' && i.call_id === 'c1',
  ),
  'responses function_call_output',
)

const rspTools = toolsToResponses(BUILTIN_TOOLS)
assert(
  Array.isArray(rspTools) &&
    rspTools.some((t) => (t as { name?: string }).name === 'Bash'),
  'responses tools Bash',
)

const reqBody = buildResponsesRequest(msgs, { model: 'gpt-test' }, {
  tools: BUILTIN_TOOLS,
  maxOutputTokens: 1024,
})
assert(reqBody.stream === true, 'responses stream true')
assert(reqBody.store === false, 'responses store default false')
assert(reqBody.max_output_tokens === 1024, 'responses max_output_tokens')
assert(Array.isArray(reqBody.tools) && reqBody.tools!.length > 0, 'responses body tools')

const sseState = {
  toolAcc: new Map<string, { id: string; name: string; arguments: string }>(),
}
const textEv = processResponsesSseJson(
  { type: 'response.output_text.delta', delta: 'Hello' },
  sseState,
)
assert(
  textEv.events.some((e) => e.type === 'text_delta' && e.text === 'Hello'),
  'responses text delta',
)

const toolDone = processResponsesSseJson(
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'call_abc',
      name: 'Read',
      arguments: '{"path":"a.ts"}',
    },
  },
  sseState,
)
assert(
  toolDone.events.some(
    (e) =>
      e.type === 'tool_call' &&
      e.id === 'call_abc' &&
      e.name === 'Read' &&
      e.arguments.includes('a.ts'),
  ),
  'responses tool_call from output_item.done',
)

const completed = processResponsesSseJson(
  {
    type: 'response.completed',
    response: {
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    },
  },
  sseState,
)
assert(completed.completed === true, 'responses completed')
assert(completed.usage?.inputTokens === 10, 'responses usage input')
assert(completed.usage?.outputTokens === 20, 'responses usage output')

const fail = processResponsesSseJson(
  {
    type: 'response.failed',
    response: { error: { message: 'boom' } },
  },
  sseState,
)
assert(fail.failed === 'boom', 'responses failed message')

assert(
  parseResponsesUsage({
    response: { usage: { input_tokens: 1, output_tokens: 2 } },
  })?.totalTokens === 3,
  'parseResponsesUsage total',
)

assert(
  detectProviderKind({ kind: 'openai-responses' }) === 'openai-responses',
  'detect responses kind',
)
assert(
  createOpenAIResponsesProvider({
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
  }).id === 'openai-responses',
  'provider id openai-responses',
)

// --- Prompt cache API markers（不联网）---
assert(getCacheControl().type === 'ephemeral', 'cache_control ephemeral')

const part = partitionSystemForCache(
  '# Identity\nBolo\n\n# Environment\nDate: today',
)
assert(part.stable.includes('# Identity'), 'partition stable')
assert(part.volatile.startsWith('# Environment'), 'partition volatile')

const sysBlocks = buildAnthropicSystemBlocks(
  '# Identity\nHi\n\n# Environment\nDate: x',
)
assert(Array.isArray(sysBlocks) && sysBlocks.length === 2, 'system 2 blocks')
assert(
  sysBlocks![0]!.cache_control?.type === 'ephemeral',
  'stable system cache_control',
)
assert(sysBlocks![1]!.cache_control == null, 'volatile no cache_control')

const antBody = buildAnthropicRequestBody(
  [
    { role: 'system', content: '# Identity\nBolo\n\n# Environment\nDate: 1' },
    { role: 'user', content: 'ping' },
  ],
  { model: 'claude-test', maxTokens: 256 },
  { tools: BUILTIN_TOOLS, stream: true },
)
assert(Array.isArray(antBody.system), 'anthropic body system is blocks')
const antSys = antBody.system as Array<{ cache_control?: { type: string } }>
assert(antSys[0]?.cache_control?.type === 'ephemeral', 'body system cache')
const antBodyTools = antBody.tools as Array<{ cache_control?: { type: string } }>
assert(
  antBodyTools[antBodyTools.length - 1]?.cache_control?.type === 'ephemeral',
  'last tool cache_control',
)
const antMsgs = antBody.messages as Array<{
  content: Array<{ cache_control?: { type: string } }> | string
}>
const lastMsg = antMsgs[antMsgs.length - 1]!
assert(Array.isArray(lastMsg.content), 'last msg content array')
const lastBlock = (lastMsg.content as Array<{ cache_control?: { type: string } }>)
  .slice(-1)[0]
assert(lastBlock?.cache_control?.type === 'ephemeral', 'last msg cache_control')

const antOff = buildAnthropicRequestBody(
  [{ role: 'user', content: 'x' }],
  { model: 'claude-test', maxTokens: 64 },
  { enablePromptCaching: false, stream: false },
)
const offMsgs = antOff.messages as Array<{ content: string | unknown[] }>
assert(
  typeof offMsgs[0]?.content === 'string' ||
    !(offMsgs[0]?.content as Array<{ cache_control?: unknown }>)?.[0]
      ?.cache_control,
  'caching off → no message cache_control',
)

const toolBp = withToolsCacheBreakpoint([{ name: 'A' }, { name: 'B' }])
assert(
  (toolBp[1] as { cache_control?: { type: string } }).cache_control?.type ===
    'ephemeral',
  'tools breakpoint last only',
)
assert(
  (toolBp[0] as { cache_control?: unknown }).cache_control == null,
  'tools first no breakpoint',
)

const msgBp = addMessageCacheBreakpoint([
  { role: 'user', content: 'a' },
  { role: 'user', content: 'b' },
])
assert(
  Array.isArray(msgBp[1]!.content) &&
    (msgBp[1]!.content as Array<{ cache_control?: { type: string } }>)[0]
      ?.cache_control?.type === 'ephemeral',
  'message breakpoint last only',
)

const cacheMsgs: ChatMessage[] = [
  { role: 'system', content: '# Identity\nStable\n\n# Environment\nDate: z' },
  { role: 'user', content: 'u1' },
]
const oaiBody = buildOpenAICompatibleRequestBody(
  cacheMsgs,
  { model: 'gpt-test', maxTokens: 128 },
  { stream: true },
)
assert(
  typeof oaiBody.prompt_cache_key === 'string' &&
    String(oaiBody.prompt_cache_key).startsWith('bolo_'),
  'openai prompt_cache_key derived',
)
const key1 = derivePromptCacheKey(cacheMsgs, 'gpt-test')
const key2 = derivePromptCacheKey(
  [
    ...cacheMsgs.slice(0, 1),
    { role: 'user', content: 'different user' },
  ],
  'gpt-test',
)
assert(key1 === key2, 'prompt_cache_key stable across user text')
const oaiNoKey = buildOpenAICompatibleRequestBody(
  cacheMsgs,
  { model: 'gpt-test', maxTokens: 128 },
  { enablePromptCaching: false, stream: false },
)
assert(oaiNoKey.prompt_cache_key == null, 'openai caching off → no key')

const rspBody = buildResponsesRequest(cacheMsgs, { model: 'gpt-test' }, {})
assert(
  typeof rspBody.prompt_cache_key === 'string' &&
    rspBody.prompt_cache_key.startsWith('bolo_'),
  'responses prompt_cache_key',
)
const rspOff = buildResponsesRequest(cacheMsgs, { model: 'gpt-test' }, {
  enablePromptCaching: false,
})
assert(rspOff.prompt_cache_key == null, 'responses caching off')

// env 别名 BOLO_PROVIDER=responses
{
  const prev = process.env.BOLO_PROVIDER
  process.env.BOLO_PROVIDER = 'responses'
  assert(
    detectProviderKind() === 'openai-responses',
    'env BOLO_PROVIDER=responses → openai-responses',
  )
  process.env.BOLO_PROVIDER = 'openai-responses'
  assert(
    detectProviderKind() === 'openai-responses',
    'env BOLO_PROVIDER=openai-responses',
  )
  if (prev === undefined) delete process.env.BOLO_PROVIDER
  else process.env.BOLO_PROVIDER = prev
}

console.log(
  'PROVIDER UNIT PASS (converters + sse usage + mapEffort + responses + prompt cache)',
)