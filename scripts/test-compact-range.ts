/**
 * AR2A1 · partial compact 的 range / watermark 契约
 *
 * 现在的 compact 是**单切点**模型：`[toSummarize | messagesToKeep]`，
 * 只能压缩前缀。partial compact 要能压缩任意区间，于是必须先回答四个问题：
 *
 * ① 一个区间**合法**吗（range）
 * ② 哪些已经被摘要过了（watermark）
 * ③ 哪些**绝不能**被摘要（保留区间）
 * ④ 不合法时**为什么**（拒绝原因）
 *
 * 本刀只做纯契约，不接 provider、不改 runFullCompact。
 *
 * 三条断言背后各是一种真实的历史损坏：
 *
 * - **拆开 tool pair** → 留下 `tool_calls` 却没有对应结果，多数 provider 硬 400。
 *   这是 compact 改动里最容易造成不可恢复损坏的一处。
 * - **重复摘要同一段** → 内容被叙述两遍，且每次 compact 都会再叠一层。
 * - **静默截断** → 返回一个「看起来合理」的区间而不说明它被改过，
 *   调用方以为压缩了 A 实际压缩了 B。所以吸附必须显式标记。
 *
 * 运行：npx tsx scripts/test-compact-range.ts
 */
import {
  COMPACT_SUMMARY_MARKER,
  deriveCompactWatermark,
  findAtomicBlocks,
  planPartialCompact,
  validateCompactRange,
  type MessageRange,
} from '../packages/compact/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const u = (c: string): ChatMessage => ({ role: 'user', content: c })
const a = (c: string): ChatMessage => ({ role: 'assistant', content: c })
const callMsg = (id: string): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, name: 'Bash', arguments: '{}' }],
})
const resultMsg = (id: string): ChatMessage => ({
  role: 'tool',
  content: 'out',
  tool_call_id: id,
})
const summaryMsg = (): ChatMessage => ({
  role: 'user',
  content: `${COMPACT_SUMMARY_MARKER} that ran out of context.\n\nprior summary`,
})

/** 0:u 1:a 2:call 3:result 4:a 5:u 6:a */
const BASE: ChatMessage[] = [
  u('q1'),
  a('a1'),
  callMsg('c1'),
  resultMsg('c1'),
  a('after tool'),
  u('q2'),
  a('a2'),
]

function r(start: number, end: number): MessageRange {
  return { start, end }
}

function main() {
  // ── 1) 原子块：tool call 与它的结果是一个整体 ──
  {
    const blocks = findAtomicBlocks(BASE)
    const pair = blocks.find((b) => b.start === 2)
    assert(pair, `the assistant tool_calls at 2 starts an atomic block: ${JSON.stringify(blocks)}`)
    assert(
      pair!.end === 4,
      `the block covers the call and its result [2,4): got ${JSON.stringify(pair)}`,
    )
    // 多结果：一次 call 多个 result 也要整体收进来
    const multi: ChatMessage[] = [
      u('q'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'x', name: 'Bash', arguments: '{}' },
          { id: 'y', name: 'Read', arguments: '{}' },
        ],
      },
      resultMsg('x'),
      resultMsg('y'),
      a('done'),
    ]
    const mb = findAtomicBlocks(multi).find((b) => b.start === 1)
    assert(
      mb?.end === 4,
      `a call with two results is one block [1,4): got ${JSON.stringify(mb)}`,
    )
  }

  // ── 2) 合法区间原样通过，且不谎称被吸附过 ──
  {
    const v = validateCompactRange(BASE, r(0, 2))
    assert(v.ok, `a clean range passes: ${JSON.stringify(v)}`)
    assert(
      v.ok && v.range.start === 0 && v.range.end === 2,
      `range unchanged: ${JSON.stringify(v)}`,
    )
    assert(v.ok && v.snapped === false, 'not marked as snapped when nothing moved')
  }

  // ── 3) 拆开 tool pair 必须被处理，且**显式说明**发生了什么 ──
  // 静默扩边比拒绝更危险：调用方以为压了 [0,3) 实际压了 [0,4)。
  {
    const v = validateCompactRange(BASE, r(0, 3))
    assert(v.ok, `splitting a pair is repairable, not fatal: ${JSON.stringify(v)}`)
    assert(
      v.ok && v.range.end === 4,
      `the range snaps out to include the tool result: ${JSON.stringify(v)}`,
    )
    assert(
      v.ok && v.snapped === true,
      'snapping must be reported — silently returning a different range than asked is the dangerous case',
    )
    // 反向：从 pair 中间开始
    const v2 = validateCompactRange(BASE, r(3, 6))
    assert(v2.ok && v2.range.start === 2, `snaps back to the call: ${JSON.stringify(v2)}`)
    assert(v2.ok && v2.snapped === true, 'reports the backward snap too')
  }

  // ── 4) 空范围与越界：给结构化拒绝原因，不是 throw、不是静默 ──
  {
    const bad: Array<[string, MessageRange]> = [
      ['empty', r(2, 2)],
      ['inverted', r(4, 1)],
      ['negative start', r(-1, 3)],
      ['end past the list', r(0, 99)],
      ['start past the list', r(99, 100)],
    ]
    for (const [label, range] of bad) {
      const v = validateCompactRange(BASE, range)
      assert(!v.ok, `rejects ${label}`)
      assert(!v.ok && !!v.reason, `${label} carries a machine-readable reason`)
      assert(
        !v.ok && typeof v.detail === 'string' && v.detail.length > 0,
        `${label} explains itself`,
      )
    }
  }

  // ── 5) watermark 从消息表**推导**，不存储 ──
  // 存下标必然在 rewrite 后漂移；推导出来的不可能与历史不一致。
  {
    const none = deriveCompactWatermark(BASE)
    assert(
      none.summarizedThrough === 0,
      `no summary yet means nothing is covered: ${JSON.stringify(none)}`,
    )

    // compact 之后的形状：summary 顶在前面
    const after: ChatMessage[] = [summaryMsg(), u('q2'), a('a2')]
    const w = deriveCompactWatermark(after)
    assert(
      w.summarizedThrough === 1,
      `everything up to and including the summary is covered: ${JSON.stringify(w)}`,
    )

    // 中段 partial compact：summary 落在中间
    const mid: ChatMessage[] = [u('q0'), summaryMsg(), u('q2'), a('a2')]
    assert(
      deriveCompactWatermark(mid).summarizedThrough === 2,
      'watermark tracks the newest summary, wherever it sits',
    )

    // 多个 summary：以**最新的**为准，不是第一个
    const two: ChatMessage[] = [summaryMsg(), u('x'), summaryMsg(), a('y')]
    assert(
      deriveCompactWatermark(two).summarizedThrough === 3,
      'the newest summary wins — an older one does not cap the watermark',
    )
  }

  // ── 6) 幂等 / 重复 compact：已覆盖的区间要被拒 ──
  {
    const after: ChatMessage[] = [summaryMsg(), u('q2'), a('a2')]
    const v = validateCompactRange(after, r(0, 1))
    assert(
      !v.ok,
      'summarizing an already-summarized region again would narrate it twice',
    )
    assert(!v.ok && v.reason === 'already_summarized', `reason: ${JSON.stringify(v)}`)

    // 跨越 watermark 的区间同样拒绝：部分重复也是重复
    const v2 = validateCompactRange(after, r(0, 3))
    assert(!v2.ok, 'a range straddling the watermark is rejected too')

    // watermark 之后的区间正常放行
    const v3 = validateCompactRange(after, r(1, 3))
    assert(v3.ok, `fresh region after the watermark is fine: ${JSON.stringify(v3)}`)
  }

  // ── 7) 保留尾部：最新的内容不能被摘要掉 ──
  {
    const v = validateCompactRange(BASE, r(0, 7), { preserveTailCount: 2 })
    assert(!v.ok, 'a range eating into the preserved tail is rejected')
    assert(!v.ok && v.reason === 'reserved_tail', `reason: ${JSON.stringify(v)}`)
    const okRange = validateCompactRange(BASE, r(0, 5), { preserveTailCount: 2 })
    assert(okRange.ok, `stopping before the tail is fine: ${JSON.stringify(okRange)}`)
  }

  // ── 8) planPartialCompact：给出可执行的计划或明确的「不用压」 ──
  {
    const plan = planPartialCompact(BASE, { preserveTailCount: 2 })
    assert(plan.ok, `produces a plan: ${JSON.stringify(plan)}`)
    assert(
      plan.ok && plan.range.end <= BASE.length - 2,
      `the plan respects the preserved tail: ${JSON.stringify(plan)}`,
    )
    assert(
      plan.ok && plan.range.start === 0,
      `partial compact still starts from the watermark: ${JSON.stringify(plan)}`,
    )

    // 全部已摘要 → 明确说「没有可压的」，而不是给一个空区间让调用方自己猜
    const done: ChatMessage[] = [summaryMsg(), u('q'), a('r')]
    const p2 = planPartialCompact(done, { preserveTailCount: 2 })
    assert(!p2.ok, 'nothing left to compact is a refusal, not an empty range')
    assert(
      !p2.ok && p2.reason === 'nothing_to_compact',
      `reason says so plainly: ${JSON.stringify(p2)}`,
    )
  }

  // ── 9) 纯函数：不得改动入参 ──
  // compact 一旦就地改了历史，任何回退都失效。
  {
    const snapshot = JSON.stringify(BASE)
    validateCompactRange(BASE, r(0, 3))
    findAtomicBlocks(BASE)
    deriveCompactWatermark(BASE)
    planPartialCompact(BASE, { preserveTailCount: 2 })
    assert(
      JSON.stringify(BASE) === snapshot,
      'the contract never mutates the message list — rollback depends on it',
    )
  }

  // ── 10) 空消息表不炸 ──
  {
    assert(deriveCompactWatermark([]).summarizedThrough === 0, 'empty list has no watermark')
    assert(findAtomicBlocks([]).length === 0, 'empty list has no blocks')
    assert(!validateCompactRange([], r(0, 1)).ok, 'empty list rejects any range')
    assert(!planPartialCompact([], {}).ok, 'empty list has nothing to compact')
  }

  console.log('PASS: compact range contract')
}

main()
