/**
 * AR2A2 · compact 切分**永不拆开 tool pair**（穷举性质测试）
 *
 * 这是 AR2A2 验收的第一条：「tool call/result 不拆对」。
 *
 * 拆开的后果是留下一条有 `tool_calls` 却没有对应结果的 assistant 消息，
 * 多数 provider 直接 400 —— 而且是在**压缩之后**才炸，此时原始历史已经被
 * 摘要替换掉，不可恢复。compact 改动里最危险的一处。
 *
 * 接线方式：**用 AR2A1 的契约当裁判去验既有路径**，而不是拿契约把
 * `adjustCutForToolPairing` 换掉。既有实现已在线上跑、有回归覆盖；
 * 契约的价值在于把「不拆对」变成一条被穷举验证的不变量，
 * 而不是再引入一套可能有自己 bug 的新切分逻辑。
 *
 * 注意两者**修复方向相反但都正确**：`adjustCutForToolPairing` 把切点左移
 * （少摘要、多保留原文），契约的 `snapToAtomicBlocks` 向外扩（多摘要）。
 * 二者都能保住配对，此处以既有行为为准，只断言结果不拆对。
 *
 * 穷举 4 种角色 × 长度 1..5 的全部序列 × 全部切点 —— 数千个组合，
 * 覆盖真实会话里可能出现的所有局部形状。
 *
 * 运行：npx tsx scripts/test-compact-split-invariant.ts
 */
import {
  adjustCutForToolPairing,
  findAtomicBlocks,
  splitMessagesForCompactKeep,
} from '../packages/compact/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

type RoleKey = 'user' | 'assistant' | 'tool' | 'assistantTC'
const ROLES: RoleKey[] = ['user', 'assistant', 'tool', 'assistantTC']

function mk(r: RoleKey, i: number): ChatMessage {
  if (r === 'assistantTC') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, name: 'Bash', arguments: '{}' }],
    }
  }
  if (r === 'tool') {
    return { role: 'tool', content: 'out', tool_call_id: `c${i}` }
  }
  return { role: r, content: `m${i}` }
}

function* sequences(n: number): Generator<RoleKey[]> {
  if (n === 0) {
    yield []
    return
  }
  for (const r of ROLES) {
    for (const rest of sequences(n - 1)) yield [r, ...rest]
  }
}

/** 契约当裁判：切点落在任一原子块内部即为拆对 */
function splitsAPair(messages: ChatMessage[], cut: number): boolean {
  return findAtomicBlocks(messages).some((b) => cut > b.start && cut < b.end)
}

function label(seq: RoleKey[]): string {
  return seq.join(',')
}

function main() {
  let combos = 0
  let violations = 0

  // ── 1) adjustCutForToolPairing：任何输入切点都不得产出拆对的切点 ──
  for (let n = 1; n <= 5; n++) {
    for (const seq of sequences(n)) {
      const msgs = seq.map(mk)
      for (let cut = 0; cut <= msgs.length; cut++) {
        const c = adjustCutForToolPairing(msgs, cut)
        combos++
        assert(
          c >= 0 && c <= msgs.length,
          `adjusted cut stays in range for [${label(seq)}] cut=${cut} -> ${c}`,
        )
        if (splitsAPair(msgs, c)) {
          violations++
          console.error(
            `  splits a tool pair: [${label(seq)}] cut=${cut} -> ${c}`,
          )
        }
      }
    }
  }
  assert(
    violations === 0,
    `adjustCutForToolPairing must never leave a tool_calls message without its results (${violations} violation(s) across ${combos} combinations)`,
  )

  // ── 2) splitMessagesForCompactKeep：真正的入口同样不得拆对 ──
  // 只验 adjustCut 不够——调用方还会按 user 轮次分组、按 token 上限回退，
  // 那些路径各有自己的切点计算。
  let splitCombos = 0
  for (let n = 1; n <= 5; n++) {
    for (const seq of sequences(n)) {
      const msgs = seq.map(mk)
      for (const opts of [
        { keepRecentUserTurns: 1 },
        { keepRecentUserTurns: 2 },
        { keepRecentMessageCount: 1 },
        { keepRecentMessageCount: 3 },
        { keepRecentUserTurns: 1, keepMaxTokens: 1 },
      ]) {
        const { toSummarize, messagesToKeep } = splitMessagesForCompactKeep(
          msgs,
          opts,
        )
        splitCombos++
        assert(
          toSummarize.length + messagesToKeep.length === msgs.length,
          `split loses no messages for [${label(seq)}] ${JSON.stringify(opts)}`,
        )
        assert(
          !splitsAPair(msgs, toSummarize.length),
          `split must not break a tool pair: [${label(seq)}] ${JSON.stringify(opts)} cut=${toSummarize.length}`,
        )
      }
    }
  }

  // ── 3) 裁判本身不能是永真的 ──
  // 若 splitsAPair 从不返回 true，上面两段等于什么都没验。
  {
    const msgs = [mk('assistantTC', 0), mk('tool', 0), mk('user', 1)]
    assert(
      splitsAPair(msgs, 1),
      'the oracle really does detect a cut between a call and its result — otherwise the whole test is vacuous',
    )
    assert(!splitsAPair(msgs, 0), 'a cut before the call is fine')
    assert(!splitsAPair(msgs, 2), 'a cut after the result is fine')
  }

  console.log(
    `PASS: compact split invariant (${combos} cut combos, ${splitCombos} split combos)`,
  )
}

main()
