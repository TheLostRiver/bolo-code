/**
 * compact 管道单测（fake summarizer，无网络）
 * 运行：npx tsx scripts/test-compact.ts
 */

import {
  buildPostCompactMessages,
  formatCompactSummary,
  mergeHookInstructions,
  runFullCompact,
  shouldAutoCompact,
  type ChatMessage,
} from '../packages/compact/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // format
  const formatted = formatCompactSummary(
    `<analysis>scratch should go</analysis>\n<summary>\n1. Intent: ship compact\n</summary>`,
  )
  assert(!formatted.includes('scratch'), 'analysis stripped')
  assert(formatted.includes('Intent'), 'summary kept')

  // merge
  assert(
    mergeHookInstructions('user', 'hook') === 'user\n\nhook',
    'merge both',
  )
  assert(mergeHookInstructions(undefined, 'h') === 'h', 'merge hook only')

  const messages: ChatMessage[] = [
    { role: 'user', content: 'Build compaction like the reference agent' },
    { role: 'assistant', content: 'I will design full compact, not slice.' },
    { role: 'user', content: 'Do not invent telemetry' },
    { role: 'assistant', content: 'Understood, no telemetry.' },
  ]

  // 拒绝无 summarizer 式截断：用错误类型模拟——runFullCompact 要求函数
  const bad = await runFullCompact({
    messages,
    trigger: 'manual',
    summarize: async () => ({ text: '' }),
  })
  assert(bad.ok === false, 'empty summary fails')
  assert(bad.ok === false && bad.messagesUnchanged, 'unchanged on fail')

  const ok = await runFullCompact({
    messages,
    trigger: 'manual',
    customInstructions: 'from-user',
    hookInstructions: 'from-precompact-hook',
    keepRecentMessageCount: 1,
    summarize: async ({ compactPrompt }) => {
      assert(compactPrompt.includes('from-user'), 'user instructions in prompt')
      assert(compactPrompt.includes('from-precompact-hook'), 'hook instructions in prompt')
      assert(compactPrompt.includes('TEXT ONLY'), 'no-tools preamble')
      assert(compactPrompt.includes('Primary Request'), 'section list')
      return {
        text: `<analysis>draft</analysis><summary>\n1. Primary Request and Intent:\n   Design proper compaction.\n8. Current Work:\n   Writing compact package.\n</summary>`,
      }
    },
  })
  assert(ok.ok === true, 'success')
  if (!ok.ok) return

  const api = ok.apiMessages
  assert(api[0]?.content === 'Conversation compacted', 'boundary first')
  assert(api.some((m) => m.content.includes('Design proper')), 'summary in api view')
  assert(api[api.length - 1]?.content === 'Understood, no telemetry.', 'kept last message')
  assert(ok.result.summaryText.includes('Primary Request'), 'summaryText set')
  assert(
    buildPostCompactMessages(ok.result).length === api.length,
    'build matches',
  )

  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
    }) === true,
    'auto threshold high usage',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
    }) === false,
    'auto not yet',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 3,
    }) === false,
    'circuit breaker',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      querySource: 'compact',
    }) === false,
    'no recurse',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      env: { BOLO_DISABLE_AUTO_COMPACT: '1' },
    }) === false,
    'env BOLO_DISABLE_AUTO_COMPACT',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      env: { BOLO_DISABLE_COMPACT: 'true' },
    }) === false,
    'env BOLO_DISABLE_COMPACT',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      env: {},
    }) === true,
    'empty env still allows when enabled',
  )

  // ── token 启发式：正文 chars/4；JSON 密文更密 ──
  const {
    estimateTextTokens,
    estimateMessageTokens,
    estimateTokens,
    getContextPressure,
    getAutoCompactThreshold,
    getEffectiveContextWindow,
    AUTOCOMPACT_BUFFER_TOKENS,
  } = await import('../packages/compact/src/index.ts')

  assert(estimateTextTokens('abcd') === 1, 'plain text chars/4')
  assert(estimateTextTokens('abcdefgh') === 2, 'plain 8 chars → 2')
  const jsonish = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8}'
  assert(
    estimateTextTokens(jsonish) > Math.ceil(jsonish.length / 4),
    'dense JSON counts higher than chars/4',
  )
  const withTools: ChatMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'c1',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'echo hi' }),
      },
    ],
  }
  assert(
    estimateMessageTokens(withTools) >
      estimateMessageTokens({ role: 'assistant', content: '' }),
    'tool_calls add tokens',
  )
  assert(estimateTokens([withTools]) === estimateMessageTokens(withTools), 'sum')

  const thr = getAutoCompactThreshold(128_000)
  const eff = getEffectiveContextWindow(128_000)
  assert(eff === 128_000 - Math.min(20_000, Math.floor(128_000 * 0.15)), 'effective')
  assert(thr === Math.max(1_000, eff - AUTOCOMPACT_BUFFER_TOKENS), 'threshold formula')
  assert(thr < 128_000 - 10_000, 'threshold near window, not mid-session')

  const mid = getContextPressure({
    tokenCount: Math.floor(thr * 0.5),
    contextWindowTokens: 128_000,
  })
  assert(mid.level === 'ok', 'half threshold → ok')
  const near = getContextPressure({
    tokenCount: thr - 1,
    contextWindowTokens: 128_000,
  })
  assert(near.level === 'warn' || near.level === 'ok', 'just under threshold')
  const at = getContextPressure({
    tokenCount: thr,
    contextWindowTokens: 128_000,
  })
  assert(at.level === 'critical', 'at threshold → critical')
  assert(at.aboveAutoThreshold === true, 'aboveAutoThreshold')
  const over = getContextPressure({
    tokenCount: 128_000,
    contextWindowTokens: 128_000,
  })
  assert(over.level === 'over', 'full window → over')

  console.log('COMPACT TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})