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
  formatEffortCapabilityStatus,
  listEffortChoosable,
  assertEffortChoosable,
  anthropicMaxAllowed,
  describeEffortCapability,
  buildEffortPickerItems,
  activeEffortPickerIndex,
  isAcceptableEffortInput,
  DIALECT_DEEPSEEK_CHAT,
  createOpenAICompatibleProvider,
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
    {
      stream: true,
      effort: 'max',
      tools: [
        {
          name: 'Bash',
          description: 'x',
          requiresPermission: true,
        },
      ],
      isAgent: true,
    },
  )
  assert(body.reasoning_effort === 'max', 'compatible body reasoning_effort max')
  assert(body.max_tokens === 4096, 'compatible keeps max_tokens')
}

// Regression: model metadata is a hard ceiling, not an effort multiplier base.
{
  const deepseek = buildOpenAICompatibleRequestBody(
    msgs,
    {
      model: 'deepseek-v4-flash',
      maxTokens: 384_000,
      maxOutputTokens: 384_000,
      effortDialect: 'deepseek-chat',
    },
    { effort: 'max', stream: true, isAgent: true },
  )
  assert(
    deepseek.max_tokens === 384_000,
    'deepseek max effort stays within 384K output ceiling',
  )
  assert(
    deepseek.reasoning_effort === 'max',
    'deepseek max effort keeps reasoning_effort',
  )

  const legacy = buildOpenAICompatibleRequestBody(
    msgs,
    {
      model: 'generic-model',
      maxTokens: 384_000,
      maxOutputTokens: 384_000,
      effortDialect: 'max-tokens',
    },
    { effort: 'max', stream: true },
  )
  assert(
    legacy.max_tokens === 384_000,
    'max-tokens scaling is clamped to the output ceiling',
  )
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

{
  const body = buildResponsesRequest(
    msgs,
    {
      model: 'gpt-5.6',
      maxTokens: 128_000,
      maxOutputTokens: 128_000,
      effortDialect: 'openai-responses',
    },
    { effort: 'max', maxTokens: 256_000, isAgent: true },
  )
  const re = (body as { reasoning?: { effort?: string } }).reasoning
  assert(body.max_output_tokens === 128_000, 'responses output ceiling')
  assert(re?.effort === 'max', 'responses max reasoning effort preserved')
}

// Full provider path: the serialized request must keep the catalog ceiling.
{
  const requestBodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(
      JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    )
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch
  try {
    const provider = createOpenAICompatibleProvider({
      apiKey: 'test-only-key',
      baseUrl: 'https://provider.test/v1',
      model: 'deepseek-v4-flash',
      maxTokens: 384_000,
      maxOutputTokens: 384_000,
      effortDialect: 'deepseek-chat',
    })
    for await (const _event of provider.completeStream(msgs, {
      effort: 'max',
      tools: [
        {
          name: 'Bash',
          description: 'x',
          requiresPermission: true,
        },
      ],
    })) {
      // Drain the mock SSE stream so the serialized request is captured.
    }
    const captured = requestBodies[0]
    assert(captured?.max_tokens === 384_000, 'provider sends 384K max_tokens')
    assert(
      captured?.reasoning_effort === 'max',
      'provider sends max reasoning_effort',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

// Non-streaming provider path is used by compact/classifier helpers.
{
  let captured: Record<string, unknown> | undefined
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const provider = createOpenAICompatibleProvider({
      apiKey: 'test-only-key',
      baseUrl: 'https://provider.test/v1',
      model: 'deepseek-v4-flash',
      maxTokens: 384_000,
      maxOutputTokens: 384_000,
      effortDialect: 'deepseek-chat',
    })
    await provider.completeText?.(msgs, {
      effort: 'max',
      maxTokens: 768_000,
    })
    assert(captured?.max_tokens === 384_000, 'completeText output ceiling')
    assert(
      captured?.reasoning_effort === 'max',
      'completeText reasoning effort preserved',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
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

  const capped = buildAnthropicRequestBody(
    msgs,
    {
      model: 'claude-opus-4-6',
      maxTokens: 128_000,
      maxOutputTokens: 64_000,
      effortDialect: 'anthropic-output',
    },
    {
      effort: 'high',
      maxTokens: 256_000,
      anthropicThinking: 100_000,
      stream: true,
      isAgent: true,
    },
  )
  const cappedThinking = capped.body.thinking as
    | { budget_tokens?: number }
    | undefined
  assert(capped.body.max_tokens === 64_000, 'anthropic output ceiling')
  assert(
    cappedThinking?.budget_tokens === 63_999,
    'anthropic thinking uses the clamped max_tokens',
  )
}

// ── E6/E7/E8：choosable · anthropic max gate · picker ──
{
  const ds = listEffortChoosable('deepseek-chat', { isAgent: true })
  assert(ds.includes('auto') && ds.includes('high') && ds.includes('max'), 'ds choosable core')
  // strict：builtin choosable 只推 wire 真值，不推 fold 别名
  assert(!ds.includes('low') && !ds.includes('medium'), 'ds hides fold aliases')
  assert(assertEffortChoosable('deepseek-chat', 'high', {}).ok, 'ds high ok')
  assert(!assertEffortChoosable('deepseek-chat', 'low', {}).ok, 'ds low reject strict')
  assert(!assertEffortChoosable('deepseek-chat', 'nope', {}).ok, 'ds nope reject')

  const sonnet = 'claude-sonnet-4-20250514'
  assert(!anthropicMaxAllowed(sonnet), 'sonnet no max')
  assert(anthropicMaxAllowed('claude-opus-4-6'), 'opus max ok')
  const blockMax = assertEffortChoosable('anthropic-output', 'max', {
    model: sonnet,
  })
  assert(!blockMax.ok, 'sonnet max blocked')
  const allowHigh = assertEffortChoosable('anthropic-output', 'high', {
    model: sonnet,
  })
  assert(allowHigh.ok, 'sonnet high ok')
  const opusMax = assertEffortChoosable('anthropic-output', 'max', {
    model: 'claude-opus-4-6',
  })
  assert(opusMax.ok, 'opus max ok')

  const cap = describeEffortCapability({
    effortLevel: 'high',
    dialect: 'anthropic-output',
    model: sonnet,
  })
  assert(cap.choosable.includes('high'), 'cap has high')
  assert(!cap.choosable.includes('max'), 'cap hides max on sonnet')
  assert(cap.warnings.some((w) => w.includes('max')), 'cap warns max')

  // CX2：gpt-4o 裁 xhigh（openai-responses 方言含 xhigh）
  const oai = listEffortChoosable('openai-responses', {
    model: 'gpt-4o-2024-08-06',
  })
  assert(oai.includes('high'), 'oai has high')
  assert(!oai.includes('xhigh'), 'oai gpt-4o hides xhigh')

  const status = formatEffortCapabilityStatus({
    effortLevel: 'auto',
    dialect: 'deepseek-chat',
  })
  assert(status.includes('choosable'), 'capability status')

  const items = buildEffortPickerItems({
    dialect: 'deepseek-chat',
    isAgent: true,
    effortLevel: 'high',
  })
  assert(items.some((it) => it.id === 'high'), 'picker has high')
  assert(!items.some((it) => it.id === 'low'), 'picker no low')
  assert(
    activeEffortPickerIndex({
      dialect: 'deepseek-chat',
      isAgent: true,
      effortLevel: 'high',
    }) >= 0,
    'picker index',
  )
}

console.log('ok: effort-dialect E1–E9')
