/**
 * Auto 模式会话状态（Y1–Y3）
 * 对照 HC autoModeState 语义；会话级、无全局单例强制、无遥测。
 */

export type AutoModeFallback = 'deny' | 'ask'

export type AutoModeState = {
  /** 连续分类失败/超时次数 */
  consecutiveFailures: number
  /** 熔断后为 true：auto 行为降级为 fallback */
  circuitBroken: boolean
  /**
   * 熔断时是否建议将会话 mode 退出 auto（由 setPermissionMode 调用方处理）
   */
  demoteToDefault?: boolean
  /** 最近一次分类说明（本地 /doctor） */
  lastReason?: string
  lastDecision?: 'allow' | 'deny'
  /** 分类失败时：deny（默认）或回退 UI ask */
  fallback: AutoModeFallback
}

export const DEFAULT_AUTO_CIRCUIT_THRESHOLD = 3

export function createAutoModeState(
  fallback: AutoModeFallback = 'deny',
): AutoModeState {
  return {
    consecutiveFailures: 0,
    circuitBroken: false,
    demoteToDefault: false,
    fallback,
  }
}

export function recordAutoClassifySuccess(
  state: AutoModeState,
  decision: 'allow' | 'deny',
  reason: string,
): void {
  state.consecutiveFailures = 0
  state.demoteToDefault = false
  state.lastDecision = decision
  state.lastReason = reason
}

export function recordAutoClassifyFailure(
  state: AutoModeState,
  reason: string,
  threshold = DEFAULT_AUTO_CIRCUIT_THRESHOLD,
): void {
  state.consecutiveFailures += 1
  state.lastDecision = 'deny'
  state.lastReason = reason
  if (state.consecutiveFailures >= threshold) {
    state.circuitBroken = true
    state.demoteToDefault = true
    state.lastReason = `${reason} (circuit open after ${state.consecutiveFailures} failures; demote to default)`
  }
}

export function resetAutoModeCircuit(state: AutoModeState): void {
  state.consecutiveFailures = 0
  state.circuitBroken = false
  state.demoteToDefault = false
}