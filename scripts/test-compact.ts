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

  console.log('COMPACT TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})