/**
 * AR3E · secret 不得越过进程/持久化边界
 *
 * ROADMAP 对 AR3E 的验收原文之一：**secret 不回传 renderer/transcript**。
 *
 * 桌面端当前是对的（provider 列表只回 `hasKeyConfig` 与 `apiKeyEnv`），
 * 但对的方式很脆：`{ ...desktopSettings }` 这种无边界展开一旦被加进新字段，
 * 就会自动跟着过界，而**没有任何东西会报警**。本模块把这件事从「每次 review
 * 记得」变成一个可以套在边界上的纯函数。
 *
 * ## 两条容易做反的设计
 *
 * **① 抹掉但不删除。** 字段消失会被读成「没配置」，而事实是「配了但不给你看」——
 * 这两者对排查问题的人意义完全相反。所以替换成可见的占位符。
 *
 * **② 名字不是密钥。** `apiKeyEnv: 'ANTHROPIC_API_KEY'` 必须留着：
 * 它是「该设哪个环境变量」的唯一线索，抹掉它等于连可诊断性一起抹了。
 *
 * 另一条同样重要的反向约束：**不能过度抹除**。把 model 名、路径、
 * 含「token」字样的普通句子全打成 `<redacted>`，界面就废了——
 * 那和泄漏一样属于不可用。
 */

const PLACEHOLDER = '<redacted>'

/**
 * 密钥形状：常见前缀 + 足够长的随机串。
 *
 * 刻意**按值判断而非按字段名**：真实泄漏往往发生在 `detail` / `message`
 * 这类无辜字段里——上游把 key 回显进了错误文本。只查字段名会漏掉它们。
 */
const SECRET_VALUE = new RegExp(
  [
    // sk-… / sk-ant-… / sk-live-… 等
    'sk-[A-Za-z0-9_-]{16,}',
    // GitHub / GitLab 风格
    'gh[pousr]_[A-Za-z0-9]{16,}',
    'glpat-[A-Za-z0-9_-]{16,}',
    // Bearer <token>
    'Bearer\\s+[A-Za-z0-9._-]{20,}',
    // 通用：明显的长随机串（含大小写与数字混排，且不含空格）
    '\\b[A-Za-z0-9_-]{40,}\\b',
  ].join('|'),
  'g',
)

/**
 * 字段名白名单：这些即使值很长也不算密钥。
 * 少了它，`cwd` 里的长路径、`model` 里的长 slug 都会被误伤。
 */
const NEVER_SECRET_KEYS = new Set([
  'apiKeyEnv',
  'hasKeyConfig',
  'cwd',
  'path',
  'filePath',
  'model',
  'baseUrl',
  'id',
  'kind',
  'label',
])

/** 字段名黑名单：这些字段的值一律抹，无论长得像不像 */
const ALWAYS_SECRET_KEYS = /^(apikey|api_key|token|secret|password|authorization)$/i

function redactString(value: string): string {
  return value.replace(SECRET_VALUE, PLACEHOLDER)
}

/**
 * 深度抹除。返回**副本**——就地改会污染调用方手里的真实配置。
 * 循环引用会被原样保留而不是抛错：边界函数在错误路径上被调用时，
 * 再抛一次只会盖掉原始问题。
 */
export function redactSecretsDeep(input: unknown): unknown {
  return walk(input, new WeakMap())
}

function walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value

  const existing = seen.get(value as object)
  if (existing !== undefined) return existing

  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(walk(item, seen))
    return out
  }

  const out: Record<string, unknown> = {}
  seen.set(value as object, out)
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ALWAYS_SECRET_KEYS.test(k)) {
      // 抹掉而不是删掉：字段消失会被读成「没配置」，与事实相反
      out[k] = v === undefined || v === null ? v : PLACEHOLDER
      continue
    }
    if (NEVER_SECRET_KEYS.has(k) && typeof v === 'string') {
      out[k] = v
      continue
    }
    out[k] = walk(v, seen)
  }
  return out
}
