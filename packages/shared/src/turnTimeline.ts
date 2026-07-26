/**
 * AR3B · turn timeline 视图模型（纯函数）
 *
 * 桌面端现在的历史回看是坏的：`listMessages` 把消息拍平成 `slice(0, 4000)`
 * 字符串，工具调用、diff、reasoning 一律丢失，重载后只剩 role + 文本。
 *
 * core 侧零件都在（`messagesFromTranscriptEntries`、
 * `fileDiffsFromTranscriptEntries`、`projectDurableTurns`），缺的是把它们
 * **缝成按 turn 分组的时间线**。缝合是视图模型的活，落在 packages 而非
 * renderer——薄壳纪律要求 renderer 只渲染，不重算。
 *
 * ## 三条防「显示出没发生过的事」的语义
 *
 * **① compact summary 不是用户说的话。** 它的 role 就是 `'user'`，
 * 照 role 渲染成用户气泡，用户会看到自己从没说过的话被算在自己头上。
 *
 * **② 没有结果的工具调用照样显示。** 调用发出去了、进程崩了或还在跑，
 * 都属于「发生过」。因为配不上结果就丢掉，等于告诉用户那次调用不存在。
 *
 * **③ 不给缺失的结果编内容。** 标成未完成，而不是填一个空字符串——
 * 空字符串会被读成「它返回了空」，那是两回事。
 */

import type { ChatMessage } from './index.ts'

/** compact 产生的 summary 消息前缀（与 compact 包同一字面量） */
const COMPACT_SUMMARY_MARKER =
  'This session is being continued from a previous conversation'

export type TimelineFileDiff = {
  path: string
  tool: string
  added: number
  removed: number
  /** 归属的 turn 序号；缺省表示未归属 */
  turn?: number
  kind?: string
  op?: string
}

export type TimelineItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; reasoning?: string }
  /** compact 摘要——**不是**用户输入，单独成类 */
  | { kind: 'summary'; text: string }
  | {
      kind: 'tool'
      callId: string
      name: string
      argumentsJson?: string
      /** 缺省表示**还没有结果**，不是「结果为空」 */
      output?: string
      /** 是否已配到结果 */
      complete: boolean
    }
  | {
      kind: 'diff'
      path: string
      tool: string
      added: number
      removed: number
      /** true = 该 diff 的 turn 号在消息里找不到对应 turn */
      unattributed?: boolean
    }

export type TimelineTurn = {
  index: number
  items: TimelineItem[]
}

export type BuildTurnTimelineOptions = {
  messages: readonly ChatMessage[]
  fileDiffs?: readonly TimelineFileDiff[]
}

function isSummary(m: ChatMessage): boolean {
  return m.role === 'user' && m.content.startsWith(COMPACT_SUMMARY_MARKER)
}

export function buildTurnTimeline(
  opts: BuildTurnTimelineOptions,
): TimelineTurn[] {
  const turns: TimelineTurn[] = []
  let current: TimelineTurn | undefined

  /**
   * resume 后历史可能从 assistant 开头。此时先开一个 turn 收住它，
   * 否则那些内容会被丢掉——「首条不是 user」不该等于「这些没发生过」。
   */
  const ensureTurn = (): TimelineTurn => {
    if (!current) {
      current = { index: turns.length, items: [] }
      turns.push(current)
    }
    return current
  }

  // 先按 tool_call_id 收齐结果，再回填；结果的顺序不保证与调用一致，
  // 按顺序配对会张冠李戴
  const resultById = new Map<string, string>()
  for (const m of opts.messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      resultById.set(m.tool_call_id, m.content ?? '')
    }
  }

  for (const m of opts.messages) {
    if (m.role === 'tool') continue // 已在上面收好，不单独成项

    if (isSummary(m)) {
      ensureTurn().items.push({ kind: 'summary', text: m.content })
      continue
    }

    if (m.role === 'user') {
      current = { index: turns.length, items: [] }
      turns.push(current)
      current.items.push({ kind: 'user', text: m.content })
      continue
    }

    const turn = ensureTurn()

    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const has = resultById.has(tc.id)
        turn.items.push({
          kind: 'tool',
          callId: tc.id,
          name: tc.name,
          ...(tc.arguments ? { argumentsJson: tc.arguments } : {}),
          // 缺结果时**不填** output：空字符串会被读成「返回了空」
          ...(has ? { output: resultById.get(tc.id)! } : {}),
          complete: has,
        })
      }
    }

    if (m.content?.trim() || m.reasoning_content?.trim()) {
      turn.items.push({
        kind: 'assistant',
        text: m.content ?? '',
        ...(m.reasoning_content?.trim()
          ? { reasoning: m.reasoning_content }
          : {}),
      })
    }
  }

  for (const d of opts.fileDiffs ?? []) {
    const target =
      d.turn != null && d.turn >= 0 && d.turn < turns.length
        ? turns[d.turn]!
        : turns[turns.length - 1]
    if (!target) {
      // 一条消息都没有却有 diff：仍要显示，否则等于隐瞒改动
      const t: TimelineTurn = { index: 0, items: [] }
      turns.push(t)
      t.items.push({ ...toDiffItem(d), unattributed: true })
      continue
    }
    const outOfRange = d.turn != null && (d.turn < 0 || d.turn >= turns.length)
    target.items.push({
      ...toDiffItem(d),
      // turn 号指向不存在的 turn 时如实标注：丢了等于隐瞒改动，
      // 静默错放等于把改动算到别的 turn 头上
      ...(outOfRange ? { unattributed: true } : {}),
    })
  }

  return turns
}

function toDiffItem(d: TimelineFileDiff): Extract<TimelineItem, { kind: 'diff' }> {
  return {
    kind: 'diff',
    path: d.path,
    tool: d.tool,
    added: d.added,
    removed: d.removed,
  }
}
