/**
 * P1：限流时尊重服务端给的等待时间
 *
 * 现状（本测试建立前）：退避纯指数 500ms→1s→2s，3 次约 3.5 秒就放弃。
 * provider 说「20 秒后再试」时，Bolo 3.5 秒内烧完重试次数，
 * 然后整轮失败——用户刚说的话和模型跑了一半的工作一起没了。
 *
 * 契约：
 * - 解析 `retry-after`（秒 / HTTP-date）与 `retry-after-ms`
 * - 实际等待取 max(指数退避, 服务端要求)
 * - 但服务端要求超过上限时**不再干等**，直接失败并告诉用户还要等多久
 *
 * 运行：npx tsx scripts/test-retry-after.ts
 */
import {
  MAX_HONORED_RETRY_AFTER_MS,
  formatRetryWait,
  parseRetryAfterMs,
} from '../packages/providers/src/index.ts'
import {
  classifyError,
  wrapCallModelWithRetry,
  type ModelRetryInfo,
} from '../packages/core/src/index.ts'
import type { ProviderStreamEvent } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 最小 Headers 替身：只要有 get() */
function headers(map: Record<string, string>): { get(n: string): string | null } {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v
  return { get: (n: string) => lower[n.toLowerCase()] ?? null }
}

const NOW = Date.parse('2026-07-26T10:00:00.000Z')

async function main() {
  // ── 1) delta-seconds ──
  assert(
    parseRetryAfterMs(headers({ 'retry-after': '20' }), NOW) === 20_000,
    'retry-after seconds parsed',
  )
  assert(
    parseRetryAfterMs(headers({ 'Retry-After': '1' }), NOW) === 1_000,
    'header lookup is case-insensitive',
  )
  assert(
    parseRetryAfterMs(headers({ 'retry-after': '0' }), NOW) === 0,
    'zero is a valid immediate retry',
  )

  // ── 2) HTTP-date ──
  assert(
    parseRetryAfterMs(
      headers({ 'retry-after': 'Sun, 26 Jul 2026 10:00:30 GMT' }),
      NOW,
    ) === 30_000,
    'HTTP-date parsed relative to now',
  )
  // 过去的时间 → 0，不产生负等待
  assert(
    parseRetryAfterMs(
      headers({ 'retry-after': 'Sun, 26 Jul 2026 09:59:00 GMT' }),
      NOW,
    ) === 0,
    'past date clamps to zero',
  )

  // ── 3) retry-after-ms（部分 provider 用） ──
  assert(
    parseRetryAfterMs(headers({ 'retry-after-ms': '1500' }), NOW) === 1_500,
    'retry-after-ms parsed',
  )
  // 两者都在时取更精确的 ms
  assert(
    parseRetryAfterMs(
      headers({ 'retry-after': '5', 'retry-after-ms': '1500' }),
      NOW,
    ) === 1_500,
    'retry-after-ms wins over coarse seconds',
  )

  // ── 4) 缺失 / 垃圾值 → undefined，绝不瞎猜 ──
  assert(parseRetryAfterMs(headers({}), NOW) === undefined, 'absent → undefined')
  assert(
    parseRetryAfterMs(headers({ 'retry-after': 'soon' }), NOW) === undefined,
    'garbage → undefined',
  )
  assert(
    parseRetryAfterMs(headers({ 'retry-after': '-5' }), NOW) === undefined,
    'negative → undefined',
  )
  assert(parseRetryAfterMs(undefined, NOW) === undefined, 'no headers → undefined')

  // ── 5) 分类器透传 retryAfterMs ──
  const classified = classifyError(
    { message: 'HTTP 429: rate limited', status: 429, retryAfterMs: 20_000 },
    {},
  )
  assert(classified.class === 'retryable', '429 stays retryable')
  assert(
    classified.retryAfterMs === 20_000,
    'classifier carries the server-provided wait',
  )
  const noHint = classifyError({ message: 'HTTP 429', status: 429 }, {})
  assert(
    noHint.retryAfterMs === undefined,
    'no hint present when server did not send one',
  )

  // ── 6) 实际等待 = max(退避, 服务端要求) ──
  {
    const slept: number[] = []
    const retries: ModelRetryInfo[] = []
    let calls = 0
    const inner = async function* (): AsyncIterable<ProviderStreamEvent> {
      calls += 1
      if (calls === 1) {
        yield {
          type: 'error',
          message: 'HTTP 429: slow down',
          status: 429,
          retryAfterMs: 20_000,
        } as ProviderStreamEvent
        yield { type: 'done' }
        return
      }
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    }
    const wrapped = wrapCallModelWithRetry(inner, {
      maxRetries: 3,
      baseDelayMs: 500,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    const out: string[] = []
    for await (const ev of wrapped({
      messages: [],
      onModelRetry: (i: ModelRetryInfo) => retries.push(i),
    } as never)) {
      if (ev.type === 'text_delta') out.push(ev.text)
    }
    assert(out.join('') === 'ok', 'retry eventually succeeds')
    assert(slept.length === 1, 'slept exactly once')
    assert(
      slept[0] === 20_000,
      `honored server wait, slept ${slept[0]}ms (exponential backoff would be ~500)`,
    )
    assert(
      retries[0]?.delayMs === 20_000,
      'reported delay matches the honored wait',
    )
  }

  // ── 7) 服务端没给提示时，仍走原来的指数退避 ──
  {
    const slept: number[] = []
    let calls = 0
    const inner = async function* (): AsyncIterable<ProviderStreamEvent> {
      calls += 1
      if (calls === 1) {
        yield { type: 'error', message: 'HTTP 503: upstream' }
        yield { type: 'done' }
        return
      }
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    }
    const wrapped = wrapCallModelWithRetry(inner, {
      maxRetries: 3,
      baseDelayMs: 500,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    for await (const _ of wrapped({ messages: [] } as never)) {
      /* drain */
    }
    assert(slept.length === 1, 'still retries without a hint')
    assert(
      slept[0]! >= 500 && slept[0]! < 1_000,
      `falls back to exponential backoff, got ${slept[0]}`,
    )
  }

  // ── 8) 要求等待超过上限 → 不干等，失败并说清还要多久 ──
  {
    const slept: number[] = []
    let calls = 0
    const inner = async function* (): AsyncIterable<ProviderStreamEvent> {
      calls += 1
      yield {
        type: 'error',
        message: 'HTTP 429: quota exhausted',
        status: 429,
        retryAfterMs: 3_600_000,
      } as ProviderStreamEvent
      yield { type: 'done' }
    }
    const wrapped = wrapCallModelWithRetry(inner, {
      maxRetries: 3,
      baseDelayMs: 500,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    let errMsg = ''
    for await (const ev of wrapped({ messages: [] } as never)) {
      if (ev.type === 'error') errMsg = ev.message
    }
    assert(
      slept.length === 0,
      'never sleeps past the cap — hanging the CLI for an hour is not a fix',
    )
    assert(calls === 1, 'does not burn retries on a wait it will not honor')
    assert(
      /rate limit|retry|wait/i.test(errMsg),
      `error explains the situation, got: ${errMsg}`,
    )
    assert(
      errMsg.includes(formatRetryWait(3_600_000)),
      `error tells the user how long the provider asked to wait, got: ${errMsg}`,
    )
    assert(
      errMsg.includes(formatRetryWait(MAX_HONORED_RETRY_AFTER_MS)),
      `error states the auto-retry limit, got: ${errMsg}`,
    )
    assert(
      /nothing was sent/i.test(errMsg),
      `error reassures that no request went through, got: ${errMsg}`,
    )
    assert(
      /provider use|switch/i.test(errMsg),
      `error offers a next step, got: ${errMsg}`,
    )
    assert(
      MAX_HONORED_RETRY_AFTER_MS > 0 && MAX_HONORED_RETRY_AFTER_MS <= 300_000,
      'cap is a sane bound',
    )
  }

  // ── 9) provider 真的把响应头带出来（不是只有契约层能跑通） ──
  {
    const { createOpenAICompatibleProvider } = await import(
      '../packages/providers/src/openaiCompatible.ts'
    )
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{"error":"slow down"}', {
        status: 429,
        headers: { 'retry-after': '20', 'content-type': 'application/json' },
      })) as typeof globalThis.fetch

    try {
      const provider = createOpenAICompatibleProvider({
        baseUrl: 'https://example.invalid/v1',
        model: 'test-model',
        apiKey: 'test-key',
      })
      let errEvent: ProviderStreamEvent | undefined
      for await (const ev of provider.completeStream(
        [{ role: 'user', content: 'hi' }],
        {},
      )) {
        if (ev.type === 'error') errEvent = ev
      }
      assert(errEvent !== undefined, 'provider surfaced the HTTP failure')
      assert(
        errEvent!.type === 'error' && errEvent!.status === 429,
        'provider attached the HTTP status',
      )
      assert(
        errEvent!.type === 'error' && errEvent!.retryAfterMs === 20_000,
        `provider attached the server wait, got ${
          errEvent!.type === 'error' ? errEvent!.retryAfterMs : 'n/a'
        }`,
      )
      // 端到端：分类器也要认得它
      const c = classifyError(errEvent, {})
      assert(c.class === 'retryable', 'classified as retryable')
      assert(c.retryAfterMs === 20_000, 'wait survives classification')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  console.log('PASS: retry-after honoring')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
