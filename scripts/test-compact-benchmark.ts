/**
 * AR2B2 · compact 管道基准 + 回归阈值
 *
 * ROADMAP §13.10.2 对 AR2B2 的要求：固定中英文/tool/diff/长 JSON 语料，
 * 记录 token 偏差、compact 后成本、延迟与峰值内存，设回归阈值。
 *
 * 阈值分两档，因为可靠性不同：
 *
 * - **确定性指标严格断言**：消息不丢、tool pair 不拆、压缩比在带内、
 *   入参不被就地修改。这些与机器快慢无关，值多少就该是多少。
 * - **时延与内存只设「灾难阈」**：单机噪声大（GC、其它进程、CI 抖动），
 *   卡太紧只会制造假红灯，而假红灯会训练所有人无视红灯。
 *   所以这两项的阈值定在「明显出事」的量级，用来抓算法复杂度退化，
 *   不用来抓百分之几的波动。
 *
 * 语料刻意混合中文——本项目的历史里中文占比很高，而中文正是
 * token 估算此前失准最严重的地方（曾低估 53%，见
 * `test-token-estimate-accuracy.ts`）。只用英文语料做基准会掩盖它。
 *
 * 运行：npx tsx scripts/test-compact-benchmark.ts
 */
import {
  estimateTokens,
  findAtomicBlocks,
  runFullCompact,
  type CompactSummarizer,
} from '../packages/compact/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

/** 声明成断言函数，好让 `outcome.ok` 之后能收窄出 apiMessages */
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 压缩比下界：低于此说明摘要没起作用 */
const MIN_COMPRESSION = 3
/** 灾难时延阈（ms）——抓复杂度退化，不抓抖动 */
const MAX_WALL_MS = 8_000
/** 灾难内存阈（MB）——同上 */
const MAX_HEAP_GROWTH_MB = 320

const ZH_TEXT =
  '压缩绝不能拿可恢复性去换更高的压缩率。工具调用与其结果一旦被拆开，' +
  'provider 会直接拒绝整个请求，而那时原始历史已经被摘要替换掉，无法恢复。'
const EN_TEXT =
  'Compaction must never trade recoverability for a better compression ratio. ' +
  'When a tool call is separated from its result the provider rejects the request.'
const DIFF_TEXT = `--- a/packages/compact/src/index.ts
+++ b/packages/compact/src/index.ts
@@ -71,7 +71,7 @@
-export const DENSE_BYTES_PER_TOKEN = 2
+export const DENSE_BYTES_PER_TOKEN = 3
@@ -105,6 +105,9 @@
+  const cjk = countCjkChars(text)
+  const rest = text.length - cjk`

function toolSchemaJson(i: number): string {
  return JSON.stringify({
    tools: Array.from({ length: 6 }, (_, k) => ({
      name: `tool_${i}_${k}`,
      description: 'Reads a file from the local filesystem and returns its contents',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'number' } },
        required: ['path'],
      },
    })),
  })
}

/**
 * 造一段形状贴近真实会话的历史：user 提问 → assistant 回答 →
 * tool 调用 + 结果 → 后续回答。中英混排 + diff + 长 JSON。
 */
function buildHistory(turns: number): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < turns; i++) {
    out.push({
      role: 'user',
      content: i % 2 === 0 ? `${ZH_TEXT}（第 ${i} 轮）` : `${EN_TEXT} (turn ${i})`,
    })
    out.push({ role: 'assistant', content: `${EN_TEXT}\n${ZH_TEXT}` })
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: `call_${i}`, name: 'Read', arguments: JSON.stringify({ path: `src/f${i}.ts` }) },
      ],
    })
    out.push({
      role: 'tool',
      content: i % 3 === 0 ? DIFF_TEXT : toolSchemaJson(i),
      tool_call_id: `call_${i}`,
    })
    out.push({ role: 'assistant', content: `${ZH_TEXT}` })
  }
  return out
}

const summarize: CompactSummarizer = async () => ({
  text:
    '<summary>\n1. Primary Request and Intent:\n   Benchmark corpus.\n' +
    '8. Current Work:\n   Measuring compaction cost.\n</summary>',
})

function heapMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024)
}

async function main() {
  const rows: string[] = []

  for (const turns of [20, 80]) {
    const history = buildHistory(turns)
    const snapshot = JSON.stringify(history)
    const before = estimateTokens(history)

    if (global.gc) global.gc()
    const heapBefore = heapMb()
    const t0 = process.hrtime.bigint()
    const outcome = await runFullCompact({
      messages: history,
      trigger: 'auto',
      summarize,
      keepRecentUserTurns: 1,
    })
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6
    const heapGrowth = heapMb() - heapBefore

    assert(outcome.ok, `compact succeeds at ${turns} turns: ${JSON.stringify(outcome)}`)
    const after = estimateTokens(outcome.apiMessages)
    const ratio = before / Math.max(1, after)

    rows.push(
      `  turns=${String(turns).padStart(3)} msgs=${String(history.length).padStart(4)} ` +
        `tok ${String(before).padStart(6)}→${String(after).padStart(5)} ` +
        `×${ratio.toFixed(1)}  ${wallMs.toFixed(0)}ms  heap+${heapGrowth.toFixed(1)}MB`,
    )

    // ── 确定性断言 ──
    assert(
      JSON.stringify(history) === snapshot,
      `runFullCompact must not mutate its input at ${turns} turns — rollback depends on it`,
    )
    assert(
      after < before,
      `compaction reduces the estimate at ${turns} turns (${before} → ${after})`,
    )
    assert(
      ratio >= MIN_COMPRESSION,
      `compression at ${turns} turns is only ×${ratio.toFixed(1)}, below ×${MIN_COMPRESSION} — ` +
        'a summary that barely shrinks anything is not worth the API call',
    )
    // 压缩产物本身也不许留下拆开的 tool pair
    const orphan = outcome.apiMessages.some(
      (m, i) =>
        !!m.tool_calls?.length &&
        !outcome.apiMessages
          .slice(i + 1)
          .some((n) => n.role === 'tool'),
    )
    assert(
      !orphan,
      `compacted output leaves a tool_calls message with no result at ${turns} turns — provider would 400`,
    )
    assert(
      findAtomicBlocks(outcome.apiMessages).every(
        (b) => b.end > b.start && b.end <= outcome.apiMessages.length,
      ),
      `atomic blocks in the compacted output stay well formed at ${turns} turns`,
    )

    // ── 灾难阈（宽松，只抓复杂度退化）──
    assert(
      wallMs < MAX_WALL_MS,
      `compact took ${wallMs.toFixed(0)}ms at ${turns} turns, over the ${MAX_WALL_MS}ms disaster ceiling — ` +
        'this ceiling is for catching complexity regressions, so exceeding it means something got much worse',
    )
    assert(
      heapGrowth < MAX_HEAP_GROWTH_MB,
      `heap grew ${heapGrowth.toFixed(1)}MB at ${turns} turns, over the ${MAX_HEAP_GROWTH_MB}MB disaster ceiling`,
    )
  }

  // ── 裁判自检：孤儿检测器必须真能检出孤儿 ──
  // 若它永远返回 false，上面几条「不留孤儿」的断言就是空的。
  {
    const orphaned: ChatMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'x', name: 'Read', arguments: '{}' }],
      },
    ]
    const detect = (msgs: ChatMessage[]) =>
      msgs.some(
        (m, i) =>
          !!m.tool_calls?.length &&
          !msgs.slice(i + 1).some((n) => n.role === 'tool'),
      )
    assert(
      detect(orphaned),
      'the orphan detector really does flag a tool_calls message with no result — ' +
        'otherwise every "no orphan" assertion above proves nothing',
    )
    assert(
      !detect([...orphaned, { role: 'tool', content: 'o', tool_call_id: 'x' }]),
      'and it does not flag a properly paired call',
    )
  }

  // ── 规模不该带来超线性的时间 ──
  // 只做量级检查：4 倍输入若耗时涨到 20 倍以上，说明有二次行为。
  {
    const small = buildHistory(20)
    const big = buildHistory(80)
    const time = async (msgs: ChatMessage[]) => {
      const t = process.hrtime.bigint()
      await runFullCompact({
        messages: msgs,
        trigger: 'auto',
        summarize,
        keepRecentUserTurns: 1,
      })
      return Number(process.hrtime.bigint() - t) / 1e6
    }
    const a = await time(small)
    const b = await time(big)
    // 加常数下限避免小数字相除放大噪声
    const factor = (b + 5) / (a + 5)
    rows.push(`  scaling: 4× input → ${factor.toFixed(1)}× time`)
    assert(
      factor < 20,
      `4× the input took ${factor.toFixed(1)}× the time — suggests quadratic behaviour in the compact pipeline`,
    )
  }

  console.log(rows.join('\n'))
  console.log('PASS: compact benchmark')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
