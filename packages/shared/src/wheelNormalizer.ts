/**
 * TERM-3 · 滚轮滚动规范化
 *
 * SGR 1006 滚轮每个序列只有 1 格方向（无 delta 数值）。把原始 wheel 事件流
 * 规范化为「增量滚动行数」：
 * - **16ms cadence 帧合并**：同一帧（≤16ms 间隔）内的事件合并为一帧量，
 *   抑制事件风暴（trackpad 连续密集序列不再逐事件触发独立滚动）。
 * - **加速度分带**：按帧内事件率分带（低速 1× / 中速 2× / 高速 3×），
 *   帧量 = 帧内事件数 × 带倍率，快速滚动自然加速。
 * - **方向变化开新帧**：帧间/帧内方向反转立即开新帧（用户有意反向滚动，
 *   不丢首格；帧量归零重算）。
 *
 * 每次 push 返回**增量**滚动行数（消费者直接累加即可）；纯函数状态机，
 * 无外部依赖、无遥测。时间戳可注入（测试用）。
 */
export type WheelDirection = 'up' | 'down'

export type WheelNormalizeInput = {
  direction: WheelDirection
  /** 事件到达时间（毫秒）；缺省用 Date.now() */
  at?: number
}

export type WheelNormalizeResult = {
  /** 本次事件新增的滚动行数（0 = 无滚动） */
  scrollLines: number
}

/** 帧窗口（毫秒）：同一窗口内的事件合并为一帧 */
export const WHEEL_CADENCE_MS = 16
/** 帧内事件数上限（单帧最多计入这么多事件，防单帧风暴） */
export const WHEEL_MAX_EVENTS_PER_FRAME = 6

export type WheelNormalizerOptions = {
  cadenceMs?: number
  now?: () => number
}

export type WheelNormalizer = {
  /** 输入一个滚轮事件，返回本次新增的滚动行数（0 = 无滚动） */
  push: (input: WheelNormalizeInput) => WheelNormalizeResult
  /** 强制结束当前帧（后续 push 开新帧） */
  flush: () => WheelNormalizeResult
}

/** 加速度分带：帧内事件数 → 倍率（1-2 事件低速、3-4 中速、5+ 高速） */
export function wheelBandMultiplier(eventsInFrame: number): number {
  if (eventsInFrame <= 2) return 1
  if (eventsInFrame <= 4) return 2
  return 3
}

/** 帧量 = 帧内事件数 × 带倍率 */
function frameLines(eventsInFrame: number): number {
  return eventsInFrame * wheelBandMultiplier(eventsInFrame)
}

export function createWheelNormalizer(
  opts?: WheelNormalizerOptions,
): WheelNormalizer {
  const cadenceMs = opts?.cadenceMs ?? WHEEL_CADENCE_MS
  const now = opts?.now ?? (() => Date.now())
  let frameStart = -Infinity
  let frameDirection: WheelDirection | undefined
  let frameEvents = 0

  return {
    push(input) {
      const at = input.at ?? now()
      const newFrame =
        at - frameStart > cadenceMs ||
        (frameDirection !== undefined && frameDirection !== input.direction)
      if (newFrame) {
        frameStart = at
        frameDirection = input.direction
        frameEvents = 1
        // 新帧首个事件：单事件帧只滚 1 格（逐格滚动语义）
        return { scrollLines: 1 }
      }
      const prevEvents = frameEvents
      frameEvents = Math.min(WHEEL_MAX_EVENTS_PER_FRAME, frameEvents + 1)
      return { scrollLines: frameLines(frameEvents) - frameLines(prevEvents) }
    },
    flush() {
      frameStart = -Infinity
      frameDirection = undefined
      frameEvents = 0
      return { scrollLines: 0 }
    },
  }
}
