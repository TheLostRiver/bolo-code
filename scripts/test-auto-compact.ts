/**
 * auto compact 挂 prepareMessages + compactSession 接线（fake summarizer，无网络）
 * 运行：npx tsx scripts/test-auto-compact.ts
 */
import {
  getAutoCompactThreshold,
  estimateTokens,
  type ChatMessage,
} from '../packages/compact/src/index.ts'
import {
  createSession,
  submitPrompt,
  compactSession,
} from '../packages/core/src/index.ts'
import { createAutoCompactPrepare } from '../packages/core/src/deps.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 无 tool 的短回复，避免 mock 默认 Bash 路径 */
function textOnlyProvider(reply = 'ok-after-compact'): LlmProvider {
  return {
    id: 'mock-text',
    async *completeStream() {
      yield { type: 'text_delta', text: reply }
      yield { type: 'done' }
    },
    async completeText() {
      return 'unused'
    },
  }
}

async function main() {
  // ── 1) createAutoCompactPrepare 纯路径 ──
  let ran = 0
  const prepare = createAutoCompactPrepare({
    enabled: true,
    contextWindowTokens: 8_000,
    runAutoCompact: async () => {
      ran += 1
      return [
        { role: 'system', content: 'Conversation compacted' },
        { role: 'user', content: 'SUMMARY_BODY' },
      ]
    },
  })

  const small: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  const r0 = await prepare({
    messages: small,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(r0.didCompact !== true, 'small context no compact')
  assert(ran === 0, 'summarizer not called for small')

  const threshold = getAutoCompactThreshold(8_000)
  const pad = 'x'.repeat((threshold + 100) * 4)
  const fat: ChatMessage[] = [{ role: 'user', content: pad }]
  assert(estimateTokens(fat) >= threshold, 'fixture over threshold')

  const r1 = await prepare({
    messages: fat,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(r1.didCompact === true, 'didCompact true')
  assert(ran === 1, 'runAutoCompact once')
  assert(
    r1.messages.some((m) => m.content === 'SUMMARY_BODY'),
    'summary in prepared messages',
  )

  const r2 = await prepare({
    messages: fat,
    querySource: 'compact',
    tokenCount: 0,
  })
  assert(r2.didCompact !== true, 'no compact when querySource=compact')
  assert(ran === 1, 'still one run')

  // ── 2) session：auto → compactSession + summarizer ──
  let summarizeCalls = 0
  const longContent = 'y'.repeat((getAutoCompactThreshold(8_000) + 200) * 4)
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: 8_000,
    provider: textOnlyProvider(),
    compactSummarizer: async ({ compactPrompt }) => {
      summarizeCalls += 1
      assert(compactPrompt.includes('TEXT ONLY'), 'compact prompt no-tools')
      return {
        text: `<analysis>x</analysis><summary>\n1. Primary Request and Intent:\n   Auto compact test.\n8. Current Work:\n   Wiring prepareMessages.\n</summary>`,
      }
    },
  })

  session.messages.push({ role: 'user', content: longContent })
  session.messages.push({
    role: 'assistant',
    content: 'ack ' + 'z'.repeat(200),
  })

  const beforeLen = session.messages.length
  const terminal = await submitPrompt(session, 'continue please', {
    maxTurns: 2,
  })
  assert(terminal.reason === 'completed', `terminal=${terminal.reason}`)
  assert(summarizeCalls >= 1, 'auto compact invoked summarizer')
  assert(
    session.messages.some((m) =>
      String(m.content).includes('Auto compact test'),
    ),
    'summary text in session messages',
  )
  assert(
    session.messages.some((m) => m.content === 'Conversation compacted'),
    'boundary present',
  )
  assert(
    !session.messages.some((m) => m.content === longContent),
    'fat prefix removed from API view',
  )
  assert(session.messages.length < beforeLen + 5, 'messages shortened')

  // ── 3) 无 summarizer 时即使 enabled 也不挂 auto ──
  const sessNoSum = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: 8_000,
    provider: textOnlyProvider(),
  })
  const prep = await sessNoSum.deps.prepareMessages({
    messages: fat,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(prep.didCompact !== true, 'no auto without summarizer')

  // ── 4) manual compact 仍可用 ──
  const sessManual = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: false,
    provider: textOnlyProvider(),
    compactSummarizer: async () => ({
      text: `<summary>manual ok</summary>`,
    }),
  })
  sessManual.messages.push({ role: 'user', content: 'a' })
  sessManual.messages.push({ role: 'assistant', content: 'b' })
  const man = await compactSession(sessManual, 'manual')
  assert(man.ok === true, 'manual compact ok')
  assert(
    sessManual.messages.some((m) => String(m.content).includes('manual ok')),
    'manual summary',
  )

  console.log('AUTO COMPACT TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})