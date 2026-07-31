/**
 * P1 模型元数据目录（纯数据，不发网）。
 *
 * 位置说明：方案 PROVIDER_EXPANSION_PLAN §3.2 原拟放 packages/providers，
 * 实施改为 packages/shared——core 的 /cost（modelCost.ts）不依赖 providers，
 * 放 shared 让 core 与 cli/providers 都能消费（与 theme.ts 同模式）。
 *
 * 用途：/cost 精确计价与 context 占比窗口的"内置表"层。
 * 合并优先级：config 显式覆盖 > 本目录 > provider 默认 > 启发式估算。
 * 数值为官方定价近似（**非账单**），测试锁定已录入条目的值。
 */

export type ModelCostEntry = {
  /** USD per 1M tokens */
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok?: number
  cacheWritePerMTok?: number
}

export type ModelCatalogEntry = {
  /** 模型 id（精确匹配，小写比较） */
  id: string
  /** 归属 preset id（openai/anthropic/deepseek/qwen…） */
  provider: string
  /** 上下文窗口（tokens） */
  contextWindow: number
  maxOutput?: number
  /** 缺省 = 无精确价，回落启发式 */
  cost?: ModelCostEntry
  /** 备注（价格基准日期等） */
  notes?: string
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [  // ── Anthropic（2026-07 定价近似） ──
  { id: 'claude-opus-4-6', provider: 'anthropic', contextWindow: 200_000, maxOutput: 64_000, cost: { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 } },
  { id: 'claude-sonnet-4-20250514', provider: 'anthropic', contextWindow: 200_000, maxOutput: 64_000, cost: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', contextWindow: 200_000, maxOutput: 32_000, cost: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 } },
  // ── OpenAI（2026-07 定价近似） ──
  { id: 'gpt-4o', provider: 'openai-responses', contextWindow: 128_000, maxOutput: 16_000, cost: { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25, cacheWritePerMTok: 2.5 } },
  { id: 'gpt-4o-mini', provider: 'openai', contextWindow: 128_000, maxOutput: 16_000, cost: { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0.375 } },
  { id: 'gpt-4.1', provider: 'openai', contextWindow: 1_000_000, maxOutput: 32_000, cost: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5, cacheWritePerMTok: 2.5 } },
  { id: 'o4-mini', provider: 'openai-responses', contextWindow: 200_000, maxOutput: 100_000, cost: { inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275, cacheWritePerMTok: 1.1 } },
  // ── DeepSeek ──
  { id: 'deepseek-chat', provider: 'deepseek', contextWindow: 128_000, maxOutput: 8_000, cost: { inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 } },
  { id: 'deepseek-reasoner', provider: 'deepseek', contextWindow: 128_000, maxOutput: 8_000, cost: { inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14 } },
  // ── Qwen / 百炼 ──
  { id: 'qwen-plus', provider: 'qwen', contextWindow: 131_072, cost: { inputPerMTok: 0.4, outputPerMTok: 1.2 } },
  { id: 'qwen-max', provider: 'qwen', contextWindow: 131_072, cost: { inputPerMTok: 2.4, outputPerMTok: 9.6 } },
  { id: 'qwen-turbo', provider: 'qwen', contextWindow: 131_072, cost: { inputPerMTok: 0.3, outputPerMTok: 0.6 } },
  // ── 智谱 GLM ──
  { id: 'glm-4.5', provider: 'zhipu', contextWindow: 128_000, cost: { inputPerMTok: 0.6, outputPerMTok: 2.6 } },
  { id: 'glm-4.5-air', provider: 'zhipu', contextWindow: 128_000, cost: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { id: 'glm-4-flash', provider: 'zhipu', contextWindow: 128_000, cost: { inputPerMTok: 0.02, outputPerMTok: 0.02 } },
  // ── Moonshot Kimi ──
  { id: 'kimi-k2-turbo-preview', provider: 'moonshot', contextWindow: 128_000, maxOutput: 16_000, cost: { inputPerMTok: 0.6, outputPerMTok: 2.6 } },
  { id: 'moonshot-v1-32k', provider: 'moonshot', contextWindow: 32_000, cost: { inputPerMTok: 0.6, outputPerMTok: 2.6 } },
  // ── xAI Grok ──
  { id: 'grok-4', provider: 'xai', contextWindow: 256_000, maxOutput: 32_000, cost: { inputPerMTok: 3, outputPerMTok: 15 } },
  { id: 'grok-3-mini', provider: 'xai', contextWindow: 131_072, cost: { inputPerMTok: 0.3, outputPerMTok: 0.5 } },
  // ── 开源系（各兼容端点常用） ──
  { id: 'llama-3.3-70b-versatile', provider: 'groq', contextWindow: 128_000, cost: { inputPerMTok: 0.59, outputPerMTok: 0.79 } },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', provider: 'together', contextWindow: 128_000 },
  { id: 'mistral-large-latest', provider: 'mistral', contextWindow: 128_000, cost: { inputPerMTok: 2, outputPerMTok: 6 } },
  { id: 'mistral-small-latest', provider: 'mistral', contextWindow: 32_000, cost: { inputPerMTok: 0.2, outputPerMTok: 0.6 } },
  { id: 'sonar-pro', provider: 'perplexity', contextWindow: 200_000, cost: { inputPerMTok: 3, outputPerMTok: 15 } },
  // ── 其它国内 ──
  { id: 'MiniMax-Text-01', provider: 'minimax', contextWindow: 1_000_000, cost: { inputPerMTok: 0.8, outputPerMTok: 2.2 } },
  { id: 'ernie-4.5-8k-preview', provider: 'baidu', contextWindow: 8_000, cost: { inputPerMTok: 6, outputPerMTok: 18 } },
  { id: 'Baichuan4-Turbo', provider: 'baichuan', contextWindow: 32_000, cost: { inputPerMTok: 4, outputPerMTok: 8 } },
  { id: 'step-2-16k', provider: 'stepfun', contextWindow: 16_000, cost: { inputPerMTok: 1, outputPerMTok: 5 } },
  { id: 'hunyuan-turbos-latest', provider: 'hunyuan', contextWindow: 256_000, cost: { inputPerMTok: 0.4, outputPerMTok: 1.2 } },
  { id: 'yi-lightning', provider: 'lingyi', contextWindow: 16_000, cost: { inputPerMTok: 0.2, outputPerMTok: 0.6 } },
]

/**
 * 精确查目录：model id（小写）精确匹配；provider 命中时优先返回同 provider 条目。
 * 未命中返回 undefined（调用方回落启发式/默认）。
 */
export function resolveModelCatalogEntry(
  model: string | undefined | null,
  providerId?: string | undefined | null,
): ModelCatalogEntry | undefined {
  const id = (model ?? '').trim().toLowerCase()
  if (!id) return undefined
  const matches = MODEL_CATALOG.filter(
    (entry) => entry.id.toLowerCase() === id,
  )
  if (!matches.length) return undefined
  if (providerId) {
    const sameProvider = matches.find(
      (entry) => entry.provider === providerId.trim().toLowerCase(),
    )
    if (sameProvider) return sameProvider
  }
  return matches[0]
}

/** USD 每百万 token 的完整费率（缺省字段回落到 input/output 价） */
export function catalogCostRates(
  entry: ModelCatalogEntry,
): {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
} {
  const cost = entry.cost
  if (!cost) {
    // 无精确价：fallback 默认费率（与 COST_TIER_DEFAULT 同量级）
    return {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    }
  }
  return {
    inputPerMTok: cost.inputPerMTok,
    outputPerMTok: cost.outputPerMTok,
    cacheReadPerMTok: cost.cacheReadPerMTok ?? cost.inputPerMTok,
    cacheWritePerMTok: cost.cacheWritePerMTok ?? cost.inputPerMTok,
  }
}

export const MODEL_CATALOG_COUNT = MODEL_CATALOG.length
