/**
 * session.effortLevel → provider 参数最小映射（目前仅 max_tokens 倍率）。
 * auto / 未知 / 空 → 默认 base。
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'auto'

/** 默认 base max_tokens（与 Anthropic 配置默认一致） */
export const DEFAULT_EFFORT_BASE_MAX_TOKENS = 8192

/**
 * 将 effort 档位映射为 maxTokens。
 * - low: 0.5× base（下限 256）
 * - medium: 1× base
 * - high: 1.5× base
 * - max: 2× base
 * - auto / default / 空 / 未知: base
 */
export function mapEffort(
  effort?: string | null,
  baseMaxTokens: number = DEFAULT_EFFORT_BASE_MAX_TOKENS,
): { maxTokens: number } {
  const base =
    Number.isFinite(baseMaxTokens) && baseMaxTokens > 0
      ? Math.floor(baseMaxTokens)
      : DEFAULT_EFFORT_BASE_MAX_TOKENS
  const e = (effort ?? 'auto').toLowerCase().trim()
  switch (e) {
    case 'low':
      return { maxTokens: Math.max(256, Math.floor(base * 0.5)) }
    case 'medium':
      return { maxTokens: base }
    case 'high':
      return { maxTokens: Math.floor(base * 1.5) }
    case 'max':
      return { maxTokens: Math.floor(base * 2) }
    case 'auto':
    default:
      return { maxTokens: base }
  }
}