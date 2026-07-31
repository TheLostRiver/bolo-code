/**
 * P1 模型元数据目录测试（方案 PROVIDER_EXPANSION_PLAN §3.4）：
 * - 数据完整性：id 唯一、provider/contextWindow 必填、cost 可缺
 * - resolveModelCatalogEntry：命中/未命中/provider 过滤
 * - core resolveModelCostRates：catalog 精确命中优先、未命中回落启发式
 * - 覆盖优先级：config 显式 > 内置表 > 启发式（catalog 命中即精确）
 */
import { strict as assert } from 'node:assert'
import {
  MODEL_CATALOG,
  MODEL_CATALOG_COUNT,
  catalogCostRates,
  resolveModelCatalogEntry,
} from '../packages/shared/src/index.ts'
import { resolveModelCostRates } from '../packages/core/src/modelCost.ts'

function main() {
  // ---- 数据完整性 ----
  assert.ok(MODEL_CATALOG_COUNT >= 30, `catalog >= 30 entries, got ${MODEL_CATALOG_COUNT}`)
  const ids = new Set<string>()
  for (const entry of MODEL_CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`)
    ids.add(entry.id)
    assert.ok(entry.provider.length > 0, `provider ${entry.id}`)
    assert.ok(
      Number.isInteger(entry.contextWindow) && entry.contextWindow > 0,
      `contextWindow ${entry.id}`,
    )
  }

  // ---- 命中 / 未命中 / provider 过滤 ----
  const gpt4o = resolveModelCatalogEntry('gpt-4o')
  assert.ok(gpt4o, 'gpt-4o hit')
  assert.equal(gpt4o?.provider, 'openai-responses')
  assert.equal(gpt4o?.contextWindow, 128_000)
  assert.equal(resolveModelCatalogEntry('gpt-4o', 'openai-responses')?.provider, 'openai-responses', 'provider filter hit')
  assert.equal(resolveModelCatalogEntry('gpt-4o', 'nobody')?.provider, 'openai-responses', 'provider miss → first match')
  assert.equal(resolveModelCatalogEntry('no-such-model-xyz'), undefined, 'miss → undefined')
  assert.equal(resolveModelCatalogEntry(''), undefined, 'empty → undefined')
  assert.equal(resolveModelCatalogEntry(null), undefined, 'null → undefined')
  // 大小写不敏感
  assert.equal(resolveModelCatalogEntry('GPT-4O')?.id, 'gpt-4o', 'case-insensitive')

  // ---- catalogCostRates：缺省字段回落 ----
  const llama = resolveModelCatalogEntry('meta-llama/Llama-3.3-70B-Instruct')!
  assert.ok(llama.cost === undefined, 'llama entry has no cost')
  const rates = catalogCostRates(llama)
  assert.equal(rates.cacheReadPerMTok, 0.3, 'fallback cacheRead = DEFAULT 0.3')
  assert.equal(rates.cacheWritePerMTok, 3.75, 'fallback cacheWrite = DEFAULT 3.75')
  const deepseek = resolveModelCatalogEntry('deepseek-chat')!
  const dsRates = catalogCostRates(deepseek)
  assert.equal(dsRates.cacheReadPerMTok, 0.07, 'deepseek cache read exact')
  assert.equal(dsRates.cacheWritePerMTok, 0.27, 'cacheWrite fallback = input')

  // ---- core resolveModelCostRates：catalog 精确命中优先 ----
  const sonnet = resolveModelCostRates('claude-sonnet-4-20250514')
  assert.equal(sonnet.tier, 'catalog:anthropic', 'sonnet exact tier')
  assert.equal(sonnet.rates.inputPerMTok, 3, 'sonnet exact input')
  assert.equal(sonnet.rates.outputPerMTok, 15, 'sonnet exact output')
  assert.equal(sonnet.rates.cacheReadPerMTok, 0.3, 'sonnet exact cache read')
  assert.equal(sonnet.rates.cacheWritePerMTok, 3.75, 'sonnet exact cache write')

  // 未命中回落启发式（既有行为不回归）
  const unknown = resolveModelCostRates('some-model-xyz')
  assert.equal(unknown.tier, 'default', 'unknown → heuristic default')
  // 命中但无 cost → 回落启发式（如 llama 走子串匹配）
  const llamaCost = resolveModelCostRates('meta-llama/Llama-3.3-70B-Instruct')
  assert.equal(llamaCost.tier, 'default', 'catalog no-cost → heuristic')
  // opus 精确（之前是启发式已知，现在 catalog 优先）
  const opus = resolveModelCostRates('claude-opus-4-6')
  assert.equal(opus.tier, 'catalog:anthropic', 'opus catalog tier')
  assert.equal(opus.rates.inputPerMTok, 15, 'opus input 15')

  // ---- 目录内容抽样 ----
  assert.equal(resolveModelCatalogEntry('deepseek-chat')?.contextWindow, 128_000)
  assert.equal(resolveModelCatalogEntry('qwen-plus')?.provider, 'qwen')
  assert.equal(resolveModelCatalogEntry('glm-4.5')?.provider, 'zhipu')

  console.log(`PASS: model catalog (${MODEL_CATALOG_COUNT} entries)`)
}

main()
