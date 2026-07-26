/**
 * C1：prompt cache 命中时，usage 锚不得低估真实 prompt 体积
 *
 * 两家 provider 的 input 语义**不同**：
 * - Anthropic：`input_tokens` **不含** cache_read / cache_creation，三者相加才是真实 prompt
 * - OpenAI：`prompt_tokens` **已含** cached，`cached_tokens` 只是其中的明细
 *
 * Bolo 两边都照抄 input 当锚。于是在 Anthropic + 缓存生效时，
 * 锚只反映未命中的那一小截尾巴——**缓存越有效，低估越离谱**，
 * auto-compact 几乎永远不触发，一路涨到硬性 PTL 才炸。
 *
 * 反过来，若无脑给所有 provider 加上 cache token，OpenAI 就会被重复计数、
 * 过早压缩。所以语义必须显式标注，不能猜。
 *
 * 运行：npx tsx scripts/test-usage-anchor-cache.ts
 */
import {
  parseAnthropicStreamUsage,
  parseOpenAIStreamUsage,
} from '../packages/providers/src/index.ts'
import {
  accumulateSessionUsage,
  createEmptySessionUsage,
  getSessionUsageAnchor,
  normalizeProviderUsage,
} from '../packages/core/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // ── 1) 解析层保留各自的 input 语义，并标注它 ──
  const ant = parseAnthropicStreamUsage({
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 300,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 1_200,
        output_tokens: 0,
      },
    },
  })
  assert(ant !== null, 'anthropic usage parsed')
  assert(ant!.inputTokens === 300, 'anthropic input_tokens kept verbatim')
  assert(ant!.cacheReadInputTokens === 40_000, 'cache read kept')
  assert(
    ant!.inputExcludesCache === true,
    'anthropic input is marked as excluding cache',
  )

  const oai = parseOpenAIStreamUsage({
    usage: {
      prompt_tokens: 41_500,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 40_000 },
    },
  })
  assert(oai !== null, 'openai usage parsed')
  assert(oai!.inputTokens === 41_500, 'openai prompt_tokens kept verbatim')
  assert(oai!.cacheReadInputTokens === 40_000, 'openai cached tokens kept')
  assert(
    oai!.inputExcludesCache !== true,
    'openai prompt_tokens already includes cache — must not be marked',
  )

  // ── 2) 锚：Anthropic 必须把 cache 加回来 ──
  {
    const usage = createEmptySessionUsage()
    accumulateSessionUsage(usage, {
      ...normalizeProviderUsage(ant!)!,
      messageCountAtCall: 12,
    })
    const anchor = getSessionUsageAnchor({ usage })
    assert(anchor !== undefined, 'anchor produced')
    assert(
      anchor!.anchorInputTokens === 300 + 40_000 + 1_200,
      `anchor reflects the real prompt size, got ${anchor!.anchorInputTokens}`,
    )
    assert(anchor!.anchoredMessageCount === 12, 'anchor keeps message count')
  }

  // ── 3) 锚：OpenAI 不得重复计入 ──
  {
    const usage = createEmptySessionUsage()
    accumulateSessionUsage(usage, {
      ...normalizeProviderUsage(oai!)!,
      messageCountAtCall: 12,
    })
    const anchor = getSessionUsageAnchor({ usage })
    assert(anchor !== undefined, 'anchor produced')
    assert(
      anchor!.anchorInputTokens === 41_500,
      `openai anchor unchanged, got ${anchor!.anchorInputTokens}`,
    )
  }

  // ── 4) 无缓存的 Anthropic 调用：加零，行为不变 ──
  {
    const plain = parseAnthropicStreamUsage({
      type: 'message_start',
      message: { usage: { input_tokens: 5_000, output_tokens: 0 } },
    })
    const usage = createEmptySessionUsage()
    accumulateSessionUsage(usage, {
      ...normalizeProviderUsage(plain!)!,
      messageCountAtCall: 3,
    })
    const anchor = getSessionUsageAnchor({ usage })
    assert(
      anchor!.anchorInputTokens === 5_000,
      `no cache means no adjustment, got ${anchor!.anchorInputTokens}`,
    )
  }

  // ── 5) 估算 usage 仍然不产生锚（回归） ──
  {
    const usage = createEmptySessionUsage()
    accumulateSessionUsage(usage, {
      inputTokens: 9_000,
      outputTokens: 10,
      estimated: true,
      messageCountAtCall: 4,
    })
    assert(
      getSessionUsageAnchor({ usage }) === undefined,
      'estimated usage never anchors',
    )
  }

  // ── 6) 成本计算不受影响：input 与 cache 仍是各自独立的计价项 ──
  {
    const delta = normalizeProviderUsage(ant!)!
    assert(
      delta.inputTokens === 300,
      'cost still sees the uncached input only — folding cache in would double-charge',
    )
    assert(delta.cacheReadInputTokens === 40_000, 'cache read still itemized')
  }

  console.log('PASS: usage anchor accounts for cached prompt tokens')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
