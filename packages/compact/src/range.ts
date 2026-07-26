/**
 * AR2A1 · partial compact 的 range / watermark 契约
 *
 * 现有 compact 是**单切点**模型（`splitMessagesForCompactKeep`），只能压缩前缀。
 * partial compact 要能压缩任意区间，于是必须先回答四个问题：
 *
 * ① 一个区间**合法**吗（`validateCompactRange`）
 * ② 哪些已经被摘要过了（`deriveCompactWatermark`）
 * ③ 哪些**绝不能**被摘要（`findAtomicBlocks` + `preserveTailCount`）
 * ④ 不合法时**为什么**（`CompactRangeRejection`）
 *
 * **本模块全是纯函数，不改入参。** compact 一旦就地改了历史，任何回退都失效。
 * 本刀只定契约与测试，不接 provider、不改 `runFullCompact`。
 *
 * ## 为什么 watermark 是推导的而不是存储的
 *
 * 参考实现用 `lastSummarizedMessageId` 这类稳定 id 标记「已摘要到哪」。
 * Bolo 的 `ChatMessage` **没有 id 字段**，而 compact rewrite 会移动下标——
 * 存下标必然漂移，存指纹则要处理重算与失效。
 *
 * 但 compact 总会插入一条可判别的 summary 消息（`isCompactSummaryMessage`），
 * 所以「已摘要到哪」可以直接从消息表**推导**。推导值不可能与实际历史不一致，
 * 这比任何存储方案都强。
 *
 * 代价：无法区分同一位置的两次不同摘要。可接受——契约只需回答
 * 「这段是否已被某次摘要覆盖」，不需要溯源是哪一次。
 */

import type { ChatMessage } from '../../shared/src/index.ts'
import { isCompactSummaryMessage } from './index.ts'

/** 半开区间 `[start, end)`，下标指向消息表 */
export type MessageRange = {
  start: number
  end: number
}

/**
 * 已摘要水位。
 * `summarizedThrough` 之前（不含）的消息都已被某条 summary 代表。
 */
export type CompactWatermark = {
  summarizedThrough: number
  /** 推导所依据的那条 summary 的下标；无 summary 时为 -1 */
  summaryIndex: number
}

export type CompactRangeRejection =
  | 'inverted'
  | 'out_of_bounds'
  | 'empty'
  | 'already_summarized'
  | 'reserved_tail'

export type CompactRangeCheck =
  | {
      ok: true
      range: MessageRange
      /**
       * 区间是否为避开原子块而被移动过。
       *
       * **必须如实上报。** 静默返回一个与请求不同的区间，会让调用方
       * 以为压缩了 A 实际压缩了 B —— 比直接拒绝危险得多。
       */
      snapped: boolean
    }
  | { ok: false; reason: CompactRangeRejection; detail: string }

export type CompactRangeOptions = {
  /** 末尾保留多少条消息不参与摘要（最新内容不该被压掉） */
  preserveTailCount?: number
}

export type CompactPlanRejection = CompactRangeRejection | 'nothing_to_compact'

export type CompactPlan =
  | { ok: true; range: MessageRange; snapped: boolean }
  | { ok: false; reason: CompactPlanRejection; detail: string }

function reject(
  reason: CompactRangeRejection,
  detail: string,
): { ok: false; reason: CompactRangeRejection; detail: string } {
  return { ok: false, reason, detail }
}

/**
 * 找出所有**不可拆分**的原子块。
 *
 * 目前唯一的原子块是 tool pair：带 `tool_calls` 的 assistant 消息，
 * 加上紧随其后、`tool_call_id` 与之匹配的全部 tool 结果。
 *
 * 拆开它会留下一条有 `tool_calls` 却没有对应结果的 assistant 消息 ——
 * 多数 provider 对此直接 400。这是 compact 改动里最容易造成
 * **不可恢复损坏**的一处，所以单独成为一等概念而不是散落的边界判断。
 */
export function findAtomicBlocks(messages: readonly ChatMessage[]): MessageRange[] {
  const blocks: MessageRange[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (!m.tool_calls?.length) continue
    const wanted = new Set(m.tool_calls.map((t) => t.id))
    let end = i + 1
    // 只吸收紧随其后的 tool 结果；中间插入别的角色即视为块结束
    while (end < messages.length) {
      const next = messages[end]!
      if (next.role !== 'tool') break
      // 不匹配的 tool 结果也收进来：它同样不能被单独留下
      if (next.tool_call_id) wanted.delete(next.tool_call_id)
      end++
    }
    blocks.push({ start: i, end })
  }
  return blocks
}

/**
 * 把区间吸附到原子块边界之外。
 * 区间端点落在某个块**内部**时，向外扩到块边界。
 */
function snapToAtomicBlocks(
  messages: readonly ChatMessage[],
  range: MessageRange,
): { range: MessageRange; snapped: boolean } {
  let { start, end } = range
  let snapped = false
  for (const b of findAtomicBlocks(messages)) {
    // start 落在块中间 → 回退到块首
    if (start > b.start && start < b.end) {
      start = b.start
      snapped = true
    }
    // end 落在块中间 → 前进到块尾
    if (end > b.start && end < b.end) {
      end = b.end
      snapped = true
    }
  }
  return { range: { start, end }, snapped }
}

/**
 * 从消息表推导已摘要水位。见文件头「为什么是推导的」。
 * 以**最新**一条 summary 为准：旧 summary 不该压低水位。
 */
export function deriveCompactWatermark(
  messages: readonly ChatMessage[],
): CompactWatermark {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactSummaryMessage(messages[i]!)) {
      return { summarizedThrough: i + 1, summaryIndex: i }
    }
  }
  return { summarizedThrough: 0, summaryIndex: -1 }
}

/**
 * 校验一个待压缩区间。
 *
 * 拒绝是结构化的（`reason` + `detail`），不抛异常也不静默修正 ——
 * 调用方需要能分辨「不能压」和「压了但换了范围」。
 */
export function validateCompactRange(
  messages: readonly ChatMessage[],
  range: MessageRange,
  opts: CompactRangeOptions = {},
): CompactRangeCheck {
  const n = messages.length
  const { start, end } = range

  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return reject('out_of_bounds', `range must be integers, got ${start}..${end}`)
  }
  if (start > end) {
    return reject('inverted', `start ${start} is after end ${end}`)
  }
  if (start < 0 || end > n) {
    return reject(
      'out_of_bounds',
      `range ${start}..${end} is outside 0..${n}`,
    )
  }
  if (start === end) {
    return reject('empty', `range ${start}..${end} covers no messages`)
  }

  // 已摘要的部分不能再摘一次：会把同一段内容叙述两遍，
  // 而且每次 compact 都会再叠一层。
  const wm = deriveCompactWatermark(messages)
  if (start < wm.summarizedThrough) {
    return reject(
      'already_summarized',
      `messages before ${wm.summarizedThrough} are already covered by the summary at index ${wm.summaryIndex}`,
    )
  }

  const tail = Math.max(0, Math.floor(opts.preserveTailCount ?? 0))
  if (tail > 0) {
    const tailStart = n - tail
    if (end > tailStart) {
      return reject(
        'reserved_tail',
        `range ends at ${end} but the last ${tail} message(s) from ${tailStart} are preserved`,
      )
    }
  }

  const snappedResult = snapToAtomicBlocks(messages, { start, end })
  // 吸附后可能又撞上保留尾部；此时如实拒绝，不再二次修正
  if (tail > 0 && snappedResult.range.end > n - tail) {
    return reject(
      'reserved_tail',
      `after snapping to a tool-call block the range would reach ${snappedResult.range.end}, inside the preserved tail starting at ${n - tail}`,
    )
  }
  if (snappedResult.range.start < wm.summarizedThrough) {
    return reject(
      'already_summarized',
      `after snapping to a tool-call block the range would start at ${snappedResult.range.start}, before the watermark ${wm.summarizedThrough}`,
    )
  }

  return { ok: true, range: snappedResult.range, snapped: snappedResult.snapped }
}

/**
 * 给出「这次该压哪一段」。
 *
 * 语义：从水位压到保留尾部之前。没有可压的内容时**明确拒绝**，
 * 而不是返回一个空区间让调用方自己判断——空区间是最容易被当成
 * 「压成功了」的返回值。
 */
export function planPartialCompact(
  messages: readonly ChatMessage[],
  opts: CompactRangeOptions = {},
): CompactPlan {
  const n = messages.length
  const wm = deriveCompactWatermark(messages)
  const tail = Math.max(0, Math.floor(opts.preserveTailCount ?? 0))
  const start = wm.summarizedThrough
  const end = Math.max(start, n - tail)

  if (start >= end) {
    return {
      ok: false,
      reason: 'nothing_to_compact',
      detail:
        n === 0
          ? 'no messages'
          : `everything before ${start} is already summarized and the last ${tail} message(s) are preserved`,
    }
  }

  const v = validateCompactRange(messages, { start, end }, opts)
  if (!v.ok) return v
  return { ok: true, range: v.range, snapped: v.snapped }
}
