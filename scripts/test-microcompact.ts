/**
 * microcompact：清旧 tool_result（无 LLM）
 * 运行：npx tsx scripts/test-microcompact.ts
 */
import {
  microcompactMessages,
  TOOL_RESULT_CLEARED_MESSAGE,
  DEFAULT_MICROCOMPACT_OPTIONS,
  runFullCompact,
  type ChatMessage,
} from '../packages/compact/src/index.ts'
import {
  composePrepareMessages,
  createAutoCompactPrepare,
  createMicrocompactPrepare,
} from '../packages/core/src/deps.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function toolMsg(id: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: id }
}

function fixtureMessages(): ChatMessage[] {
  return [
    { role: 'user', content: 'read files' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 't1', name: 'Read', arguments: '{}' },
        { id: 't2', name: 'Bash', arguments: '{}' },
        { id: 't3', name: 'Read', arguments: '{}' },
        { id: 't4', name: 'Bash', arguments: '{}' },
        { id: 't5', name: 'Read', arguments: '{}' },
      ],
    },
    toolMsg('t1', 'OLD_RESULT_1_' + 'x'.repeat(100)),
    toolMsg('t2', 'OLD_RESULT_2_' + 'y'.repeat(100)),
    toolMsg('t3', 'OLD_RESULT_3_' + 'z'.repeat(100)),
    toolMsg('t4', 'KEEP_ME_4_recent'),
    toolMsg('t5', 'KEEP_ME_5_newest'),
  ]
}

async function main() {
  // ── 1) keep recent N，旧的占位 ──
  const msgs = fixtureMessages()
  const r = microcompactMessages(msgs, { keepRecentToolResults: 2 })
  assert(r.clearedToolUseIds.length === 3, 'cleared 3 older tool results')
  assert(r.clearedToolUseIds.includes('t1'), 't1 cleared')
  assert(r.clearedToolUseIds.includes('t2'), 't2 cleared')
  assert(r.clearedToolUseIds.includes('t3'), 't3 cleared')

  const byId = new Map(
    r.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]),
  )
  assert(byId.get('t1')?.content === TOOL_RESULT_CLEARED_MESSAGE, 't1 placeholder')
  assert(byId.get('t2')?.content === TOOL_RESULT_CLEARED_MESSAGE, 't2 placeholder')
  assert(byId.get('t3')?.content === TOOL_RESULT_CLEARED_MESSAGE, 't3 placeholder')
  assert(byId.get('t4')?.content === 'KEEP_ME_4_recent', 't4 kept full')
  assert(byId.get('t5')?.content === 'KEEP_ME_5_newest', 't5 kept full')
  assert(byId.get('t1')?.role === 'tool', 'role preserved')
  assert(byId.get('t1')?.tool_call_id === 't1', 'tool_call_id preserved')
  assert(r.tokensSavedEstimate > 0, 'tokens saved estimate > 0')

  // ── 2) 幂等：再 micro 不重复计 cleared ──
  const r2 = microcompactMessages(r.messages, { keepRecentToolResults: 2 })
  assert(r2.clearedToolUseIds.length === 0, 'already cleared → no new clears')
  assert(
    r2.messages.filter((m) => m.role === 'tool' && m.content === TOOL_RESULT_CLEARED_MESSAGE)
      .length === 3,
    'placeholders remain',
  )

  // ── 3) maxToolResultChars 截断最近条 ──
  const long = microcompactMessages(
    [
      toolMsg('a', 'A'.repeat(200)),
      toolMsg('b', 'B'.repeat(200)),
    ],
    { keepRecentToolResults: 2, maxToolResultChars: 50 },
  )
  assert(long.truncatedToolUseIds.includes('a'), 'a truncated')
  assert(long.truncatedToolUseIds.includes('b'), 'b truncated')
  assert(
    (long.messages[0]?.content.length ?? 0) < 200,
    'content shorter after truncate',
  )
  assert(long.messages[0]?.content.includes('truncated'), 'truncate marker')
  assert(long.messages[0]?.tool_call_id === 'a', 'id after truncate')

  // ── 4) disabled ──
  const offSrc = fixtureMessages()
  const off = microcompactMessages(offSrc, { enabled: false })
  assert(off.clearedToolUseIds.length === 0, 'disabled clears nothing')
  assert(off.messages === offSrc, 'disabled returns same array ref')

  // ── 5) prepare 链：micro → auto full 顺序，且不冲突 ──
  let autoRan = 0
  const prepare = composePrepareMessages(
    createMicrocompactPrepare({ keepRecentToolResults: 1 }),
    createAutoCompactPrepare({
      enabled: true,
      contextWindowTokens: 1_000,
      runAutoCompact: async (messages) => {
        autoRan += 1
        // auto 见到的应已 micro 过：旧 tool 已是占位
        const tools = messages.filter((m) => m.role === 'tool')
        const cleared = tools.filter((m) => m.content === TOOL_RESULT_CLEARED_MESSAGE)
        assert(cleared.length >= 1, 'auto sees micro-cleared tools')
        return [
          { role: 'system', content: 'Conversation compacted' },
          { role: 'user', content: 'SUMMARY_AFTER_MICRO' },
        ]
      },
    }),
  )

  // 造足够大上下文触发 auto（estimateTokens ≈ chars/4）
  const fat: ChatMessage[] = [
    { role: 'user', content: 'x'.repeat(20_000) },
    ...fixtureMessages().slice(1),
  ]
  const prep = await prepare({
    messages: fat,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(autoRan === 1, 'auto full ran after micro')
  assert(prep.didCompact === true, 'didCompact from full')
  assert(
    prep.messages.some((m) => m.content === 'SUMMARY_AFTER_MICRO'),
    'full compact result',
  )

  // ── 6) full compact 管道仍可对含 tool 消息工作 ──
  const full = await runFullCompact({
    messages: r.messages,
    trigger: 'manual',
    summarize: async () => ({
      text: `<analysis>x</analysis><summary>\n1. Primary Request and Intent:\n   Micro test.\n8. Current Work:\n   After micro.\n</summary>`,
    }),
  })
  assert(full.ok === true, 'full compact ok after micro')
  if (full.ok) {
    assert(
      full.apiMessages[0]?.content === 'Conversation compacted',
      'boundary after full',
    )
  }

  // ── 7) 默认 keep ──
  assert(DEFAULT_MICROCOMPACT_OPTIONS.keepRecentToolResults === 4, 'default keep=4')
  assert(DEFAULT_MICROCOMPACT_OPTIONS.maxToolResultChars === 50_000, 'default max chars')

  console.log('PASS: microcompact')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})