/**
 * 模型元数据生成器（借鉴 pi 的数据驱动思路，Bolo 自研实现）：
 *
 * 拉取 models.dev（开放模型目录）→ 过滤主流 provider 的 text 模型 →
 * 生成 `packages/config/src/models.generated.ts`（含数据源时间戳）。
 *
 * 运行：npm run generate:models
 * 产物提交入库（运行时零依赖——生成的 .ts 即源码）。
 *
 * 本地权威覆盖（官方文档核验，不盲信 models.dev）：
 * - deepseek-v4-flash / deepseek-v4-pro：models.dev 缺 context（官方
 *   CONTEXT LENGTH 1M / MAX OUTPUT 384K，2026-08 核验）——在生成产物
 *   之后由 modelMetadata.ts 的 LOCAL_AUTHORITATIVE 覆盖（见该文件）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const CACHE_PATH = path.join('.bolo-tmp', 'modelsdev.json')
const OUT_PATH = path.join('packages', 'config', 'src', 'models.generated.ts')

/** 目标 provider（主流 + Bolo 用户实际在用的网关） */
const TARGET_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'deepseek',
  'google',
  'xai',
  'moonshotai',
  'moonshotai-cn',
  'zai',
  'minimax',
  'groq',
  'opencode',
  'opencode-go',
  'siliconflow',
  'qwen',
  'alibaba',
  'mistral',
])

type ModelsDevEntry = {
  id?: string
  name?: string
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
}

type GeneratedEntry = {
  model: string
  contextWindowTokens?: number
  maxOutputTokens: number
}

async function fetchModelsDev(): Promise<Record<string, unknown>> {
  try {
    const cached = await fs.readFile(CACHE_PATH, 'utf8')
    console.log(`using cached ${CACHE_PATH}`)
    return JSON.parse(cached) as Record<string, unknown>
  } catch {
    console.log(`fetching ${MODELS_DEV_URL}`)
    const res = await fetch(MODELS_DEV_URL)
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
    const raw = await res.text()
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true })
    await fs.writeFile(CACHE_PATH, raw, 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 只保留文本输出模型（跳过纯图像/语音/embedding 输出） */
function isTextModel(entry: ModelsDevEntry): boolean {
  const output = entry.modalities?.output
  // output 未声明 → 保留（数据缺失不误杀）；声明了则必须含 text
  return !output || output.includes('text')
}

/** 跳过 embedding 模型（无对话 max output 语义） */
function isEmbeddingModel(modelId: string): boolean {
  return /embedding|text-embedding|ada-002/i.test(modelId)
}

async function main(): Promise<void> {
  const catalog = await fetchModelsDev()
  const out: GeneratedEntry[] = []
  const skipped: string[] = []

  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!TARGET_PROVIDERS.has(providerId)) continue
    if (!isRecord(provider)) continue
    const models = provider.models
    if (!isRecord(models)) continue
    for (const [modelId, rawEntry] of Object.entries(models)) {
      const entry = rawEntry as ModelsDevEntry
      if (!isRecord(rawEntry)) continue
      if (!isTextModel(entry)) continue
      if (isEmbeddingModel(modelId)) {
        skipped.push(`${providerId}/${modelId} (embedding model)`)
        continue
      }
      const output = entry.limit?.output
      if (!output || output <= 0) {
        skipped.push(`${providerId}/${modelId} (no output limit)`)
        continue
      }
      const context = entry.limit?.context
      if (context && output > context) {
        // models.dev 异常数据（output > context 不物理）——不录
        skipped.push(`${providerId}/${modelId} (output ${output} > context ${context})`)
        continue
      }
      out.push({
        model: modelId,
        ...(context ? { contextWindowTokens: context } : {}),
        maxOutputTokens: output,
      })
    }
  }

  out.sort((a, b) => a.model.localeCompare(b.model))
  // 跨 provider 同名去重（大小写不敏感——目录匹配按小写唯一）：
  // 保留 maxOutput 最大 + context 完整者
  const dedup = new Map<string, GeneratedEntry>()
  for (const e of out) {
    const key = e.model.toLowerCase()
    const prev = dedup.get(key)
    if (!prev) {
      dedup.set(key, e)
      continue
    }
    const prevScore = prev.maxOutputTokens + (prev.contextWindowTokens ? 1_000_000 : 0)
    const curScore = e.maxOutputTokens + (e.contextWindowTokens ? 1_000_000 : 0)
    if (curScore > prevScore) dedup.set(key, e)
  }
  const final = [...dedup.values()].sort((a, b) => a.model.localeCompare(b.model))
  const header = `// 此文件由 scripts/generate-model-metadata.ts 自动生成（models.dev，${new Date().toISOString().slice(0, 10)}）
// 勿手改——运行 npm run generate:models 重新生成
export const GENERATED_MODEL_METADATA = [
`
  const body = final
    .map(
      (e) =>
        `  { model: '${e.model}', maxOutputTokens: ${e.maxOutputTokens}${e.contextWindowTokens ? `, contextWindowTokens: ${e.contextWindowTokens}` : ''} },`,
    )
    .join('\n')
  const footer = `
] as const
`
  await fs.writeFile(OUT_PATH, header + body + footer, 'utf8')
  console.log(`wrote ${OUT_PATH}: ${final.length} entries (${out.length - final.length} duplicates removed)`)
  console.log(`skipped ${skipped.length}: ${skipped.slice(0, 10).join('; ')}${skipped.length > 10 ? '; …' : ''}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
