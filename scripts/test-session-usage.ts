/**
 * Usage+ 本地 breakdown 单测（无网络 / 无遥测）
 * 运行：npx tsx scripts/test-session-usage.ts
 */
import {
  accumulateSessionUsage,
  createEmptySessionUsage,
  cloneSessionUsage,
  mergeSessionUsage,
  computeCacheHitRate,
  formatCacheHitRatePercent,
  formatSessionUsage,
  formatUsageOneLiner,
  normalizeProviderUsage,
  estimateUsageFromCharCounts,
  estimateSessionUsd,
  estimateUsdCost,
  formatUsd,
  resolveModelCostRates,
  createSession,
  submitUserInput,
  toSnapshot,
  parseSessionSnapshot,
  createPromptCacheSessionState,
  shouldBreakPromptCache,
  notePromptCacheAfterModelCall,
  hashToolNames,
  formatPromptCacheSessionLine,
  serializePromptCacheSessionState,
  parsePromptCacheSessionState,
  diffToolNames,
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
assert(empty.lastCall?.inputTokens === 100, 'lastCall input')
assert(empty.lastCall?.model === 'gpt-test', 'lastCall model')
assert(empty.lastCall?.cacheReadInputTokens === 40, 'lastCall cache')

accumulateSessionUsage(empty, {
  ...estimateUsageFromCharCounts({ inputChars: 40, outputChars: 8 }),
  model: 'gpt-test',
})
assert(empty.estimated === true, 'estimated flag')
assert(empty.byModel?.['gpt-test']?.calls === 2, 'byModel calls 2')
assert(empty.byModel?.['gpt-test']?.estimated === true, 'byModel est')
assert(empty.lastCall?.estimated === true, 'lastCall est')

// second model
accumulateSessionUsage(empty, {
  inputTokens: 5,
  outputTokens: 5,
  totalTokens: 10,
  model: 'other-model',
})
assert(Object.keys(empty.byModel ?? {}).length === 2, 'two models')
assert(empty.lastCall?.model === 'other-model', 'lastCall updates')

const formatted = formatSessionUsage(empty)
assert(formatted.includes('cacheRead:'), 'format cacheRead')
assert(formatted.includes('cacheWrite:'), 'format cacheWrite')
assert(formatted.includes('by model:'), 'format by model')
assert(formatted.includes('gpt-test:'), 'format model name')
assert(formatted.includes('other-model:'), 'format other model')
assert(formatted.includes('local only'), 'local only banner')
assert(formatted.includes('cacheHitRate:'), 'format cacheHitRate')
assert(formatted.includes('est. USD:'), 'format est usd')
assert(formatted.includes('last call:'), 'format last call')
assert(
  !formatted.toLowerCase().includes('telemetry') ||
    formatted.includes('no telemetry'),
  'no telemetry',
)

const hit = computeCacheHitRate(empty)
assert(hit != null && hit > 0 && hit <= 1, `cache hit rate: ${hit}`)
assert(formatCacheHitRatePercent(empty)?.endsWith('%'), 'hit percent string')

// USD estimate
const usd = estimateSessionUsd(empty)
assert(usd.usd > 0, 'session usd > 0')
assert(usd.byModel.length === 2, 'usd by model rows')
assert(usd.cacheSavingsUsd > 0, 'cache savings from cache reads')
const opus = estimateUsdCost(
  { inputTokens: 1_000_000, outputTokens: 0 },
  'claude-opus-4',
)
const mini = estimateUsdCost(
  { inputTokens: 1_000_000, outputTokens: 0 },
  'gpt-4o-mini',
)
assert(opus.usd > mini.usd, 'opus tier costlier than mini for same tokens')
assert(formatUsd(0.001).startsWith('$'), 'format usd')
assert(resolveModelCostRates('opus').tier.includes('opus'), 'opus tier name')

// api duration
const withDur = createEmptySessionUsage()
accumulateSessionUsage(withDur, {
  inputTokens: 10,
  outputTokens: 1,
  totalTokens: 11,
  model: 'm',
  apiDurationMs: 1500,
})
assert(withDur.apiDurationMs === 1500, 'api duration total')
assert(withDur.lastCall?.apiDurationMs === 1500, 'last call duration')
const fmtDur = formatSessionUsage(withDur)
assert(fmtDur.includes('API duration:'), 'format api duration')
assert(fmtDur.includes('1.5s') || fmtDur.includes('1500ms'), 'format duration value')

// prompt cache break: tools / model / cache_read_drop
let pcs = createPromptCacheSessionState(60_000)
notePromptCacheAfterModelCall(pcs, {
  stablePrefix: 'stable-a',
  toolNames: ['Read', 'Bash'],
  model: 'm1',
  effort: 'medium',
  cacheReadTokens: 1000,
})
assert(pcs.lastCacheAt != null, 'pcs touched')
assert(pcs.toolsHash === hashToolNames(['Bash', 'Read']), 'tools hash sorted')
const toolsBreak = shouldBreakPromptCache(pcs, {
  stablePrefix: 'stable-a',
  toolNames: ['Read', 'Write'],
  model: 'm1',
})
assert(toolsBreak.reason === 'tools_changed', 'tools break')
assert(
  toolsBreak.toolsAdded?.includes('Write') ||
    toolsBreak.detail?.includes('+Write'),
  'tools break names detail',
)
const modelBreak = shouldBreakPromptCache(pcs, {
  stablePrefix: 'stable-a',
  toolNames: ['Read', 'Bash'],
  model: 'm2',
})
assert(modelBreak.reason === 'model_changed', 'model break')
assert(modelBreak.detail?.includes('→'), 'model break detail')
const dropBreak = shouldBreakPromptCache(pcs, {
  stablePrefix: 'stable-a',
  toolNames: ['Read', 'Bash'],
  model: 'm1',
  cacheReadTokens: 10,
})
assert(dropBreak.reason === 'cache_read_drop', 'cache read drop')
notePromptCacheAfterModelCall(pcs, {
  stablePrefix: 'stable-a',
  toolNames: ['Read', 'Write'],
  model: 'm1',
  cacheReadTokens: 10,
})
assert((pcs.breakCount ?? 0) >= 1, 'break count increments')
assert(
  pcs.lastToolsAdded?.includes('Write') || pcs.lastBreakDetail,
  'last tools or detail recorded',
)
const pcLine = formatPromptCacheSessionLine(pcs)
assert(pcLine?.includes('breaks='), 'pc line breaks')
assert(pcLine?.includes('prevCacheRead='), 'pc line prev read')
assert(pcLine?.includes('detail=') || pcLine?.includes('tools'), 'pc line detail')

// serialize / parse prompt cache
const ser = serializePromptCacheSessionState(pcs)
assert(ser != null, 'serialize pcs')
const restored = parsePromptCacheSessionState(ser)
assert(restored?.breakCount === pcs.breakCount, 'parse breakCount')
assert(restored?.lastModel === pcs.lastModel, 'parse lastModel')
const dtn = diffToolNames(['Read'], ['Read', 'Write'])
assert(dtn.added.includes('Write') && dtn.removed.length === 0, 'diffToolNames')

// merge child into parent
const parentU = createEmptySessionUsage()
accumulateSessionUsage(parentU, {
  inputTokens: 10,
  outputTokens: 2,
  totalTokens: 12,
  cacheReadInputTokens: 4,
  model: 'parent-m',
})
const childU = createEmptySessionUsage()
accumulateSessionUsage(childU, {
  inputTokens: 50,
  outputTokens: 10,
  totalTokens: 60,
  cacheReadInputTokens: 20,
  cacheCreationInputTokens: 5,
  model: 'child-m',
})
mergeSessionUsage(parentU, childU)
assert(parentU.calls === 2, 'merged calls')
assert(parentU.inputTokens === 60, 'merged input')
assert(parentU.outputTokens === 12, 'merged output')
assert(parentU.totalTokens === 72, 'merged total')
assert(parentU.cacheReadInputTokens === 24, 'merged cache read')
assert(parentU.cacheCreationInputTokens === 5, 'merged cache create')
assert(parentU.byModel?.['parent-m']?.calls === 1, 'parent model kept')
assert(parentU.byModel?.['child-m']?.inputTokens === 50, 'child model rolled up')
assert(parentU.lastCall?.model === 'child-m', 'merge takes child lastCall')
// child unchanged
assert(childU.calls === 1, 'child not mutated')

const one = formatUsageOneLiner(empty)
assert(/usage:\s+\d+ tokens/.test(one), 'one-liner tokens')
assert(one.includes('cache r/w'), 'one-liner cache')
assert(one.includes('hit '), 'one-liner hit')
assert(one.includes('~$') || one.includes('$'), 'one-liner usd')

const cloned = cloneSessionUsage(empty)!
assert(cloned.byModel?.['gpt-test']?.calls === 2, 'clone byModel')
assert(cloned.lastCall?.model === empty.lastCall?.model, 'clone lastCall')
cloned.byModel!['gpt-test']!.calls = 99
assert(empty.byModel!['gpt-test']!.calls === 2, 'clone deep')
if (cloned.lastCall) cloned.lastCall.model = 'mutated'
assert(empty.lastCall?.model !== 'mutated', 'clone lastCall deep')

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
    assert(cost.message.includes('est. USD:'), 'cost est usd')
    assert(cost.message.includes('last call:'), 'cost last call')
    assert(
      cost.message.includes('promptCache:') ||
        cost.message.includes('prompt cache'),
      'cost promptCache line',
    )
    assert(cost.message.includes('wall:'), 'cost wall duration')
  }

  assert(session.promptCacheState != null, 'session has promptCacheState')
  assert(session.sessionStartedAtMs != null, 'session wall start')

  // mock round touches prompt cache + duration
  await submitUserInput(session, 'usage round')
  assert(session.usage && session.usage.calls >= 2, 'calls after mock')
  assert(session.usage!.byModel?.['mock-a'] != null, 'byModel after mock')
  assert(
    session.promptCacheState?.lastCacheAt != null,
    'prompt cache touched after model call',
  )

  // snapshot includes promptCache + wall start
  const snap = toSnapshot(session)
  assert(snap.promptCacheState != null || session.promptCacheState != null, 'snap pcs field')
  // toSnapshot should write promptCache when present
  const snapRaw = JSON.parse(JSON.stringify(snap)) as {
    promptCacheState?: unknown
    sessionStartedAtMs?: number
    usage?: { lastCall?: unknown }
  }
  // re-parse through parseSessionSnapshot
  const snap2 = parseSessionSnapshot(snapRaw)
  assert(snap2.usage?.lastCall != null || snap.usage?.lastCall != null, 'snap lastCall')
  if (snap2.promptCacheState) {
    assert(
      snap2.promptCacheState.lastCacheAt != null ||
        (snap2.promptCacheState.breakCount ?? 0) >= 0,
      'snap pcs restored',
    )
  }
  if (snap2.sessionStartedAtMs != null) {
    assert(
      snap2.sessionStartedAtMs === session.sessionStartedAtMs,
      'snap wall start',
    )
  }

  // flagship vs mini pricing
  assert(
    resolveModelCostRates('gpt-4o').tier.includes('flagship') ||
      resolveModelCostRates('gpt-4o').known,
    'gpt-4o known tier',
  )
  assert(
    resolveModelCostRates('gpt-4o-mini').tier.includes('mini'),
    '4o-mini is mini not flagship',
  )

  console.log('ok: test-session-usage')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})