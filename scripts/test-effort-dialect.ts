/**
 * Effort 方言引擎单测（E1–E3）
 * 运行：node --import tsx scripts/test-effort-dialect.ts
 */

import {
  resolveEffortWire,
  resolveEffortDialect,
  applyBodyPatches,
  detectEffortDialectId,
  formatEffortStatusLine,
  isAcceptableEffortInput,
  DIALECT_DEEPSEEK_CHAT,
  DIALECT_OPENAI_RESPONSES,
  DIALECT_MAX_TOKENS,
  buildOpenAICompatibleRequestBody,
  buildResponsesRequest,
  buildAnthropicRequestBody,
} from '../packages/providers/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import { normalizeEffortDialectFromConfig } from '../packages/config/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const msgs: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
]

// ── resolve DeepSeek ──
{
  const d = resolveEffortDialect('deepseek-chat')
  assert(d.id === 'deepseek-chat', 'builtin deepseek id')

  const low = resolveEffortWire(d, 'low', { isAgent: true })
  assert(low.ok, 'low ok')
  if (low.ok) {
    assert(low.resolvedWire === 'high', 'low→high')
    assert(low.display.includes('→'), 'display fold')
  }

  const xh = resolveEffortWire(d, 'xhigh', {})
  assert(xh.ok && xh.ok && xh.resolvedWire === 'max', 'xhigh→max')

  const ultra = resolveEffortWire(d, 'ultra', {})
  assert(ultra.ok && ultra.ok && ultra.resolvedWire === 'max', 'ultra→max')

  const ag = resolveEffortWire(d, 'auto', { isAgent: true })
  assert(ag.ok && ag.ok && ag.resolvedWire === 'max', 'agent auto→max')

  const chat = resolveEffortWire(d, 'auto', { isAgent: false })
  assert(chat.ok && chat.ok && chat.resolvedWire == null, 'chat auto omit')

  const body: Record<string, unknown> = { model: 'x', max_tokens: 100 }
  if (low.ok) applyBodyPatches(body, low.patches)
  assert(body.reasoning_effort === 'high', 'patch reasoning_effort')
}

// ── OpenAI responses ──
{
  const d = resolveEffortDialect('openai-responses')
  const p = resolveEffortWire(d, 'xhigh', { isAgent: true })
  assert(p.ok && p.ok && p.resolvedWire === 'xhigh', 'oai xhigh')
  const body: Record<string, unknown> = { model: 'gpt' }
  if (p.ok) applyBodyPatches(body, p.patches)
  const re = body.reasoning as { effort?: string } | undefined
  assert(re?.effort === 'xhigh', 'nested reasoning.effort')
}

// ── max-tokens legacy ──
{
  const d = resolveEffortDialect('max-tokens')
  const p = resolveEffortWire(d, 'max', { baseMaxTokens: 8000 })
  assert(p.ok && p.ok && p.maxTokens === 16000, 'token scale 2x')
  assert(p.ok && p.patches.every((x) => x.op !== 'set' || false) || p.ok, 'no strength field')
  // wire shape none → no set patches with values for reasoning
  if (p.ok) {
    assert(
      p.patches.filter((x) => x.op === 'set').length === 0,
      'max-tokens no set patches',
    )
  }
}

// ── detect ──
assert(
  detectEffortDialectId({
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  }) === 'deepseek-chat',
  'detect deepseek',
)
assert(
  detectEffortDialectId({ kind: 'openai-responses', model: 'gpt-5.6' }) ===
    'openai-responses',
  'detect responses',
)

// ── buildOpenAICompatibleRequestBody ──
{
  const body = buildOpenAICompatibleRequestBody(
    msgs,
    {
      model: 'deepseek-chat',
      maxTokens: 4096,
      effortDialect: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
    },
    { stream: true, effort: 'max', tools: [{ name: 'Bash', description: 'x', inputSchema: {} }], isAgent: true },
  )
  assert(body.reasoning_effort === 'max', 'compatible body reasoning_effort max')
  assert(body.max_tokens === 4096, 'compatible keeps max_tokens')
}

// ── buildResponsesRequest ──
{
  const body = buildResponsesRequest(
    msgs,
    { model: 'gpt-5.6', effortDialect: 'openai-responses' },
    { effort: 'high', maxOutputTokens: 8192, isAgent: true },
  )
  const re = (body as { reasoning?: { effort?: string } }).reasoning
  assert(re?.effort === 'high', 'responses reasoning.effort high')
}

// ── config normalize ──
assert(
  normalizeEffortDialectFromConfig('deepseek-chat') === 'deepseek-chat',
  'config string',
)
assert(
  normalizeEffortDialectFromConfig({ dialect: 'openai-responses' }) ===
    'openai-responses',
  'config dialect key',
)

assert(isAcceptableEffortInput('xhigh'), 'accept xhigh')
assert(isAcceptableEffortInput('ultra'), 'accept ultra')
assert(!isAcceptableEffortInput(''), 'reject empty')

const status = formatEffortStatusLine({
  effortLevel: 'low',
  dialect: 'deepseek-chat',
  isAgent: true,
})
assert(status.includes('high'), 'status shows fold')
assert(status.includes('deepseek-chat'), 'status dialect')

// unknown intent reject on deepseek
{
  const bad = resolveEffortWire(DIALECT_DEEPSEEK_CHAT, 'not-a-level', {})
  assert(!bad.ok, 'reject unknown')
}

// ── Anthropic output_config.effort (E5) ──
{
  assert(
    detectEffortDialectId({ kind: 'anthropic', model: 'claude-sonnet-4' }) ===
      'anthropic-output',
    'detect anthropic',
  )
  const d = resolveEffortDialect('anthropic-output')
  const high = resolveEffortWire(d, 'high', { isAgent: true })
  assert(high.ok && high.ok && high.resolvedWire === 'high', 'ant high')
  const body: Record<string, unknown> = { model: 'claude', max_tokens: 1024 }
  if (high.ok) applyBodyPatches(body, high.patches)
  const oc = body.output_config as { effort?: string }
  assert(oc?.effort === 'high', 'ant output_config.effort')
  assert(
    high.ok &&
      high.requestHeaders?.['anthropic-beta']?.includes('effort-2025-11-24'),
    'ant beta on plan',
  )
  const xh = resolveEffortWire(d, 'xhigh', {})
  assert(xh.ok && xh.ok && xh.resolvedWire === 'max', 'ant xhigh→max')
  const auto = resolveEffortWire(d, 'auto', { isAgent: true })
  assert(auto.ok && auto.ok && auto.resolvedWire == null, 'ant auto omit')

  const built = buildAnthropicRequestBody(
    msgs,
    {
      model: 'claude-opus-4-6',
      maxTokens: 4096,
      effortDialect: 'anthropic-output',
    },
    { effort: 'medium', stream: true, isAgent: true },
  )
  const oc2 = built.body.output_config as { effort?: string }
  assert(oc2?.effort === 'medium', 'buildAnthropic body effort')
  assert(
    built.requestHeaders?.['anthropic-beta']?.includes('effort'),
    'buildAnthropic headers',
  )
  // thinking 独立：未传 anthropicThinking 则无 thinking 字段
  assert(built.body.thinking == null, 'effort does not force thinking')
}

console.log('ok: effort-dialect E1–E5')