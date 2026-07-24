/**
 * callModel 有限重试 + 指数退避 — 对照 HelsincyCode withRetry 语义（极简）。
 *
 * - 仅 retryable（429/5xx/timeout/network）
 * - user_abort / fatal 不重试
 * - 已产出 text/tool 内容后不再重试（避免重复 tool_use）
 * - 与 PTL 路径正交：PTL 归 fatal，由 queryLoop 截断重试
 */

import type { ProviderStreamEvent } from '../../providers/src/index.ts'
import type { CallModelFn } from './deps.ts'
import {
  classifyError,
  type ClassifiedError,
} from './errorClassify.ts'

export const DEFAULT_MAX_MODEL_RETRIES = 3
export const DEFAULT_MODEL_RETRY_BASE_DELAY_MS = 500

export type ModelRetryInfo = {
  attempt: number
  maxRetries: number
  delayMs: number
  message: string
  reason: string
  status?: number
}

export type ModelRetryOptions = {
  /** 失败后最多再试次数；默认 3。0 = 关闭 */
  maxRetries?: number
  /** 首次退避 ms；默认 500。实际 delay = base * 2^(attempt-1) */
  baseDelayMs?: number
  /** 默认 true；false 关闭 */
  enabled?: boolean
  /** 可注入 sleep（测试用） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type CallModelRequestWithRetry = Parameters<CallModelFn>[0] & {
  /** 每次退避前回调（session 侧可观察 retried） */
  onModelRetry?: (info: ModelRetryInfo) => void
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function backoffMs(baseDelayMs: number, attempt: number): number {
  // attempt 1 → base, 2 → 2*base, 3 → 4*base
  const exp = Math.max(0, attempt - 1)
  const raw = baseDelayMs * Math.pow(2, exp)
  // 轻量抖动，避免惊群；上限 30s
  const jitter = Math.floor(Math.random() * Math.min(100, baseDelayMs * 0.1))
  return Math.min(30_000, raw + jitter)
}

function isContentEvent(ev: ProviderStreamEvent): boolean {
  // reasoning 也算「有模型输出」，避免纯思考流被误判为空失败
  return (
    ev.type === 'text_delta' ||
    ev.type === 'tool_call' ||
    ev.type === 'reasoning_delta'
  )
}

/**
 * 包装 CallModelFn：流式错误或 throw 且可重试时，退避后整次重拉。
 */
export function wrapCallModelWithRetry(
  inner: CallModelFn,
  options?: ModelRetryOptions,
): CallModelFn {
  const maxRetries =
    options?.maxRetries === undefined
      ? DEFAULT_MAX_MODEL_RETRIES
      : Math.max(0, options.maxRetries)
  const baseDelayMs =
    options?.baseDelayMs === undefined
      ? DEFAULT_MODEL_RETRY_BASE_DELAY_MS
      : Math.max(0, options.baseDelayMs)
  const enabled = options?.enabled !== false && maxRetries > 0
  const sleep = options?.sleep ?? defaultSleep

  if (!enabled) return inner

  return async function* (req) {
    const onRetry = (req as CallModelRequestWithRetry).onModelRetry
    let attempt = 0

    while (true) {
      if (req.signal?.aborted) {
        yield { type: 'error' as const, message: 'aborted' }
        yield { type: 'done' as const }
        return
      }

      let hadContent = false
      let retryable: ClassifiedError | null = null
      let fatalYielded = false

      try {
        for await (const ev of inner(req)) {
          if (ev.type === 'error') {
            const c = classifyError(ev.message, { signal: req.signal })
            if (
              c.class === 'retryable' &&
              !hadContent &&
              attempt < maxRetries
            ) {
              retryable = c
              // 丢弃本轮后续；不向 loop 暴露可重试错误
              break
            }
            // user_abort / fatal / 已有内容 / 重试耗尽 → 原样下发
            yield ev
            fatalYielded = true
            continue
          }
          if (isContentEvent(ev)) hadContent = true
          yield ev
        }
      } catch (e) {
        const c = classifyError(e, { signal: req.signal })
        if (c.class === 'retryable' && !hadContent && attempt < maxRetries) {
          retryable = c
        } else if (c.class === 'user_abort') {
          yield { type: 'error' as const, message: c.message || 'aborted' }
          yield { type: 'done' as const }
          return
        } else {
          // 不可重试：转为 stream error，与 provider 行为一致
          yield {
            type: 'error' as const,
            message: c.message || (e instanceof Error ? e.message : String(e)),
          }
          yield { type: 'done' as const }
          return
        }
      }

      if (!retryable) {
        // 成功或已 yield 致命错误
        if (!fatalYielded) {
          // inner 可能已 yield done；无需补
        }
        return
      }

      attempt += 1
      const delayMs = backoffMs(baseDelayMs, attempt)
      onRetry?.({
        attempt,
        maxRetries,
        delayMs,
        message: retryable.message,
        reason: retryable.reason,
        status: retryable.status,
      })
      try {
        await sleep(delayMs, req.signal)
      } catch {
        yield { type: 'error' as const, message: 'aborted' }
        yield { type: 'done' as const }
        return
      }
      // 下一轮整次重拉
    }
  }
}