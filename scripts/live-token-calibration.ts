/**
 * AR2B1 · 本地 token 估算的**真实误差**标定（活体，不进门禁）
 *
 * ROADMAP §13.10.2 对 AR2B1 的第一条要求就是「**先重估必要性**」——
 * A0a 落地后本地估算还差多少，值不值得引入真 tokenizer。
 *
 * 这个问题不能靠推理回答，得有数。做法：把固定语料发给一个免费模型，
 * 读回 `usage.prompt_tokens` 当 ground truth，与 `estimateTokens` 比。
 * 先用最短请求测一次基线开销（系统/协议固定成本），再从各语料的
 * prompt_tokens 里扣掉，得到该语料自身的真实 token 数。
 *
 * **不进 `npm test`**：依赖公网与第三方可用性，且会产生真实请求。
 * 让门禁因为别人家的故障变红，只会训练所有人无视红灯。
 *
 * 前置（任意 OpenAI 兼容端点，只要回 `usage.prompt_tokens`）：
 *
 *   CALIB_BASE_URL=https://api.deepseek.com/v1
 *   CALIB_KEY=<key>
 *   CALIB_MODEL=deepseek-chat        # 可选
 *
 * 运行：CALIB_BASE_URL=… CALIB_KEY=… npx tsx scripts/live-token-calibration.ts
 *
 * 刻意不绑定某一家：不同厂商的 tokenizer 不同，本地启发式要面对的正是这种差异，
 * 换一家跑一遍才看得出估算是普遍偏保守还是只对某家准。
 */
import { estimateTokens } from '../packages/compact/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

const BASE_URL = (
  process.env.CALIB_BASE_URL ?? 'https://openrouter.ai/api/v1'
).replace(/\/+$/, '')
const ENDPOINT = `${BASE_URL}/chat/completions`
const MODEL = process.env.CALIB_MODEL ?? 'inclusionai/ling-3.0-flash:free'

const EN = `The quick brown fox jumps over the lazy dog. Compaction must never trade
recoverability for a better compression ratio. When a tool call is separated from its
result the provider rejects the whole request, and by then the original history has
already been replaced by a summary.`

const ZH = `压缩绝不能拿可恢复性去换更高的压缩率。一旦工具调用与它的结果被拆开，
provider 会直接拒绝整个请求，而那时原始历史已经被摘要替换掉了，无法恢复。
中文的字符与 token 比例和英文差别很大，这正是本地启发式最容易失准的地方。`

const CODE = `export function hybridTokenCount(opts: {
  messages: ChatMessage[]
  anchor?: UsageAnchor
  pad?: boolean
}): { tokenCount: number; source: 'hybrid' | 'estimate' | 'usage' } {
  const { messages, anchor } = opts
  if (!anchor) return { tokenCount: estimateTokens(messages), source: 'estimate' }
  const count = Math.floor(anchor.anchoredMessageCount)
  if (count === messages.length) return { tokenCount: input, source: 'usage' }
  return { tokenCount: input + estimateTokens(messages.slice(count)), source: 'hybrid' }
}`

const JSON_BLOB = JSON.stringify(
  {
    tools: Array.from({ length: 12 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'Reads a file from the local filesystem and returns its contents',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'number' } },
        required: ['path'],
      },
    })),
  },
  null,
  2,
)

const TOOL_OUT = `$ npm test
> bolo-code@0.0.1 test
PASS: compact range contract
PASS: compact split invariant (7736 cut combos, 6820 split combos)
PASS: transcript rewrite preserves durable entries
  at Object.<anonymous> (E:\\DEV\\HelsincyAgent\\scripts\\test.ts:12:9)
  at Module._compile (node:internal/modules/cjs/loader:1234:14)
warning: LF will be replaced by CRLF the next time Git touches it`

const CORPORA: Array<{ name: string; text: string }> = [
  { name: 'english prose', text: EN },
  { name: 'chinese prose', text: ZH },
  { name: 'typescript code', text: CODE },
  { name: 'json (tool schemas)', text: JSON_BLOB },
  { name: 'tool output / logs', text: TOOL_OUT },
]

async function promptTokens(key: string, content: string): Promise<number> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content }],
      max_tokens: 1,
    }),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    usage?: { prompt_tokens?: number }
    error?: { message?: string }
  }
  if (json.error) throw new Error(json.error.message ?? 'provider error')
  const n = json.usage?.prompt_tokens
  if (typeof n !== 'number') {
    throw new Error(`no usage.prompt_tokens in response: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return n
}

function estimateOne(text: string): number {
  const msgs: ChatMessage[] = [{ role: 'user', content: text }]
  return estimateTokens(msgs)
}

async function main() {
  const key = (process.env.CALIB_KEY ?? process.env.OR_KEY)?.trim()
  if (!key) {
    console.error('CALIB_KEY is not set — this script makes real requests and cannot run without it')
    process.exit(2)
  }

  // 基线：最短请求的固定开销，从各语料里扣掉
  const base = await promptTokens(key, '.')
  const baseEstimate = estimateOne('.')
  console.log(`endpoint: ${ENDPOINT}`)
  console.log(`model: ${MODEL}`)
  console.log(`baseline overhead: real=${base} tok (estimate=${baseEstimate})\n`)

  const rows: Array<{ name: string; real: number; est: number; err: number }> = []
  for (const c of CORPORA) {
    const real = (await promptTokens(key, c.text)) - base
    // 估算侧同样扣掉基线消息开销，两边可比
    const est = estimateOne(c.text) - baseEstimate
    const err = real > 0 ? (est - real) / real : 0
    rows.push({ name: c.name, real, est, err })
    const sign = err >= 0 ? '+' : ''
    console.log(
      `${c.name.padEnd(22)} real=${String(real).padStart(5)}  est=${String(est).padStart(5)}  ` +
        `err=${sign}${(err * 100).toFixed(1)}%`,
    )
  }

  const worstOver = Math.max(...rows.map((r) => r.err))
  const worstUnder = Math.min(...rows.map((r) => r.err))
  console.log(
    `\nworst overestimate: +${(worstOver * 100).toFixed(1)}%  ` +
      `worst underestimate: ${(worstUnder * 100).toFixed(1)}%`,
  )

  // 低估才危险：估少了会让 auto compact **迟触发**，撞上 provider 的硬上限。
  // 高估只是提前压缩，代价是压得勤一点。
  console.log(
    worstUnder < -0.2
      ? '\n=> underestimates by more than 20% somewhere — that direction risks late auto-compact'
      : '\n=> no severe underestimate; the estimator errs safe (early compaction) on this corpus',
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
