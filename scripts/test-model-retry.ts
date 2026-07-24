/**
 * Loop 韧性：错误分类 + callModel 有限退避
 * 运行：npx tsx scripts/test-model-retry.ts
 */
import {
  classifyError,
  isRetryableError,
  extractHttpStatus,
  wrapCallModelWithRetry,
  queryLoop,
  DEFAULT_MAX_MODEL_RETRIES,
  type CallModelFn,
  type QueryDeps,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type { ProviderStreamEvent } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function collect(
  gen: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

async function main() {
  // ── 1) classifyError ──
  assert(
    classifyError('OpenAI-compatible HTTP 429: rate limit').class ===
      'retryable',
    '429 → retryable',
  )
  assert(
    classifyError('HTTP 503: service unavailable').class === 'retryable',
    '503 → retryable',
  )
  assert(
    classifyError('fetch failed').class === 'retryable',
    'network → retryable',
  )
  assert(
    classifyError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
      .class === 'retryable',
    'TimeoutError → retryable',
  )
  assert(
    classifyError('invalid api key', { status: 401 } as never).class ===
      'fatal' ||
      classifyError({ message: 'invalid api key', status: 401 }).class ===
        'fatal',
    '401 → fatal',
  )
  assert(
    classifyError({ message: 'unauthorized', status: 401 }).class === 'fatal',
    '401 object → fatal',
  )
  assert(
    classifyError('Prompt is too long').class === 'fatal' &&
      classifyError('Prompt is too long').reason === 'prompt_too_long',
    'PTL → fatal (not model-retry)',
  )
  assert(
    !isRetryableError('Prompt is too long'),
    'PTL not isRetryable',
  )
  assert(extractHttpStatus('HTTP 429: x') === 429, 'extract 429')
  assert(DEFAULT_MAX_MODEL_RETRIES === 3, 'default max model retries')

  const ac = new AbortController()
  ac.abort()
  assert(
    classifyError(new Error('something'), { signal: ac.signal }).class ===
      'user_abort',
    'signal aborted → user_abort',
  )
  assert(
    classifyError(Object.assign(new Error('The user aborted a request'), {
      name: 'AbortError',
    })).class === 'user_abort',
    'AbortError → user_abort',
  )

  // ── 2) wrapCallModelWithRetry：429 流错误后成功 ──
  let calls = 0
  const flaky: CallModelFn = async function* () {
    calls += 1
    if (calls === 1) {
      yield {
        type: 'error',
        message: 'OpenAI-compatible HTTP 429: Too Many Requests',
      }
      yield { type: 'done' }
      return
    }
    yield { type: 'text_delta', text: 'ok-after-retry' }
    yield { type: 'done' }
  }

  const retries: Array<{ attempt: number; reason: string }> = []
  const wrapped = wrapCallModelWithRetry(flaky, {
    maxRetries: 3,
    baseDelayMs: 1,
    sleep: async () => {},
  })
  const events = await collect(
    wrapped({
      messages: [{ role: 'user', content: 'hi' }],
      onModelRetry: (info) => {
        retries.push({ attempt: info.attempt, reason: info.reason })
      },
    } as Parameters<CallModelFn>[0]),
  )
  assert(calls === 2, `expected 2 calls, got ${calls}`)
  assert(retries.length === 1, `expected 1 retry event, got ${retries.length}`)
  assert(retries[0]!.reason === 'rate_limit', 'retry reason rate_limit')
  assert(
    events.some((e) => e.type === 'text_delta' && e.text === 'ok-after-retry'),
    'got success text',
  )
  assert(
    !events.some(
      (e) => e.type === 'error' && String(e.message).includes('429'),
    ),
    '429 not surfaced after successful retry',
  )

  // ── 3) abort 不重试 ──
  let abortCalls = 0
  const aborting: CallModelFn = async function* ({ signal }) {
    abortCalls += 1
    if (signal?.aborted) {
      const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
      throw err
    }
    yield { type: 'error', message: 'HTTP 503: unavailable' }
    yield { type: 'done' }
  }
  const ac2 = new AbortController()
  ac2.abort()
  const wrappedAbort = wrapCallModelWithRetry(aborting, {
    maxRetries: 5,
    baseDelayMs: 1,
    sleep: async () => {},
  })
  const abortEvents = await collect(
    wrappedAbort({
      messages: [{ role: 'user', content: 'x' }],
      signal: ac2.signal,
    }),
  )
  assert(abortCalls <= 1, `abort should not retry, calls=${abortCalls}`)
  assert(
    abortEvents.some((e) => e.type === 'error'),
    'abort yields error',
  )

  // ── 4) fatal 不重试 ──
  let fatalCalls = 0
  const fatalFn: CallModelFn = async function* () {
    fatalCalls += 1
    yield { type: 'error', message: 'HTTP 401: invalid api key' }
    yield { type: 'done' }
  }
  const wrappedFatal = wrapCallModelWithRetry(fatalFn, {
    maxRetries: 5,
    baseDelayMs: 1,
    sleep: async () => {},
  })
  await collect(
    wrappedFatal({ messages: [{ role: 'user', content: 'x' }] }),
  )
  assert(fatalCalls === 1, `fatal no retry, calls=${fatalCalls}`)

  // ── 5) queryLoop 接线：model_retry 事件 + 最终 completed ──
  let qlCalls = 0
  const qlModel: CallModelFn = async function* () {
    qlCalls += 1
    if (qlCalls === 1) {
      yield { type: 'error', message: 'HTTP 429: rate limited' }
      yield { type: 'done' }
      return
    }
    yield { type: 'text_delta', text: 'done' }
    yield { type: 'done' }
  }
  const qlRetries: number[] = []
  const deps: QueryDeps = {
    callModel: wrapCallModelWithRetry(qlModel, {
      maxRetries: 2,
      baseDelayMs: 1,
      sleep: async () => {},
    }),
    prepareMessages: async ({ messages }) => ({ messages }),
    uuid: () => 'id_test',
  }
  const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]
  const terminal = await queryLoop({
    sessionId: 's1',
    cwd: process.cwd(),
    hooks: {},
    messages,
    deps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    maxTurns: 3,
    maxPtlRetries: 0,
    onEvent: (e) => {
      if (e.type === 'model_retry') qlRetries.push(e.attempt)
    },
  })
  assert(terminal.reason === 'completed', `terminal=${terminal.reason}`)
  assert(qlCalls === 2, `queryLoop calls=${qlCalls}`)
  assert(qlRetries.length === 1, `queryLoop model_retry events=${qlRetries.length}`)

  // ── 6) PTL 仍走 fatal 分类，不进 model retry 计数 ──
  let ptlCalls = 0
  const ptlModel: CallModelFn = async function* () {
    ptlCalls += 1
    yield { type: 'error', message: 'Prompt is too long' }
    yield { type: 'done' }
  }
  let modelRetryOnPtl = 0
  const wrappedPtl = wrapCallModelWithRetry(ptlModel, {
    maxRetries: 5,
    baseDelayMs: 1,
    sleep: async () => {},
  })
  await collect(
    wrappedPtl({
      messages: [{ role: 'user', content: 'x' }],
      onModelRetry: () => {
        modelRetryOnPtl += 1
      },
    } as Parameters<CallModelFn>[0]),
  )
  assert(ptlCalls === 1, 'PTL not model-retried')
  assert(modelRetryOnPtl === 0, 'no model_retry for PTL')

  console.log('OK test-model-retry')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})