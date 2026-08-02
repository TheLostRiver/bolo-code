/**
 * TERM-2: 输入 CSI 分片重组纯逻辑。
 *
 * 问题：底层 StdinBuffer 对不完整 CSI 序列（如 `\x1b[>7721`、`\x1b[<0;20`）
 * 缓冲 10ms 后会把残余作为独立 data 事件 flush，慢链路/分片终端下这些
 * 碎片会泄漏进输入处理（被当普通按键/文本）。
 *
 * 方案：在 adapter 的输入路径前加一层重组状态机——
 * - `\x1b[` 开头的非完整序列进入 pending 缓冲，等待续段拼完整；
 * - 续段（数字/`;`/`<`/`>`/`?` 等参数与中间字节开头）追加进 pending；
 * - 拼完整后作为单个序列交给下游（拦截/转发）；
 * - 超时未完整 → fail-closed 整体丢弃（不进入输入框）；
 * - 新 `\x1b` 开头（新序列开始）或普通文本 → 丢弃 pending 并处理新数据。
 *
 * 纯逻辑、无 timer；调用方负责在超时点调用 tick()。
 */
const CSI_START = '\x1b['
const CSI_FINAL_MIN = 0x40
const CSI_FINAL_MAX = 0x7e
const CSI_INTERMEDIATE_RE = /^[\x20-\x2f]/u
const CSI_PARAM_RE = /^[\d;<>?=!:]/u
const SGR_MOUSE_RE = /^<\d+;\d+;\d+[Mm]$/u

/** pending 长度上限：超限 fail-closed 丢弃，防攻击性输入无界增长。 */
export const MAX_CSI_REASSEMBLY_PENDING_CHARS = 256

/** tick 丢弃后的续段吞并窗口：防「第二半」碎片泄漏进输入。 */
export const CSI_REASSEMBLY_EXPIRED_SINK_MS = 50

/** Bolo 版 CSI 完整性判定：`ESC [` 起，payload 以最终字节 0x40-0x7e 终结。 */
export function isCompleteCsiSequence(data: string): boolean {
  if (!data.startsWith(CSI_START)) return false
  const payload = data.slice(2)
  if (payload.length === 0) return false
  if (payload.startsWith('<')) {
    // SGR mouse（1006）：`<b;x;yM|m`；部分实现省略分号段，按参数判定
    if (SGR_MOUSE_RE.test(payload)) return true
    const last = payload.charCodeAt(payload.length - 1)
    if (last === 0x4d || last === 0x6d) {
      return /^<\d+(?:;\d+)*[Mm]$/u.test(payload)
    }
    return false
  }
  const last = payload.charCodeAt(payload.length - 1)
  return last >= CSI_FINAL_MIN && last <= CSI_FINAL_MAX
}

/** 是否 CSI 起点（`ESC [` 开头；不含单独 ESC 键）。 */
export function isCsiStart(data: string): boolean {
  return data.startsWith(CSI_START)
}

/** 是否为 CSI 续段（参数/中间字节/终结符开头，且不含 ESC——新序列会另起）。 */
export function isCsiContinuation(data: string): boolean {
  if (data.length === 0) return false
  if (data.startsWith('\x1b')) return false
  const first = data.charCodeAt(0)
  if (first >= CSI_FINAL_MIN && first <= CSI_FINAL_MAX) return true
  return CSI_PARAM_RE.test(data) || CSI_INTERMEDIATE_RE.test(data)
}

export type CsiReassemblerOptions = {
  /** pending 存活窗口（毫秒）；超时整体丢弃 */
  timeoutMs?: number
  now?: () => number
}

export const DEFAULT_CSI_REASSEMBLY_TIMEOUT_MS = 50

export class CsiReassembler {
  private pending: string | undefined
  /** 固定窗口：仅在 pending 建立时设置，续段不刷新（防窗口无限延伸） */
  private pendingDeadline = 0
  /** tick 丢弃后的续段吞并截止（防第二半碎片泄漏） */
  private expiredUntil = 0
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(options: CsiReassemblerOptions = {}) {
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_CSI_REASSEMBLY_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
  }

  hasPending(): boolean {
    return this.pending !== undefined
  }

  /**
   * 喂入一段输入；返回应转发的完整序列（有序）。未完成的片段保留在
   * pending（固定 50ms 窗口、长度上限 256，续段不刷新）；超时或超限
   * fail-closed 丢弃，并进入短暂的续段吞并窗口防「第二半」泄漏。
   * 新 `\x1b` 开头或非续段会先丢弃 pending。
   */
  push(data: string): string[] {
    if (data.length === 0) return []
    const now = this.now()
    // 先处理超时（含设置续段吞并窗口），再查 sink——覆盖本次刚丢弃的场景
    if (this.pending !== undefined && now > this.pendingDeadline) {
      this.pending = undefined
      this.expiredUntil = now + CSI_REASSEMBLY_EXPIRED_SINK_MS
    }
    if (now <= this.expiredUntil && isCsiContinuation(data)) return []
    if (this.pending === undefined) {
      if (!isCsiStart(data)) return [data]
      if (isCompleteCsiSequence(data)) return [data]
      if (data.length > MAX_CSI_REASSEMBLY_PENDING_CHARS) {
        this.expiredUntil = now + CSI_REASSEMBLY_EXPIRED_SINK_MS
        return []
      }
      this.pending = data
      this.pendingDeadline = now + this.timeoutMs
      return []
    }
    // pending 存在：续段拼接；否则丢弃 pending 并按新数据重新判定
    if (!isCsiContinuation(data)) {
      this.pending = undefined
      return this.push(data)
    }
    const merged = this.pending + data
    if (merged.length > MAX_CSI_REASSEMBLY_PENDING_CHARS) {
      this.pending = undefined
      this.expiredUntil = now + CSI_REASSEMBLY_EXPIRED_SINK_MS
      return []
    }
    if (isCompleteCsiSequence(merged)) {
      this.pending = undefined
      return [merged]
    }
    // 固定窗口：续段不刷新 deadline（超时已在入口统一处理），继续累积
    this.pending = merged
    return []
  }

  /** 超时点调用：丢弃未完成的 pending（fail-closed，不转发）。 */
  tick(): void {
    if (this.pending === undefined) return
    if (this.now() > this.pendingDeadline) {
      this.pending = undefined
      this.expiredUntil =
        this.now() + CSI_REASSEMBLY_EXPIRED_SINK_MS
    }
  }

  /** 显式清空（releaseInput/stop）；返回是否丢弃了未完成片段。 */
  reset(): boolean {
    const dropped = this.pending !== undefined
    this.pending = undefined
    this.expiredUntil = 0
    return dropped
  }
}
