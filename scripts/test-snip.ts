/**
 * snip 最小：无 LLM 裁前缀 + prepare 链 snip→micro
 * 运行：npx tsx scripts/test-snip.ts
 */
import {
  snipMessagesIfNeeded,
  findSafeSnipCutIndex,
  SNIP_BOUNDARY_CONTENT,
  estimateTokens,
  microcompactMessages,
  type ChatMessage,
} from '../packages/compact/src/index.ts'
import {
  composePrepareMessages,
  createSnipPrepare,
  createMicrocompactPrepare,
} from '../packages/core/src/deps.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function padUser(n: number, tag: string): ChatMessage {
  return { role: 'user', content: `${tag}_` + 'x'.repeat(n) }
}

async function main() {
  // ── 1) 门槛未到：不执行 ──
  const small: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]
  const r0 = snipMessagesIfNeeded(small, {
    minTokensToSnip: 10_000,
    keepRecentMessages: 2,
    minMessagesToRemove: 1,
  })
  assert(r0.executed === false, 'small context no snip')
  assert(r0.messages === small, 'same ref when no-op')
  assert(r0.tokensFreed === 0, 'no tokens freed')

  // ── 2) 达门槛：丢前缀 + 边界 ──
  const fat: ChatMessage[] = []
  for (let i = 0; i < 20; i++) {
    fat.push(padUser(2_000, `old${i}`))
  }
  fat.push({ role: 'user', content: 'KEEP_TAIL_USER' })
  fat.push({ role: 'assistant', content: 'KEEP_TAIL_ASSIST' })

  const tokensBefore = estimateTokens(fat)
  assert(tokensBefore > 8_000, 'fixture over minTokens')

  const r1 = snipMessagesIfNeeded(fat, {
    minTokensToSnip: 8_000,
    keepRecentMessages: 4,
    minMessagesToRemove: 2,
  })
  assert(r1.executed === true, 'snip executed')
  assert(r1.removedCount > 0, 'removed some')
  assert(r1.tokensFreed > 0, 'tokensFreed > 0')
  assert(r1.messages[0]?.content === SNIP_BOUNDARY_CONTENT, 'boundary first')
  assert(
    r1.messages.some((m) => m.content === 'KEEP_TAIL_USER'),
    'tail user kept',
  )
  assert(
    r1.messages.some((m) => m.content === 'KEEP_TAIL_ASSIST'),
    'tail assist kept',
  )
  assert(r1.messages.length < fat.length, 'shorter after snip')
  assert(
    !r1.messages.some((m) => m.content.startsWith('old0_')),
    'oldest dropped',
  )

  // ── 3) tool 配对安全：不从孤立 tool 切开 ──
  const withTools: ChatMessage[] = [
    padUser(3_000, 'drop_me'),
    padUser(3_000, 'drop_me2'),
    padUser(3_000, 'drop_me3'),
    padUser(3_000, 'drop_me4'),
    padUser(3_000, 'drop_me5'),
    padUser(3_000, 'drop_me6'),
    padUser(3_000, 'drop_me7'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'Read', arguments: '{}' }],
    },
    { role: 'tool', content: 'TOOL_BODY_' + 'y'.repeat(500), tool_call_id: 'c1' },
    { role: 'user', content: 'after_tool' },
  ]
  const cut = findSafeSnipCutIndex(withTools, 2)
  // keep 2 = after_tool + tool → 应回退到 assistant
  assert(withTools[cut]?.role !== 'tool', 'cut not on orphan tool')
  assert(
    withTools[cut]?.role === 'assistant' || withTools[cut]?.role === 'user',
    'cut on assistant or user',
  )

  const rTool = snipMessagesIfNeeded(withTools, {
    minTokensToSnip: 1_000,
    keepRecentMessages: 2,
    minMessagesToRemove: 2,
  })
  assert(rTool.executed === true, 'tool fixture snipped')
  const tools = rTool.messages.filter((m) => m.role === 'tool')
  for (const t of tools) {
    const idx = rTool.messages.indexOf(t)
    const prev = rTool.messages[idx - 1]
    assert(
      prev?.role === 'assistant' &&
        prev.tool_calls?.some((tc) => tc.id === t.tool_call_id),
      'tool still paired with assistant',
    )
  }

  // ── 4) prepare 链：snip → micro；snip 写回 didCompact ──
  const chain = composePrepareMessages(
    createSnipPrepare({
      minTokensToSnip: 8_000,
      keepRecentMessages: 4,
      minMessagesToRemove: 2,
    }),
    createMicrocompactPrepare({ keepRecentToolResults: 1 }),
  )
  const prepared = await chain({
    messages: fat,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(prepared.didCompact === true, 'snip sets didCompact')
  assert(
    prepared.messages[0]?.content === SNIP_BOUNDARY_CONTENT,
    'prepare has boundary',
  )
  assert(prepared.messages.length < fat.length, 'prepare shortened')

  // micro 在 snip 后仍可清 tool（正交）
  const mix: ChatMessage[] = [
    padUser(4_000, 'a'),
    padUser(4_000, 'b'),
    padUser(4_000, 'c'),
    padUser(4_000, 'd'),
    padUser(4_000, 'e'),
    padUser(4_000, 'f'),
    padUser(4_000, 'g'),
    padUser(4_000, 'h'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 't1', name: 'Read', arguments: '{}' },
        { id: 't2', name: 'Read', arguments: '{}' },
      ],
    },
    { role: 'tool', content: 'OLD_' + 'z'.repeat(200), tool_call_id: 't1' },
    { role: 'tool', content: 'NEW_KEEP', tool_call_id: 't2' },
  ]
  const prep2 = await chain({
    messages: mix,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(prep2.didCompact === true, 'mix snipped')
  const microOnly = microcompactMessages(
    prep2.messages.filter((m) => m.content !== SNIP_BOUNDARY_CONTENT),
    { keepRecentToolResults: 1 },
  )
  // chain 已含 micro：最近 1 条 tool 保留
  const toolMsgs = prep2.messages.filter((m) => m.role === 'tool')
  if (toolMsgs.length >= 2) {
    assert(
      toolMsgs.some((m) => m.content === 'NEW_KEEP') ||
        toolMsgs[toolMsgs.length - 1]?.content === 'NEW_KEEP',
      'recent tool kept after micro',
    )
  }
  assert(microOnly.messages.length > 0, 'micro still works standalone')

  // ── 5) false 关闭 ──
  const off = createSnipPrepare(false)
  const rOff = await off({
    messages: fat,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(rOff.didCompact !== true, 'snip false → no compact')
  assert(rOff.messages === fat || rOff.messages.length === fat.length, 'unchanged')

  console.log('OK test-snip')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})