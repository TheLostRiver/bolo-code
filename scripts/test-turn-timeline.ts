/**
 * AR3B · turn timeline 视图模型（纯函数，packages-first）
 *
 * 桌面端现在的历史回看是坏的：`listMessages` 把消息拍平成
 * `slice(0, 4000)` 字符串，工具调用、diff、reasoning 一律丢失，
 * 重新加载后只剩 role + 文本（`docs/DESKTOP_DESIGN.md` §1）。
 *
 * core 侧的零件都在（`messagesFromTranscriptEntries`、
 * `fileDiffsFromTranscriptEntries`、`projectDurableTurns`），
 * 但**没有一个把它们缝成「按 turn 分组的时间线」的投影**。缝合是视图模型的活，
 * 必须落在 packages 而非 renderer——薄壳纪律。
 *
 * ## 三条防「显示出没发生过的事」的语义
 *
 * **① compact summary 不是用户说的话。** 它的 role 就是 `'user'`，
 * 若按 role 渲染成用户气泡，用户会看到自己从没说过的话被算在自己头上。
 * 必须单独成一类。
 *
 * **② 没有结果的工具调用要照样显示。** 调用发出去了、进程崩了或还在跑，
 * 都属于「发生过」。因为配不上结果就把它丢掉，等于告诉用户那次调用不存在。
 *
 * **③ 不给结果编内容。** 缺结果就标成未完成，不填空字符串冒充「返回了空」。
 *
 * 运行：npx tsx scripts/test-turn-timeline.ts
 */
import { buildTurnTimeline } from '../packages/shared/src/turnTimeline.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const u = (c: string): ChatMessage => ({ role: 'user', content: c })
const a = (c: string): ChatMessage => ({ role: 'assistant', content: c })
const call = (id: string, name = 'Read'): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, name, arguments: JSON.stringify({ path: 'a.ts' }) }],
})
const result = (id: string, out = 'file body'): ChatMessage => ({
  role: 'tool',
  content: out,
  tool_call_id: id,
})
const SUMMARY_MARKER = 'This session is being continued from a previous conversation'
const summary = (): ChatMessage => ({
  role: 'user',
  content: `${SUMMARY_MARKER} that ran out of context.\n\nprior work`,
})

function main() {
  // ── 1) 按 user 消息切 turn ──
  {
    const turns = buildTurnTimeline({
      messages: [u('q1'), a('a1'), u('q2'), a('a2')],
    })
    assert(turns.length === 2, `two user messages make two turns, got ${turns.length}`)
    assert(turns[0]!.index === 0 && turns[1]!.index === 1, 'turns are indexed')
    assert(
      turns[0]!.items[0]!.kind === 'user',
      `each turn starts with the user item: ${JSON.stringify(turns[0]!.items[0])}`,
    )
  }

  // ── 2) compact summary **不得**渲染成用户消息 ──
  // 它的 role 就是 'user'，照 role 渲染会让用户看到自己从没说过的话。
  {
    const turns = buildTurnTimeline({ messages: [summary(), u('q'), a('r')] })
    const kinds = turns.flatMap((t) => t.items.map((i) => i.kind))
    assert(
      kinds.includes('summary'),
      `a compact summary gets its own kind: ${kinds.join(',')}`,
    )
    const userItems = turns
      .flatMap((t) => t.items)
      .filter((i) => i.kind === 'user')
    assert(
      userItems.length === 1,
      `only the real user message counts as user, got ${userItems.length}`,
    )
    assert(
      !userItems.some((i) => (i as { text: string }).text.includes(SUMMARY_MARKER)),
      'the summary text is never attributed to the user',
    )
  }

  // ── 3) 工具调用与结果配对 ──
  {
    const turns = buildTurnTimeline({
      messages: [u('q'), call('c1'), result('c1', 'OUT'), a('done')],
    })
    const tools = turns[0]!.items.filter((i) => i.kind === 'tool')
    assert(tools.length === 1, `one tool item, got ${tools.length}`)
    const t = tools[0] as { name: string; output?: string; complete: boolean }
    assert(t.name === 'Read', `carries the tool name: ${t.name}`)
    assert(t.output === 'OUT', `carries the result: ${t.output}`)
    assert(t.complete === true, 'marked complete')
  }

  // ── 4) 没有结果的调用**照样显示**，且标成未完成 ──
  // 进程崩了或还在跑，都属于「发生过」。丢掉它等于告诉用户那次调用不存在。
  {
    const turns = buildTurnTimeline({ messages: [u('q'), call('c9')] })
    const tools = turns[0]!.items.filter((i) => i.kind === 'tool')
    assert(
      tools.length === 1,
      'a call with no result is still shown — dropping it hides that the tool ran',
    )
    const t = tools[0] as { complete: boolean; output?: string }
    assert(t.complete === false, 'and is marked incomplete')
    assert(
      t.output === undefined,
      'with no fabricated output — an empty string would read as "it returned nothing"',
    )
  }

  // ── 5) 一次调用多个工具 ──
  {
    const multi: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'x', name: 'Read', arguments: '{}' },
        { id: 'y', name: 'Grep', arguments: '{}' },
      ],
    }
    const turns = buildTurnTimeline({
      messages: [u('q'), multi, result('x', 'RX'), result('y', 'RY')],
    })
    const tools = turns[0]!.items.filter((i) => i.kind === 'tool') as Array<{
      name: string
      output?: string
    }>
    assert(tools.length === 2, `both calls appear, got ${tools.length}`)
    assert(
      tools.find((t) => t.name === 'Grep')?.output === 'RY',
      'results are matched by id, not by order',
    )
  }

  // ── 6) file diff 按 turn 归位 ──
  {
    const turns = buildTurnTimeline({
      messages: [u('q1'), a('a1'), u('q2'), a('a2')],
      fileDiffs: [
        { path: 'src/x.ts', tool: 'Edit', added: 3, removed: 1, turn: 1 },
        { path: 'src/y.ts', tool: 'Write', added: 9, removed: 0, turn: 0 },
      ],
    })
    const t0 = turns[0]!.items.filter((i) => i.kind === 'diff')
    const t1 = turns[1]!.items.filter((i) => i.kind === 'diff')
    assert(t0.length === 1 && t1.length === 1, 'each diff lands in its own turn')
    assert(
      (t0[0] as { path: string }).path === 'src/y.ts',
      `turn 0 gets the turn-0 diff: ${JSON.stringify(t0[0])}`,
    )
  }

  // ── 7) turn 号越界的 diff 不得丢，也不得错放 ──
  // 丢了等于隐瞒改动；错放等于把改动算到别的 turn 头上。
  {
    const turns = buildTurnTimeline({
      messages: [u('q')],
      fileDiffs: [{ path: 'z.ts', tool: 'Edit', added: 1, removed: 0, turn: 99 }],
    })
    const all = turns.flatMap((t) => t.items).filter((i) => i.kind === 'diff')
    assert(
      all.length === 1,
      'a diff pointing at a turn that does not exist is still surfaced, not silently dropped',
    )
  }

  // ── 8) 无 turn 号的 diff 归到最后一个 turn（最可能的归属），但不得凭空造 turn ──
  {
    const turns = buildTurnTimeline({
      messages: [u('q1'), u('q2')],
      fileDiffs: [{ path: 'n.ts', tool: 'Edit', added: 1, removed: 0 }],
    })
    assert(turns.length === 2, `no extra turn is invented, got ${turns.length}`)
    assert(
      turns[1]!.items.some((i) => i.kind === 'diff'),
      'an unattributed diff attaches to the latest turn',
    )
  }

  // ── 9) 首条不是 user 时也不能丢内容 ──
  // resume 后历史可能从 assistant 开头。
  {
    const turns = buildTurnTimeline({ messages: [a('orphan'), u('q'), a('r')] })
    const texts = turns
      .flatMap((t) => t.items)
      .filter((i) => i.kind === 'assistant')
      .map((i) => (i as { text: string }).text)
    assert(
      texts.includes('orphan'),
      `content before the first user message is not dropped: ${texts.join('|')}`,
    )
  }

  // ── 10) 纯函数 + 空输入 ──
  {
    const messages = [u('q'), call('c'), result('c')]
    const before = JSON.stringify(messages)
    buildTurnTimeline({ messages })
    assert(JSON.stringify(messages) === before, 'never mutates its input')
    assert(buildTurnTimeline({ messages: [] }).length === 0, 'empty input is empty')
  }

  console.log('PASS: turn timeline')
}

main()
