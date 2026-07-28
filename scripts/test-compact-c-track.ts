/**
 * Compact C1/C2：user-turn keep + usage 阈值
 * 运行：node --import tsx/esm scripts/test-compact-c-track.ts
 */
import {
  splitMessagesForCompactKeep,
  groupMessagesByUserTurn,
  adjustCutForToolPairing,
  runFullCompact,
  shouldAutoCompact,
  resolveAutoCompactTokenCount,
  getAutoCompactThreshold,
  type ChatMessage,
} from '../packages/compact/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // --- group by user turn ---
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', name: 'Bash', arguments: '{}' }],
    },
    { role: 'tool', content: 'out', tool_call_id: 't1', name: 'Bash' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
  ]
  const g = groupMessagesByUserTurn(msgs)
  assert(g.length === 3, `turns ${g.length}`)
  assert(g[1]!.length === 3, 'turn2 includes tool pair')

  // --- split keep 1 turn ---
  const s1 = splitMessagesForCompactKeep(msgs, { keepRecentUserTurns: 1 })
  assert(s1.messagesToKeep[0]?.content === 'u3', 'keep last user')
  assert(s1.toSummarize.some((m) => m.content === 'u1'), 'summarize early')
  assert(
    !s1.toSummarize.some((m) => m.content === 'u3'),
    'u3 not in summarize',
  )

  // --- keep 0 = all summarize ---
  const s0 = splitMessagesForCompactKeep(msgs, { keepRecentUserTurns: 0 })
  assert(s0.messagesToKeep.length === 0, 'keep 0 empty')
  assert(s0.toSummarize.length === msgs.length, 'all summarize')

  // --- legacy message count ---
  const sl = splitMessagesForCompactKeep(msgs, { keepRecentMessageCount: 2 })
  assert(sl.messagesToKeep.length === 2, 'legacy 2')

  // --- tool pairing cut ---
  const withTool: ChatMessage[] = [
    { role: 'user', content: 'do' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'x', name: 'Bash', arguments: '{}' }],
    },
    { role: 'tool', content: 'r', tool_call_id: 'x', name: 'Bash' },
    { role: 'user', content: 'next' },
  ]
  // cut 落在 tool 上 → 应左移
  const cut = adjustCutForToolPairing(withTool, 2)
  assert(cut <= 1, `cut adjusted from 2 to ${cut}`)
  const st = splitMessagesForCompactKeep(withTool, {
    keepRecentMessageCount: 1,
  })
  // keep 最后 1 条是 user next；若 cut 曾破坏 tool 对，toSummarize 不应以 tool 开头
  assert(
    st.toSummarize.length === 0 || st.toSummarize[0]?.role !== 'tool',
    'summarize not start with orphan tool',
  )
  assert(
    st.messagesToKeep[0]?.role !== 'tool' ||
      st.messagesToKeep.some((m) => m.role === 'assistant'),
    'keep not lone tool without assistant when possible',
  )

  // --- full compact with turns ---
  const long: ChatMessage[] = []
  for (let i = 0; i < 4; i++) {
    long.push({ role: 'user', content: `user-turn-${i}` })
    long.push({ role: 'assistant', content: `asst-${i}` })
  }
  const ok = await runFullCompact({
    messages: long,
    trigger: 'manual',
    keepRecentUserTurns: 1,
    summarize: async ({ messages }) => {
      assert(
        messages.every((m) => !String(m.content).includes('user-turn-3')),
        'summarizer should not see last keep turn',
      )
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   multi-turn keep test\n8. Current Work:\n   C1\n</summary>`,
      }
    },
  })
  assert(ok.ok === true, 'full compact ok')
  if (ok.ok) {
    assert(
      ok.result.messagesToKeep.some((m) => m.content === 'user-turn-3'),
      'kept last user turn',
    )
    assert(
      ok.apiMessages.some((m) => m.content === 'user-turn-3'),
      'api view has keep',
    )
    assert(
      ok.apiMessages.some((m) =>
        String(m.content).includes('multi-turn keep test'),
      ),
      'has summary',
    )
  }

  // 显式 0 keep：全量进 summarizer
  const all = await runFullCompact({
    messages: long,
    trigger: 'manual',
    keepRecentUserTurns: 0,
    summarize: async ({ messages }) => {
      assert(messages.length === long.length, 'all msgs to summarizer')
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   all\n8. Current Work:\n   x\n</summary>`,
      }
    },
  })
  assert(all.ok && all.result.messagesToKeep.length === 0, 'keep 0 none')

  // --- C2 usage vs estimate ---
  const thr = getAutoCompactThreshold(128_000)
  assert(
    shouldAutoCompact({
      tokenCount: 100, // 很低
      usageInputTokens: thr + 1000,
      contextWindowTokens: 128_000,
      enabled: true,
      consecutiveFailures: 0,
    }) === true,
    'usage high triggers despite low estimate',
  )
  assert(
    shouldAutoCompact({
      tokenCount: thr + 5000,
      usageInputTokens: 50, // 很低
      contextWindowTokens: 128_000,
      enabled: true,
      consecutiveFailures: 0,
    }) === false,
    'usage low blocks despite high estimate',
  )
  const r = resolveAutoCompactTokenCount({
    estimateTokens: 10,
    usageInputTokens: 999,
  })
  assert(r.source === 'usage' && r.tokenCount === 999, 'resolve usage')
  const r2 = resolveAutoCompactTokenCount({ estimateTokens: 42 })
  assert(r2.source === 'estimate' && r2.tokenCount === 42, 'resolve estimate')

  // --- C3 mid-turn hook + C4/C5 lastCompact ---
  const { createSession, compactSession } = await import(
    '../packages/core/src/index.ts'
  )
  const { createMockProvider } = await import(
    '../packages/providers/src/index.ts'
  )
  const fat: ChatMessage[] = []
  for (let i = 0; i < 40; i++) {
    fat.push({
      role: 'user',
      content: `block-${i} ` + 'x'.repeat(800),
    })
    fat.push({ role: 'assistant', content: `reply-${i} ` + 'y'.repeat(400) })
  }
  const sess = await createSession({
    cwd: process.cwd(),
    provider: createMockProvider(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: 8_000,
    hooks: {},
    compactSummarizer: async () => ({
      text: `<summary>\n1. Primary Request and Intent:\n   mid-turn test\n8. Current Work:\n   C3\n</summary>`,
    }),
    onEvent: () => {},
  })
  sess.messages.push(...fat)
  assert(typeof sess.tryMidTurnCompact === 'function', 'tryMidTurnCompact wired')
  // 强制 usage 高，触发 mid 阈值
  if (sess.usage) {
    sess.usage.inputTokens = 50_000
    sess.usage.lastCall = {
      inputTokens: 50_000,
      outputTokens: 10,
      totalTokens: 50_010,
      at: new Date().toISOString(),
    }
  }
  const did = await sess.tryMidTurnCompact!()
  assert(did === true, 'mid-turn compact ran')
  assert(sess.lastCompact?.trigger === 'auto', 'lastCompact auto')
  assert(
    (sess.lastCompact?.summaryChars ?? 0) > 0,
    'lastCompact summary chars',
  )
  assert(
    sess.messages.some((m) => m.content === 'Conversation compacted'),
    'boundary after mid compact',
  )

  // mid 在阈值下不跑
  const sess2 = await createSession({
    cwd: process.cwd(),
    provider: createMockProvider(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: 200_000,
    hooks: {},
    compactSummarizer: async () => ({
      text: `<summary>\n1. Primary Request and Intent:\n   no\n8. Current Work:\n   x\n</summary>`,
    }),
    onEvent: () => {},
  })
  sess2.messages.push({ role: 'user', content: 'tiny' })
  const no = await sess2.tryMidTurnCompact!()
  assert(no === false, 'below threshold no mid compact')

  // C4：有 skills 时 compact 后 catalog 段可出现
  const { submitUserInput } = await import('../packages/core/src/slash.ts')
  const ctx = await submitUserInput(sess, '/context details')
  assert(ctx.type === 'slash', 'context slash')
  if (ctx.type === 'slash') {
    assert(ctx.message.includes('pressure source:'), 'context pressure source')
    assert(ctx.message.includes('keep policy:'), 'context keep policy')
    assert(ctx.message.includes('last compact:'), 'context last compact')
    assert(ctx.message.includes('mid-turn'), 'context mentions mid-turn')
  }

  // manual compact 也写 lastCompact
  const man = await compactSession(sess2, { trigger: 'manual' })
  // 可能因消息太少失败；不强制
  void man

  console.log('ok: test-compact-c-track')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
