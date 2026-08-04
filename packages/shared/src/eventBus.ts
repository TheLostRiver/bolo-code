/**
 * EVT-1 · 轻量事件总线（无外部依赖）
 *
 * 发布/订阅/取消订阅 + 按 key 保留最近状态（replay——resume 时新订阅者
 * 拿到最新状态，不丢更新）。纯契约，可测。
 */
export type EventBus<EventKey extends string, TValue> = {
  /** 订阅；返回取消函数 */
  subscribe: (
    key: EventKey,
    fn: (value: TValue) => void,
  ) => () => void
  /** 发布事件（通知该 key 的所有订阅者；保留为最近状态） */
  emit: (key: EventKey, value: TValue) => void
  /** 把每个 key 的最近状态同步给 fn（replay）；无状态则跳过 */
  replay: (fn: (key: EventKey, value: TValue) => void) => void
  /** 当前状态快照（测试/诊断） */
  snapshot: () => Map<EventKey, TValue>
}

export function createEventBus<
  EventKey extends string,
  TValue,
>(): EventBus<EventKey, TValue> {
  const listeners = new Map<EventKey, Set<(value: TValue) => void>>()
  const lastValues = new Map<EventKey, TValue>()

  return {
    subscribe(key, fn) {
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(fn)
      return () => {
        set!.delete(fn)
        if (set!.size === 0) listeners.delete(key)
      }
    },
    emit(key, value) {
      lastValues.set(key, value)
      const set = listeners.get(key)
      if (!set) return
      for (const fn of [...set]) {
        // 订阅者抛错隔离：一个订阅者异常不影响其余（错误隔离语义）
        try {
          fn(value)
        } catch {
          /* 订阅者错误被隔离（与 watcher 错误隔离同语义） */
        }
      }
    },
    replay(fn) {
      for (const [key, value] of lastValues) {
        fn(key, value)
      }
    },
    snapshot() {
      return new Map(lastValues)
    },
  }
}
