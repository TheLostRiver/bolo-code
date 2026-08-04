/**
 * EVT-1 · 文件 watcher（memory 目录外部编辑同步）
 *
 * - fs.watch 目录 + 事件合并（debounce 100ms——一次写操作多次事件只通知一次）。
 * - 错误隔离：watch 失败（目录不存在/权限/平台不支持）→ 降级
 *   （onState(false) 通知不可用，不抛错不崩主循环）；watch error 事件 →
 *   尝试重启一次，失败则降级。
 * - 返回 stop()（释放 watcher + 清理 timer）。
 */
import { watch, type FSWatcher } from 'node:fs'

export type MemoryWatcher = {
  /** 目录变更通知（debounce 合并）；false = watcher 降级不可用 */
  onChange: (fn: (available: boolean) => void) => () => void
  /** 释放 watcher + 清理 pending timer */
  stop: () => void
}

export type MemoryWatcherOptions = {
  /** debounce 窗口（毫秒）；默认 100 */
  debounceMs?: number
}

export function createMemoryWatcher(
  dir: string,
  opts?: MemoryWatcherOptions,
): MemoryWatcher {
  const debounceMs = opts?.debounceMs ?? 100
  const listeners = new Set<(available: boolean) => void>()
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let degraded = false

  const notify = (available: boolean): void => {
    for (const fn of [...listeners]) {
      try {
        fn(available)
      } catch {
        /* 订阅者错误隔离 */
      }
    }
  }

  const scheduleNotify = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      notify(true)
    }, debounceMs)
  }

  const startWatch = (): void => {
    if (stopped) return
    try {
      watcher = watch(dir, { persistent: false }, () => {
        scheduleNotify()
      })
      watcher.on('error', () => {
        // stop/degrade 后的排队 error：直接忽略（不重启不泄漏）
        if (stopped || degraded) return
        // watch error：尝试重启一次，失败则降级
        watcher?.close()
        watcher = undefined
        try {
          watcher = watch(dir, { persistent: false }, () => {
            scheduleNotify()
          })
          watcher.on('error', () => {
            if (stopped || degraded) return
            degrade()
          })
        } catch {
          degrade()
        }
      })
    } catch {
      degrade()
    }
  }

  const degrade = (): void => {
    if (degraded || stopped) return
    degraded = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    watcher?.close()
    watcher = undefined
    notify(false)
  }

  startWatch()

  return {
    onChange(fn) {
      listeners.add(fn)
      // 首次订阅：立即告知当前可用性（降级状态也同步）
      queueMicrotask(() => {
        if (!stopped) fn(!degraded)
      })
      return () => {
        listeners.delete(fn)
      }
    },
    stop() {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      watcher?.close()
      watcher = undefined
      listeners.clear()
    },
  }
}
