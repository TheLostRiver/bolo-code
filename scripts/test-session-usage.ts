/**
 * Usage+ 本地 breakdown 单测（无网络 / 无遥测）
 * 运行：npx tsx scripts/test-session-usage.ts
 */
import {
  accumulateSessionUsage,
  createEmptySessionUsage,
  cloneSessionUsage,
  formatSessionUsage,
  formatUsageOneLiner,
  normalizeProviderUsage,
  estimateUsageFromCharCounts,
  createSession,
  submitUserInput,
  toSnapshot,
  parseSessionSnapshot,
} from '../packages/core/src/index.ts'
import {
  parseOpenAIStreamUsage,
  parseAnthropicStreamUsage,
  mergeProviderUsage,
  parseResponsesUsage,
} from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// ── normalize + accumulate ──
const empty = createEmptySessionUsage()
assert(empty.calls === 0, 'empty calls')

const n1 = normalizeProviderUsage({
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 40,
  cacheCreationInputTokens: 10,
})
assert(n1 != null, 'normalize with cache')
assert(n1!.cacheReadInputTokens === 40, 'norm cache read')
assert(n1!.cacheCreationInputTokens === 10, 'norm cache create')

accumulateSessionUsage(empty, { ...n1!, model: 'gpt-test' })
assert(empty.calls === 1, 'calls 1')
assert(empty.cacheReadInputTokens === 40, 'session cache read')
assert(empty.cacheCreationInputTokens === 10, 'session cache create')
assert(empty.byModel?.['gpt-test']?.inputTokens === 100, 'byModel input')
assert(empty.byModel?.['gpt-test']?.cacheReadInputTokens === 40, 'byModel cache')

accumulateSessionUsage(empty, {
  ...estimateUsageFromCharCounts({ inputChars: 40, outputChars: 8 }),
  model: 'gpt-test',
})
assert(empty.estimated === true, 'estimated flag')
assert(empty.byModel?.['gpt-test']?.calls === 2, 'byModel calls 2')
assert(empty.byModel?.['gpt-test']?.estimated === true, 'byModel est')

// second model
accumulateSessionUsage(empty, {
  inputTokens: 5,
  outputTokens: 5,
  totalTokens: 10,
  model: 'other-model',
})
assert(Object.keys(empty.byModel ?? {}).length === 2, 'two models')

const formatted = formatSessionUsage(empty)
assert(formatted.includes('cacheRead:'), 'format cacheRead')
assert(formatted.includes('cacheWrite:'), 'format cacheWrite')
assert(formatted.includes('by model:'), 'format by model')
assert(formatted.includes('gpt-test:'), 'format model name')
assert(formatted.includes('other-model:'), 'format other model')
assert(formatted.includes('local only'), 'local only banner')
assert(!formatted.toLowerCase().includes('telemetry') || formatted.includes('no telemetry'), 'no telemetry')

const one = formatUsageOneLiner(empty)
assert(/usage:\s+\d+ tokens/.test(one), 'one-liner tokens')
assert(one.includes('cache r/w'), 'one-liner cache')

const cloned = cloneSessionUsage(empty)!
assert(cloned.byModel?.['gpt-test']?.calls === 2, 'clone byModel')
cloned.byModel!['gpt-test']!.calls = 99
assert(empty.byModel!['gpt-test']!.calls === 2, 'clone deep')

// ── provider SSE cache fields ──
const oai = parseOpenAIStreamUsage({
  usage: {
    prompt_tokens: 50,
    completion_tokens: 10,
    total_tokens: 60,
    prompt_tokens_details: { cached_tokens: 12 },
  },
})
assert(oai?.cacheReadInputTokens === 12, 'oai cached_tokens')
assert(oai?.inputTokens === 50, 'oai input')

const ant = parseAnthropicStreamUsage({
  type: 'message_start',
  message: {
    usage: {
      input_tokens: 200,
      output_tokens: 0,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    },
  },
})
assert(ant?.cacheReadInputTokens === 80, 'ant cache read')
assert(ant?.cacheCreationInputTokens === 20, 'ant cache create')

const antDelta = parseAnthropicStreamUsage({
  type: 'message_delta',
  usage: { output_tokens: 15 },
})
const merged = mergeProviderUsage(ant, antDelta)
assert(merged?.outputTokens === 15, 'merge output')
assert(merged?.cacheReadInputTokens === 80, 'merge keeps cache read')
assert(merged?.cacheCreationInputTokens === 20, 'merge keeps cache create')

const resp = parseResponsesUsage({
  usage: {
    input_tokens: 30,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 7 },
  },
})
assert(resp?.cacheReadInputTokens === 7, 'responses cached')

// ── /cost via session + persist roundtrip ──
async function main() {
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    permissionMode: 'default',
    model: 'mock-a',
  })
  session.usage = createEmptySessionUsage()
  accumulateSessionUsage(session.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadInputTokens: 3,
    model: 'mock-a',
  })
  const cost = await submitUserInput(session, '/cost')
  assert(cost.type === 'slash', 'cost slash')
  if (cost.type === 'slash') {
    assert(cost.message.includes('cacheRead:'), 'cost cacheRead')
    assert(cost.message.includes('by model:'), 'cost by model')
    assert(cost.message.includes('mock-a:'), 'cost model bucket')
  }

  const snap = toSnapshot(session)
  const snap2 = parseSessionSnapshot(JSON.parse(JSON.stringify(snap)))
  assert(snap2.usage?.cacheReadInputTokens === 3, 'snap cache')
  assert(snap2.usage?.byModel?.['mock-a']?.inputTokens === 10, 'snap byModel')

  // mock rounds still accumulate
  await submitUserInput(session, 'usage round')
  assert(session.usage && session.usage.calls >= 2, 'calls after mock')
  assert(session.usage!.byModel?.['mock-a'] != null, 'byModel after mock')

  console.log('ok: test-session-usage')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})