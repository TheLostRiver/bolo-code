/**
 * 本地粗算 USD（对照 HC modelCost / calculateUSDCost）。
 * 无遥测；表为启发式，**非账单**；未知模型用 default tier。
 */

export type ModelCostRates = {
  /** USD per 1M input tokens */
  inputPerMTok: number
  /** USD per 1M output tokens */
  outputPerMTok: number
  /** USD per 1M cache read tokens */
  cacheReadPerMTok: number
  /** USD per 1M cache write / creation tokens */
  cacheWritePerMTok: number
}

/** Sonnet-ish default（与 HC COST_TIER_3_15 同量级） */
export const COST_TIER_DEFAULT: ModelCostRates = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
}

export const COST_TIER_OPUS: ModelCostRates = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
  cacheWritePerMTok: 18.75,
}

export const COST_TIER_HAIKU: ModelCostRates = {
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheReadPerMTok: 0.1,
  cacheWritePerMTok: 1.25,
}

export const COST_TIER_MINI: ModelCostRates = {
  inputPerMTok: 0.15,
  outputPerMTok: 0.6,
  cacheReadPerMTok: 0.075,
  cacheWritePerMTok: 0.375,
}

/** gpt-4o / 旗舰 chat 略高于 mini */
export const COST_TIER_FLAGSHIP_CHAT: ModelCostRates = {
  inputPerMTok: 2.5,
  outputPerMTok: 10,
  cacheReadPerMTok: 1.25,
  cacheWritePerMTok: 2.5,
}

/** 更便宜的 nano / 小模型 */
export const COST_TIER_NANO: ModelCostRates = {
  inputPerMTok: 0.1,
  outputPerMTok: 0.4,
  cacheReadPerMTok: 0.025,
  cacheWritePerMTok: 0.125,
}

import { resolveModelCatalogEntry, catalogCostRates } from '../../shared/src/modelCatalog.ts'

/**
 * 按 model 名计价：P1 目录精确命中优先（方案 PROVIDER_EXPANSION_PLAN §3），
 * 未命中回落启发式子串匹配（下方既有逻辑）。
 */
export function resolveModelCostRates(
  model: string | undefined | null,
): { rates: ModelCostRates; tier: string; known: boolean } {
  const m = (model ?? '').trim().toLowerCase()
  const catalog = resolveModelCatalogEntry(m)
  if (catalog?.cost) {
    const rates = catalogCostRates(catalog)
    return {
      rates: {
        inputPerMTok: rates.inputPerMTok,
        outputPerMTok: rates.outputPerMTok,
        cacheReadPerMTok: rates.cacheReadPerMTok,
        cacheWritePerMTok: rates.cacheWritePerMTok,
      },
      tier: `catalog:${catalog.provider}`,
      known: true,
    }
  }
  if (!m) {
    return { rates: COST_TIER_DEFAULT, tier: 'default', known: false }
  }
  if (m.includes('opus')) {
    return { rates: COST_TIER_OPUS, tier: 'opus-like', known: true }
  }
  if (m.includes('haiku') || m.includes('flash-lite')) {
    return { rates: COST_TIER_HAIKU, tier: 'haiku-like', known: true }
  }
  if (m.includes('nano') || m.includes('tiny')) {
    return { rates: COST_TIER_NANO, tier: 'nano-like', known: true }
  }
  // 先匹配 mini/small，再 4o 旗舰（避免 gpt-4o-mini 误进 flagship）
  if (
    m.includes('mini') ||
    m.includes('small') ||
    (m.includes('flash') && !m.includes('flash-lite'))
  ) {
    // gemini-flash / gpt-4o-mini
    if (m.includes('4o-mini') || m.includes('mini')) {
      return { rates: COST_TIER_MINI, tier: 'mini-like', known: true }
    }
    return { rates: COST_TIER_MINI, tier: 'flash-like', known: true }
  }
  if (
    m.includes('gpt-4o') ||
    m.includes('gpt-4.1') ||
    m.includes('gpt-4-turbo') ||
    m.includes('chatgpt')
  ) {
    return { rates: COST_TIER_FLAGSHIP_CHAT, tier: 'flagship-chat', known: true }
  }
  if (m.includes('sonnet') || m.includes('claude-3') || m.includes('claude-4')) {
    return { rates: COST_TIER_DEFAULT, tier: 'sonnet-like', known: true }
  }
  if (m.includes('claude')) {
    return { rates: COST_TIER_DEFAULT, tier: 'claude-like', known: true }
  }
  return { rates: COST_TIER_DEFAULT, tier: 'default', known: false }
}

export type TokenUsageForCost = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  model?: string
}

/** 单桶 / 全会话 USD 粗算 */
export function estimateUsdCost(
  usage: TokenUsageForCost,
  modelHint?: string,
): {
  usd: number
  tier: string
  known: boolean
  rates: ModelCostRates
  /** 若 cacheRead 按普通 input 计价，会多花多少（粗算「缓存省下」） */
  cacheSavingsUsd: number
} {
  const model = modelHint ?? usage.model
  const { rates, tier, known } = resolveModelCostRates(model)
  const inTok = Math.max(0, usage.inputTokens || 0)
  const outTok = Math.max(0, usage.outputTokens || 0)
  const cr = Math.max(0, usage.cacheReadInputTokens ?? 0)
  const cw = Math.max(0, usage.cacheCreationInputTokens ?? 0)
  // 计费语义近似：cache read 按 read 价；非缓存 input ≈ max(0, input - cacheRead)
  const uncachedIn = Math.max(0, inTok - cr)
  const usd =
    (uncachedIn / 1_000_000) * rates.inputPerMTok +
    (outTok / 1_000_000) * rates.outputPerMTok +
    (cr / 1_000_000) * rates.cacheReadPerMTok +
    (cw / 1_000_000) * rates.cacheWritePerMTok
  // 省下 = cacheRead 若按 input 价 − 实际 cache read 价
  const cacheSavingsUsd =
    (cr / 1_000_000) * Math.max(0, rates.inputPerMTok - rates.cacheReadPerMTok)
  return { usd, tier, known, rates, cacheSavingsUsd }
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** 毫秒 → 人类可读（本地 /cost） */
export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}