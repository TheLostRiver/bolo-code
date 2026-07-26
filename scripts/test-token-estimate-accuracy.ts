/**
 * AR2B1 · 本地 token 估算的精度下界（用真实 tokenizer 的实测值当 fixture）
 *
 * ROADMAP §13.10.2 要求 AR2B1「**先重估必要性**」。重估的结论不是
 * 「引入真 tokenizer」——那要么联网、要么塞进不可审计的 native 依赖，
 * 两条都撞零运行时依赖红线——而是「**现有启发式有两个可量化的具体缺陷**」。
 *
 * ground truth 由 `scripts/live-token-calibration.ts` 打真实端点取得
 * （DeepSeek，`usage.prompt_tokens`，扣除最短请求的基线开销），实测：
 *
 * | 语料 | 真实 | 修复前估算 | 误差 |
 * |------|------|-----------|------|
 * | 英文散文 | 56 | 69 | +23% |
 * | **中文散文** | 62 | 29 | **−53%** |
 * | TypeScript | 138 | 129 | −6.5% |
 * | **JSON 工具 schema** | 1124 | 2350 | **+109%** |
 * | 工具输出/日志 | 113 | 94 | −17% |
 *
 * 两个方向的错法轻重完全不同：
 *
 * - **低估是危险的。** auto compact 会**迟触发**，直接撞 provider 的硬上限，
 *   那时 PTL 重试要截断历史，是真正的损失。中文低估 53% 尤其要命——
 *   本项目的注释、文档、交流大量是中文，CJK 进上下文是常态不是假设。
 * - **高估只是浪费。** 提前压缩、多花摘要调用、少留原文，但不会炸。
 *
 * 所以两边的阈值**故意不对称**。
 *
 * fixture 取**两家实测里更密的那个**（见下方 FIXTURES 注释）：安全要求是
 * 「对任何已知 tokenizer 都不低估」，基准就得贴最坏情况而不是平均值。
 * 只标定一家会栽——中文在两家之间差 27%，按 DeepSeek 定的比例放到
 * GPT-5.6 上立刻变成低估。要再加一家复测：见 `live-token-calibration.ts`。
 *
 * 运行：npx tsx scripts/test-token-estimate-accuracy.ts
 */
import { estimateTokens, looksProseText } from '../packages/compact/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 低估多少算不可接受——这是会炸的方向 */
const MAX_UNDERESTIMATE = 0.15
/**
 * 高估多少算浪费得离谱。
 *
 * 起初定 0.6 是因为「一个常量服务不了 3.3–4.9 的跨度」。但那个前提只在
 * **不分类**时成立——实测显示散文（4.96 字符/token）与其余（3.3–4.2）
 * 是可以判别开的两类，分开取值后余量能收到 0.25。
 *
 * 收紧的收益是实在的：高估意味着 auto compact 提前触发，
 * 白白多花摘要调用、少留原文。
 */
const MAX_OVERESTIMATE = 0.25

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

/**
 * 真实 token 数（已扣各端点自己的基线开销）。
 *
 * **取两家实测里更密的那个**——安全要求是「对任何已知 tokenizer 都不低估」，
 * 所以基准必须贴着最坏情况，而不是平均值。
 *
 * | 语料 | DeepSeek | GPT-5.6（中转） | 采用 |
 * |------|----------|----------------|------|
 * | 英文散文 | 56 | 55 | 56 |
 * | 中文散文 | 62 | **79** | **79** |
 * | TypeScript | 138 | 134 | 138 |
 * | JSON schema | 1124 | 未取到（中转 503） | 1124 |
 * | 日志 | 113 | 未取到（中转 503） | 113 |
 *
 * 中文一栏两家差 27%，正是「只标定一家会栽」的实证：按 DeepSeek 定的
 * CJK 比例在第二家上立刻变成低估。后两行只有单家数据，属已知缺口。
 */
const FIXTURES: Array<{ name: string; text: string; real: number }> = [
  { name: 'english prose', text: EN, real: 56 },
  { name: 'chinese prose', text: ZH, real: 79 },
  { name: 'typescript code', text: CODE, real: 138 },
  { name: 'json (tool schemas)', text: JSON_BLOB, real: 1124 },
  { name: 'tool output / logs', text: TOOL_OUT, real: 113 },
]

/** 与标定脚本口径一致：扣掉最短消息的固定开销 */
const BASE_ESTIMATE = estimateTokens([{ role: 'user', content: '.' } as ChatMessage])

function estimateOne(text: string): number {
  return estimateTokens([{ role: 'user', content: text } as ChatMessage]) - BASE_ESTIMATE
}

function main() {
  const rows: string[] = []
  let worstUnder = 0
  let worstOver = 0

  for (const f of FIXTURES) {
    const est = estimateOne(f.text)
    const err = (est - f.real) / f.real
    worstUnder = Math.min(worstUnder, err)
    worstOver = Math.max(worstOver, err)
    rows.push(
      `  ${f.name.padEnd(22)} real=${String(f.real).padStart(5)} est=${String(est).padStart(5)} ` +
        `${err >= 0 ? '+' : ''}${(err * 100).toFixed(1)}%`,
    )

    assert(
      err >= -MAX_UNDERESTIMATE,
      `"${f.name}" underestimates by ${(-err * 100).toFixed(1)}% (real ${f.real}, est ${est}) — ` +
        `underestimating makes auto compact fire late and hit the provider's hard limit`,
    )
    assert(
      err <= MAX_OVERESTIMATE,
      `"${f.name}" overestimates by ${(err * 100).toFixed(1)}% (real ${f.real}, est ${est}) — ` +
        `wasteful early compaction throws away context that still fits`,
    )
  }

  // CJK 必须真的走一条与拉丁不同的路径，而不是碰巧被别的规则蒙对
  {
    const cjkOnly = '压缩绝不能拿可恢复性去换更高的压缩率一旦工具调用与结果被拆开'
    const latinSame = 'a'.repeat(cjkOnly.length)
    assert(
      estimateOne(cjkOnly) > estimateOne(latinSame),
      'the same number of CJK characters must cost more tokens than Latin ones — ' +
        'a heuristic that treats them alike is what caused the 53% underestimate',
    )
  }

  // ── 散文判别器：冒充者一个都不能放进来 ──
  //
  // 判成散文 = 用 4.5 而不是 3.5 字符/token，**向低估偏 29%**。低估是会炸的方向，
  // 所以这一节才是本次改动真正的风险面：比例取值有实测撑着，判别器没有。
  //
  // 下面每一条都是「没有标点、看着像自然语言」但**实际比日志还密**的东西。
  {
    const b64 =
      'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGJhc2U2NCBibG9iIHRoYXQgY29udGFpbnMgbm8gcHVuY3R1' +
      'YXRpb24gd2hhdHNvZXZlciBhbmQgd291bGQgYmUgbWlzdGFrZW4gZm9yIHByb3NlIGJ5IGEgbmFp' +
      'dmUgcHVuY3R1YXRpb24gZGVuc2l0eSB0ZXN0IGFsb25l'
    const hexDump = Array.from({ length: 120 }, (_, i) =>
      (i * 37).toString(16).padStart(2, '0'),
    ).join(' ')
    const uuids = Array.from(
      { length: 8 },
      (_, i) => `3f2b8a${i}c-9d1e-4f77-b0a2-5c6e7d8f90a${i}`,
    ).join(' ')
    const numbers = Array.from({ length: 90 }, (_, i) => String(1700000000 + i * 7)).join(
      ' ',
    )
    const spacedHash = Array.from({ length: 6 }, (_, i) =>
      'a1b2c3d4e5f60718293a4b5c6d7e8f90'.slice(0, 32 - i),
    ).join(' ')

    const imposters: Array<[string, string]> = [
      ['base64 blob (no punctuation, one giant word)', b64],
      ['hex dump (short words, mostly digits)', hexDump],
      ['uuid list (long words, mixed digits)', uuids],
      ['bare timestamp column (digits only)', numbers],
      ['whitespace-separated hashes', spacedHash],
      ['json', JSON_BLOB],
      ['typescript', CODE],
      ['logs and stack traces', TOOL_OUT],
    ]
    for (const [name, text] of imposters) {
      assert(
        !looksProseText(text),
        `${name} must NOT be treated as prose — prose gets 4.5 chars/token, ` +
          `and everything here is denser than the 3.5 default, so misclassifying it underestimates`,
      )
    }

    // 反面：真正的散文必须认得出来，否则这个类白加了
    const proseSamples: Array<[string, string]> = [
      ['the english fixture', EN],
      [
        'a user question',
        'can you explain why the compaction step keeps discarding the tool results ' +
          'before the assistant has had a chance to read them back in the next turn',
      ],
      [
        'documentation paragraph',
        'The runtime records every message to an append only transcript so that a ' +
          'session can be resumed after a crash without replaying any provider calls.',
      ],
    ]
    for (const [name, text] of proseSamples) {
      assert(
        looksProseText(text),
        `${name} must be recognised as prose — otherwise the class is dead code ` +
          `and prose keeps its 41% overestimate`,
      )
    }

    // 这一类必须真的**改变结果**，而不是分了类但两边取值一样
    {
      const proseText = proseSamples[2]![1]
      const asProse = estimateOne(proseText)
      const dense = 'x'.repeat(proseText.length)
      assert(
        !looksProseText(dense) && asProse < estimateOne(dense),
        'the prose class is load-bearing: the same number of characters costs ' +
          'fewer tokens as prose than under the default ratio',
      )
    }
  }

  console.log(rows.join('\n'))
  console.log(
    `PASS: token estimate accuracy (worst under ${(worstUnder * 100).toFixed(1)}%, ` +
      `worst over +${(worstOver * 100).toFixed(1)}%)`,
  )
}

main()
