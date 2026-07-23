/**
 * PTL 截断重试：mock callModel 第一次抛 PTL、第二次成功
 * 运行：npx tsx scripts/test-ptl-retry.ts
 */
import {
  isPromptTooLongError,
  truncateHeadForPtlRetry,
  groupMessagesByApiRound,
  PTL_RETRY_MARKER,
  DEFAULT_MAX_PTL_RETRIES,
  runFullCompact,
  type ChatMessage,
} from '../packages/compact/src/index.ts'
import {
  createSession,
  submitPrompt,
  queryLoop,
} from '../packages/core/src/index.ts'
import type { QueryDeps } from '../packages/core/src/deps.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // ── 1) isPromptTooLongError 启发式 ──
  assert(isPromptTooLongError('Prompt is too long'), 'prompt is too long')
  assert(
    isPromptTooLongError('prompt is too long: 137500 tokens > 135000 maximum'),
    'token counts',
  )
  assert(
    isPromptTooLongError('Error: context_length_exceeded'),
    'openai code',
  )
  assert(
    isPromptTooLongError('This model maximum context length is 128000 tokens'),
    'max context length',
  )
  assert(
    isPromptTooLongError('OpenAI-compatible HTTP 413: payload too large'),
    'http 413 in message',
  )
  assert(
    isPromptTooLongError('bad request', { status: 413 }),
    'status 413 alone',
  )
  assert(
    isPromptTooLongError('prompt is too long', { status: 400 }),
    '400 + string',
  )
  assert(
    !isPromptTooLongError('invalid api key', { status: 400 }),
    '400 without ptl string',
  )
  assert(!isPromptTooLongError('rate limit 429'), 'not rate limit')
  assert(!isPromptTooLongError('max_tokens reached in output'), 'not max out alone')

  // ── 2) truncateHeadForPtlRetry 纯函数 ──
  const long: ChatMessage[] = [
    { role: 'system', content: 'Conversation compacted' },
    { role: 'user', content: 'old-1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'old-2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'recent' },
    { role: 'assistant', content: 'a3' },
  ]
  const groups = groupMessagesByApiRound(long.slice(1))
  assert(groups.length >= 2, `groups=${groups.length}`)

  const tr = truncateHeadForPtlRetry(long)
  assert(tr !== null, 'truncate ok')
  assert(
    tr!.messages.some((m) => m.content === 'Conversation compacted'),
    'keep boundary system',
  )
  assert(
    !tr!.messages.some((m) => m.content === 'old-1'),
    'dropped oldest user round content',
  )
  assert(tr!.droppedGroupCount >= 1, 'dropped >=1 group')
  assert(tr!.messages.length < long.length, 'shorter after truncate')

  // 仅 1 组主体：无法截断
  const tooShort: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'only' },
  ]
  assert(truncateHeadForPtlRetry(tooShort) === null, 'cannot truncate short')

  // assistant-first 主体 → 前插 marker
  const asstFirst: ChatMessage[] = [
    { role: 'user', content: 'u0' },
    { role: 'assistant', content: 'a0' },
    { role: 'assistant', content: 'a1' },
  ]
  const tr2 = truncateHeadForPtlRetry(asstFirst, { dropFraction: 0.5 })
  assert(tr2 !== null, 'truncate asst-first')
  if (tr2!.messages[0]?.role === 'user') {
    // 若丢了 u0 后以 assistant 开头应有 marker
    const onlyAsst = tr2!.messages.every(
      (m, i) => i === 0 || m.role !== 'user' || m.content === PTL_RETRY_MARKER,
    )
    void onlyAsst
  }

  assert(DEFAULT_MAX_PTL_RETRIES === 3, 'default maxPtlRetries=3')

  // ── 3) queryLoop：第一次 PTL throw，第二次成功 ──
  let callCount = 0
  let seenShorter = false
  let firstLen = 0
  const ptlEvents: Array<{ attempt: number; dropped: number }> = []

  const messages: ChatMessage[] = [
    { role: 'user', content: 'turn-1' },
    { role: 'assistant', content: 'reply-1' },
    { role: 'user', content: 'turn-2' },
    { role: 'assistant', content: 'reply-2' },
    { role: 'user', content: 'turn-3-final' },
  ]

  const deps: QueryDeps = {
    prepareMessages: async ({ messages: m }) => ({ messages: m }),
    uuid: () => 'id_test',
    callModel: async function* ({ messages: m }) {
      callCount += 1
      if (callCount === 1) {
        firstLen = m.length
        throw new Error('Prompt is too long: 200000 tokens > 128000 maximum')
      }
      if (m.length < firstLen) seenShorter = true
      yield { type: 'text_delta' as const, text: 'recovered-ok' }
      yield { type: 'done' as const }
    },
  }

  const terminal = await queryLoop({
    sessionId: 'sess_ptl',
    cwd: process.cwd(),
    hooks: {},
    messages,
    deps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    maxTurns: 4,
    maxPtlRetries: 3,
    onEvent: (e) => {
      if (e.type === 'ptl_retry') {
        ptlEvents.push({
          attempt: e.attempt,
          dropped: e.droppedMessageCount,
        })
      }
    },
  })

  assert(terminal.reason === 'completed', `terminal=${terminal.reason}`)
  assert(callCount === 2, `callCount=${callCount}`)
  assert(ptlEvents.length === 1, `ptl events=${ptlEvents.length}`)
  assert(ptlEvents[0]!.attempt === 1, 'attempt 1')
  assert(ptlEvents[0]!.dropped >= 1, 'dropped messages')
  assert(seenShorter || messages.length < 5, 'messages truncated on session')
  assert(
    messages.some((m) => m.role === 'assistant' && m.content === 'recovered-ok'),
    'final assistant text',
  )
  assert(
    !messages.some((m) => m.content === 'turn-1'),
    'oldest turn dropped from session',
  )

  // ── 4) createSession + submitPrompt 路径 ──
  let n = 0
  const provider: LlmProvider = {
    id: 'mock-ptl',
    async *completeStream() {
      n += 1
      if (n === 1) {
        yield {
          type: 'error',
          message: 'HTTP 400: prompt is too long',
        }
        return
      }
      yield { type: 'text_delta', text: 'session-ok' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'unused'
    },
  }

  // 需要足够多轮以便截断
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    systemPrompt: false,
    microcompact: false,
    maxPtlRetries: 2,
    askPermission: async () => 'allow',
  })
  // 预填多轮
  session.messages.push(
    { role: 'user', content: 's1' },
    { role: 'assistant', content: 'r1' },
    { role: 'user', content: 's2' },
    { role: 'assistant', content: 'r2' },
  )
  const t2 = await submitPrompt(session, 's3-final', { maxTurns: 3 })
  assert(t2.reason === 'completed', `submit terminal=${t2.reason}`)
  assert(n === 2, `provider calls=${n}`)
  assert(
    session.messages.some((m) => m.content === 'session-ok'),
    'session recovered text',
  )

  // ── 5) runFullCompact PTL 重试 ──
  let sumCalls = 0
  const compactMsgs: ChatMessage[] = [
    { role: 'user', content: 'c1' },
    { role: 'assistant', content: 'ca1' },
    { role: 'user', content: 'c2' },
    { role: 'assistant', content: 'ca2' },
    { role: 'user', content: 'c3' },
  ]
  const originalLen = compactMsgs.length
  const fr = await runFullCompact({
    messages: compactMsgs,
    trigger: 'manual',
    maxPtlRetries: 2,
    summarize: async ({ messages: m }) => {
      sumCalls += 1
      if (sumCalls === 1) {
        throw new Error('Prompt is too long')
      }
      assert(m.length < originalLen, 'summarizer sees truncated')
      return {
        text: `<analysis>x</analysis><summary>\n1. Primary Request and Intent:\n   PTL compact test.\n8. Current Work:\n   Retry after truncate.\n</summary>`,
      }
    },
  })
  assert(fr.ok === true, 'compact ok after ptl')
  assert(sumCalls === 2, `summarizer calls=${sumCalls}`)
  assert(compactMsgs.length === originalLen, 'caller messages unchanged on compact')

  // maxPtlRetries=0 不重试
  let dead = 0
  const fr0 = await runFullCompact({
    messages: compactMsgs,
    trigger: 'manual',
    maxPtlRetries: 0,
    summarize: async () => {
      dead += 1
      throw new Error('Prompt is too long')
    },
  })
  assert(fr0.ok === false, 'compact fails when ptl disabled')
  assert(dead === 1, 'no retry when max=0')

  console.log('PASS: ptl-retry')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})