/**
 * OI-11F: OpenAI Responses request abort diagnosis.
 *
 * The provider owns a timeout controller in addition to the caller signal.
 * Those two sources must remain distinguishable after fetch turns both into
 * an AbortError, otherwise a retryable timeout looks like a user interrupt.
 */
import {
  createOpenAIResponsesProvider,
  explainProviderError,
  type ProviderStreamEvent,
} from '../packages/providers/src/index.ts'
import { classifyError } from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realFetch = globalThis.fetch

function fakeTimers() {
  let now = 0
  let pending: Array<{ callback: () => void; at: number }> = []
  return {
    setTimer(callback: () => void, ms = 0) {
      const handle = { callback, at: now + ms }
      pending.push(handle)
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer(handle: unknown) {
      pending = pending.filter((entry) => entry !== handle)
    },
    advance(ms: number) {
      now += ms
      while (true) {
        const due = pending.filter((entry) => entry.at <= now)
        if (due.length === 0) return
        pending = pending.filter((entry) => entry.at > now)
        for (const entry of due) entry.callback()
      }
    },
    get pendingCount() {
      return pending.length
    },
  }
}

async function settled<T>(promise: Promise<T>, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    handle = realSetTimeout(
      () => reject(new Error(`${label} did not settle`)),
      1_000,
    )
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (handle) realClearTimeout(handle)
  }
}

async function collect(
  iterable: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function waitForAbort(
  capture: (signal: AbortSignal) => void,
): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal
    assert(signal instanceof AbortSignal, 'fetch receives an AbortSignal')
    capture(signal)
    return await new Promise<Response>((_resolve, reject) => {
      const fail = () => {
        const reason = signal.reason
        if (reason instanceof Error) {
          reject(reason)
          return
        }
        reject(
          Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError',
          }),
        )
      }
      if (signal.aborted) {
        fail()
      } else {
        signal.addEventListener('abort', fail, { once: true })
      }
    })
  }) as typeof fetch
}

async function withFakeTimers(
  run: (timers: ReturnType<typeof fakeTimers>) => Promise<void>,
): Promise<void> {
  const timers = fakeTimers()
  globalThis.setTimeout = timers.setTimer as typeof setTimeout
  globalThis.clearTimeout = timers.clearTimer as typeof clearTimeout
  try {
    await run(timers)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    globalThis.fetch = realFetch
  }
}

const BASE_URL = 'https://fixture-user:fixture-pass@example.invalid/v1'
const API_KEY = 'sk-fixture-secret-123456'

async function main() {
  // Provider-owned timeout: actionable, retryable, and safe to paste in an issue.
  await withFakeTimers(async (timers) => {
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = waitForAbort((signal) => {
      requestSignal = signal
    })
    const provider = createOpenAIResponsesProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: 'fixture-model',
      timeoutMs: 5_000,
    })

    const pending = collect(
      provider.completeStream([{ role: 'user', content: 'hello' }]),
    )
    await Promise.resolve()
    assert(timers.pendingCount === 1, 'stream request arms one timeout')
    timers.advance(5_000)
    const events = await settled(pending, 'timed-out stream')
    const failure = events.find((event) => event.type === 'error')
    assert(failure?.type === 'error', 'stream timeout emits an error')
    assert(
      /timed out after 5000 ms/i.test(failure.message),
      `timeout duration is explicit: ${failure.message}`,
    )
    assert(
      failure.message.includes('https://example.invalid/v1/responses'),
      `safe endpoint is explicit: ${failure.message}`,
    )
    assert(!failure.message.includes('fixture-user'), 'URL username is redacted')
    assert(!failure.message.includes('fixture-pass'), 'URL password is redacted')
    assert(!failure.message.includes(API_KEY), 'API key is not exposed')
    assert(requestSignal?.aborted, 'the request signal was actually aborted')

    const classified = classifyError(failure)
    assert(classified.class === 'retryable', 'timeout is retryable')
    assert(classified.reason === 'timeout', 'timeout has a stable reason')
    const explained = explainProviderError(failure.message, {
      providerId: 'fixture',
      kind: 'openai-responses',
      model: 'fixture-model',
      baseUrl: BASE_URL,
    })
    assert(/raise timeoutMs/i.test(explained), 'timeout offers a recovery step')
    assert(
      Number(timers.pendingCount) === 0,
      'timeout timer is cleaned after failure',
    )
  })

  // Caller abort stays a non-retryable cancellation and does not claim timeout.
  await withFakeTimers(async (timers) => {
    globalThis.fetch = waitForAbort(() => {})
    const caller = new AbortController()
    const provider = createOpenAIResponsesProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: 'fixture-model',
      timeoutMs: 5_000,
    })
    const pending = collect(
      provider.completeStream([{ role: 'user', content: 'hello' }], {
        signal: caller.signal,
      }),
    )
    await Promise.resolve()
    caller.abort('interrupt')
    const events = await settled(pending, 'caller-aborted stream')
    const failure = events.find((event) => event.type === 'error')
    assert(failure?.type === 'error', 'caller abort emits an error')
    assert(/aborted by caller/i.test(failure.message), failure.message)
    assert(!/timed out/i.test(failure.message), 'caller abort is not a timeout')
    const classified = classifyError(failure, { signal: caller.signal })
    assert(classified.class === 'user_abort', 'caller abort is not retried')
    assert(timers.pendingCount === 0, 'caller abort clears the timeout')
  })

  // A signal that was already aborted must be observed immediately.
  await withFakeTimers(async (timers) => {
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = waitForAbort((signal) => {
      requestSignal = signal
    })
    const caller = new AbortController()
    caller.abort('interrupt-before-fetch')
    const provider = createOpenAIResponsesProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: 'fixture-model',
      timeoutMs: 5_000,
    })
    const events = await settled(
      collect(
        provider.completeStream([{ role: 'user', content: 'hello' }], {
          signal: caller.signal,
        }),
      ),
      'pre-aborted stream',
    )
    assert(requestSignal?.aborted, 'pre-aborted caller reaches fetch as aborted')
    const failure = events.find((event) => event.type === 'error')
    assert(failure?.type === 'error', 'pre-abort emits an error')
    assert(
      classifyError(failure, { signal: caller.signal }).class === 'user_abort',
      'pre-abort remains a caller cancellation',
    )
    assert(timers.pendingCount === 0, 'pre-abort leaves no timeout behind')
  })

  // Successful completion detaches the caller and disarms the deadline.
  await withFakeTimers(async (timers) => {
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal as AbortSignal
      return new Response(
        'data: {"type":"response.completed","response":{}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch
    const caller = new AbortController()
    const provider = createOpenAIResponsesProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: 'fixture-model',
      timeoutMs: 5_000,
    })
    const events = await collect(
      provider.completeStream([{ role: 'user', content: 'hello' }], {
        signal: caller.signal,
      }),
    )
    assert(events.at(-1)?.type === 'done', 'successful stream completes')
    assert(timers.pendingCount === 0, 'success clears its timeout')
    caller.abort('late-abort')
    timers.advance(5_000)
    assert(
      requestSignal?.aborted === false,
      'success removes both timer and caller listener',
    )
  })

  // Non-streaming Responses calls must honor the same configured timeout.
  await withFakeTimers(async (timers) => {
    globalThis.fetch = waitForAbort(() => {})
    const provider = createOpenAIResponsesProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: 'fixture-model',
      timeoutMs: 7_000,
    })
    assert(provider.completeText, 'Responses provider exposes completeText')
    const pending = provider.completeText(
      [{ role: 'user', content: 'summarize' }],
      {},
    )
    await Promise.resolve()
    assert(timers.pendingCount === 1, 'completeText arms the configured timeout')
    timers.advance(7_000)
    let failure: unknown
    try {
      await settled(pending, 'timed-out completeText')
    } catch (error) {
      failure = error
    }
    assert(failure instanceof Error, 'completeText rejects on timeout')
    assert(failure.name === 'TimeoutError', `got ${failure.name}`)
    assert(/timed out after 7000 ms/i.test(failure.message), failure.message)
    assert(
      failure.message.includes('https://example.invalid/v1/responses'),
      failure.message,
    )
    assert(
      Number(timers.pendingCount) === 0,
      'completeText clears its timeout',
    )
  })

  console.log('PASS: provider abort diagnosis')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
