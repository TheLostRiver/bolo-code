/**
 * AR2A0b：truncateMiddle（保头保尾 + 原始行数/token 标注 + 幂等）
 * + 表驱动 per-tool 输出预算
 * 运行：npx tsx scripts/test-truncate-middle.ts
 */
import {
  truncateMiddle,
  toolOutputBudgetBytes,
  estimateTextTokens,
  DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
  TOOL_OUTPUT_BUDGET_BYTES,
  MIDDLE_TRUNCATION_MARKER,
} from '../packages/compact/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // ── 1) 短文本不动 ──
  const short = truncateMiddle('hello world', { maxChars: 100 })
  assert(short.truncated === false, 'short text untouched')
  assert(short.text === 'hello world', 'short text identical')
  assert(short.originalChars === 11, 'short originalChars')

  // ── 2) 长文本：保头保尾 + 标注原始行数/token ──
  const lines: string[] = []
  for (let i = 0; i < 200; i++) lines.push(`line-${String(i).padStart(4, '0')} content`)
  const long = lines.join('\n')
  const r = truncateMiddle(long, { maxChars: 400 })
  assert(r.truncated === true, 'long text truncated')
  assert(r.originalChars === long.length, 'originalChars recorded')
  assert(r.originalLines === 200, 'originalLines recorded')
  assert(
    r.estimatedOriginalTokens === estimateTextTokens(long),
    'estimatedOriginalTokens uses shared heuristic',
  )
  assert(r.text.includes(MIDDLE_TRUNCATION_MARKER), 'marker present')
  assert(r.text.includes(`${r.originalLines} lines`), 'marker shows line count')
  assert(
    r.text.includes(`~${r.estimatedOriginalTokens} tokens`),
    'marker shows token estimate',
  )
  assert(r.text.startsWith('line-0000'), 'head kept')
  assert(r.text.endsWith(lines[199]!), 'tail kept')
  // 保留正文（去掉标注行）约等于预算
  const bodyLen = r.text.length - (r.text.length - 400 > 0 ? 0 : 0)
  assert(bodyLen >= 400 && r.text.length <= 400 + 200, 'kept chars ≈ budget (+marker)')

  // ── 3) headFraction ──
  const hf = truncateMiddle('a'.repeat(1000) + 'z'.repeat(1000), {
    maxChars: 100,
    headFraction: 0.6,
  })
  assert(hf.text.startsWith('a'.repeat(60)), 'headFraction head size')
  assert(hf.text.endsWith('z'.repeat(40)), 'headFraction tail size')

  // ── 4) 幂等：已含标注的文本不再二次截断 ──
  const again = truncateMiddle(r.text, { maxChars: 100 })
  assert(again.truncated === false, 'idempotent on marked text')
  assert(again.text === r.text, 'marked text unchanged')

  // ── 5) 预算表：显式覆盖 > per-tool 表 > 默认 ──
  assert(
    DEFAULT_TOOL_OUTPUT_BUDGET_BYTES === 10_000,
    'default budget 10k bytes',
  )
  assert(
    toolOutputBudgetBytes('Bash') === TOOL_OUTPUT_BUDGET_BYTES.Bash,
    'per-tool budget from table',
  )
  assert(
    toolOutputBudgetBytes('UnknownTool') === DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
    'unknown tool falls back to default',
  )
  assert(
    toolOutputBudgetBytes(undefined) === DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
    'missing tool name falls back to default',
  )
  assert(
    toolOutputBudgetBytes('Bash', 12_345) === 12_345,
    'explicit override wins',
  )
  assert(
    (TOOL_OUTPUT_BUDGET_BYTES.Read ?? 0) > (TOOL_OUTPUT_BUDGET_BYTES.Bash ?? 0),
    'Read budget larger than Bash (file reads need more room)',
  )

  console.log('TRUNCATE MIDDLE TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
