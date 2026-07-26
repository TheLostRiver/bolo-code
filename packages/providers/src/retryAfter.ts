/**
 * 限流等待提示解析
 *
 * 服务端在 429/503 上会告诉你什么时候可以再来。不读这个头就等于
 * 用固定的指数退避去猜——猜短了白白烧完重试次数丢掉整轮，
 * 猜长了让用户干等。
 *
 * 这里只做解析，纯函数，不含策略。要不要等、等多久上限多少，
 * 由 core 的重试层决定（见 modelRetry）。
 */

/** 只要求 get()，方便测试替身与不同 fetch 实现 */
export type HeaderLike = {
  get(name: string): string | null | undefined
}

/**
 * 尊重服务端等待的上限。
 *
 * 超过这个值就不再干等：把 CLI 卡住一小时不是修复，是另一种失败。
 * 此时重试层应当立刻失败，并告诉用户还要等多久。
 */
export const MAX_HONORED_RETRY_AFTER_MS = 60_000

function parsePositiveInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 从响应头解析「还要等多久」（毫秒）。
 *
 * 认三种形式：
 * - `retry-after-ms: 1500`        —— 部分 provider 给的毫秒精度值，优先
 * - `retry-after: 20`             —— RFC 9110 delta-seconds
 * - `retry-after: <HTTP-date>`    —— RFC 9110 绝对时间，按 now 折算
 *
 * 解析不出来一律返回 `undefined`——**不猜**。调用方据此退回自己的退避策略。
 * 过去的时间点折算为 0（可以立刻重试），不产生负等待。
 */
export function parseRetryAfterMs(
  headers: HeaderLike | undefined | null,
  now: number = Date.now(),
): number | undefined {
  if (!headers || typeof headers.get !== 'function') return undefined

  // 毫秒值更精确，优先
  const ms = headers.get('retry-after-ms')
  if (typeof ms === 'string') {
    const parsed = parsePositiveInt(ms.trim())
    if (parsed !== undefined) return parsed
  }

  const raw = headers.get('retry-after')
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!value) return undefined

  const seconds = parsePositiveInt(value)
  if (seconds !== undefined) return seconds * 1000

  // 看起来像数字却没通过上面的校验（负数、小数、`1e3`…）就是非法值。
  // 不能交给 Date.parse —— 它会把 "-5" 之类当成年份解析出一个荒谬的时间。
  if (/^[+-]?[\d.]+(?:[eE][+-]?\d+)?$/.test(value)) return undefined

  const at = Date.parse(value)
  if (Number.isFinite(at)) return Math.max(0, at - now)

  return undefined
}

/** 供错误信息使用的人话时长：`20s` / `3m` / `1h2m` */
export function formatRetryWait(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const rem = total % 60
    return rem ? `${minutes}m${rem}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin ? `${hours}h${remMin}m` : `${hours}h`
}
