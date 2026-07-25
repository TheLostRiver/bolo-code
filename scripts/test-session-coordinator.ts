/**
 * DR2A：SessionCoordinator 单 runner ownership。
 * 运行：npx tsx scripts/test-session-coordinator.ts
 */
import {
  SessionCoordinator,
  createSession,
  submitPrompt,
} from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`TIMEOUT: ${message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function main() {
  // 契约层：同 session 拒绝第二个 owner；不同 session 独立；release 幂等。
  const coordinator = new SessionCoordinator()
  const acquiredA = coordinator.tryAcquire({
    sessionId: 'session_a',
    turnId: 'turn_a1',
    querySource: 'test',
  })
  assert(acquiredA.ok, 'first runner acquires session')
  const snapshotA = coordinator.snapshot('session_a')
  assert(
    snapshotA.state === 'running' &&
      snapshotA.active.turnId === 'turn_a1',
    'snapshot exposes active owner',
  )
  const deniedA = coordinator.tryAcquire({
    sessionId: 'session_a',
    turnId: 'turn_a2',
  })
  assert(!deniedA.ok, 'second runner for same session is denied')
  assert(
    deniedA.active.turnId === 'turn_a1',
    'busy result identifies current owner',
  )
  const acquiredB = coordinator.tryAcquire({
    sessionId: 'session_b',
    turnId: 'turn_b1',
  })
  assert(acquiredB.ok, 'different session acquires concurrently')
  assert(acquiredA.lease.release(), 'first release succeeds')
  assert(!acquiredA.lease.release(), 'release is idempotent')
  assert(
    coordinator.snapshot('session_a').state === 'idle',
    'released session becomes idle',
  )
  assert(acquiredB.lease.release(), 'different session release succeeds')

  // 集成层：同一个 BoloSession 并发 submit，不得让第二轮进入 provider/messages。
  const sameSessionGate = deferred()
  let sameSessionCalls = 0
  const sameSessionProvider: LlmProvider = {
    id: 'coordinator-same-session',
    async *completeStream() {
      sameSessionCalls += 1
      if (sameSessionCalls === 1) await sameSessionGate.promise
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    },
  }
  const sameSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_same_session',
    provider: sameSessionProvider,
    coordinator,
    systemPrompt: false,
  })
  const first = submitPrompt(sameSession, 'first prompt', {
    turnId: 'turn_same_first',
  })
  await waitUntil(
    () => sameSessionCalls === 1,
    'first same-session provider call starts',
  )
  const second = await submitPrompt(sameSession, 'second prompt', {
    turnId: 'turn_same_second',
  })
  assert(second.reason === 'error', 'busy submit returns error')
  assert(
    second.detail?.includes('session runner busy'),
    'busy submit has actionable detail',
  )
  assert(sameSessionCalls === 1, 'busy submit never calls provider')
  assert(
    !sameSession.messages.some(
      (message) =>
        message.role === 'user' && message.content.includes('second prompt'),
    ),
    'busy submit never mutates messages',
  )
  assert(
    sameSession.phase === 'running',
    'busy rejection does not overwrite active runner phase',
  )
  sameSessionGate.resolve()
  assert((await first).reason === 'completed', 'first runner completes')
  assert(
    coordinator.snapshot(sameSession.id).state === 'idle',
    'normal terminal releases lease',
  )

  // 同 sessionId 的两个对象也共享 ownership。
  const duplicateIdGate = deferred()
  let duplicateIdCalls = 0
  const firstObject = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_duplicate_object',
    coordinator,
    systemPrompt: false,
    provider: {
      id: 'coordinator-object-a',
      async *completeStream() {
        duplicateIdCalls += 1
        await duplicateIdGate.promise
        yield { type: 'done' }
      },
    },
  })
  const secondObject = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_duplicate_object',
    coordinator,
    systemPrompt: false,
    provider: {
      id: 'coordinator-object-b',
      async *completeStream() {
        duplicateIdCalls += 1
        yield { type: 'done' }
      },
    },
  })
  const objectFirst = submitPrompt(firstObject, 'object first', {
    turnId: 'turn_object_first',
  })
  await waitUntil(
    () => duplicateIdCalls === 1,
    'first same-id object provider call starts',
  )
  const objectSecond = await submitPrompt(secondObject, 'object second', {
    turnId: 'turn_object_second',
  })
  assert(objectSecond.reason === 'error', 'same-id object is denied')
  assert(duplicateIdCalls === 1, 'same-id object never calls second provider')
  assert(secondObject.messages.length === 0, 'same-id object messages untouched')
  duplicateIdGate.resolve()
  await objectFirst

  // 不同 session 必须真正并行，而不是全局串行锁。
  const parallelGate = deferred()
  let parallelActive = 0
  let parallelMax = 0
  let parallelCalls = 0
  const parallelProvider: LlmProvider = {
    id: 'coordinator-parallel',
    async *completeStream() {
      parallelCalls += 1
      parallelActive += 1
      parallelMax = Math.max(parallelMax, parallelActive)
      try {
        await parallelGate.promise
        yield { type: 'done' }
      } finally {
        parallelActive -= 1
      }
    },
  }
  const parallelA = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_parallel_a',
    provider: parallelProvider,
    coordinator,
    systemPrompt: false,
  })
  const parallelB = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_parallel_b',
    provider: parallelProvider,
    coordinator,
    systemPrompt: false,
  })
  const parallelAPending = submitPrompt(parallelA, 'parallel a', {
    turnId: 'turn_parallel_a',
  })
  const parallelBPending = submitPrompt(parallelB, 'parallel b', {
    turnId: 'turn_parallel_b',
  })
  await waitUntil(() => parallelCalls === 2, 'both sessions enter provider')
  assert(parallelMax === 2, 'different sessions run concurrently')
  parallelGate.resolve()
  await Promise.all([parallelAPending, parallelBPending])

  // provider error 也必须释放，否则下一个 turn 会永久 busy。
  let releaseCalls = 0
  const releaseSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_release_error',
    coordinator,
    systemPrompt: false,
    provider: {
      id: 'coordinator-release',
      async *completeStream() {
        releaseCalls += 1
        if (releaseCalls === 1) {
          yield { type: 'error', message: 'first call fails' }
        } else {
          yield { type: 'done' }
        }
      },
    },
  })
  assert(
    (
      await submitPrompt(releaseSession, 'fail once', {
        turnId: 'turn_release_error',
      })
    ).reason === 'error',
    'provider error is observed',
  )
  assert(
    (
      await submitPrompt(releaseSession, 'then recover', {
        turnId: 'turn_release_recover',
      })
    ).reason === 'completed',
    'next turn acquires after provider error',
  )
  assert(releaseCalls === 2, 'lease released after provider error')

  // UserPromptSubmit blocked 也必须释放；移除 hook 后下一 turn 可运行。
  let blockedCalls = 0
  const blockedSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_release_hook_block',
    coordinator,
    systemPrompt: false,
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'node -e "process.stderr.write(\'blocked by test\'); process.exit(2)"',
            },
          ],
        },
      ],
    },
    provider: {
      id: 'coordinator-hook-block',
      async *completeStream() {
        blockedCalls += 1
        yield { type: 'done' }
      },
    },
  })
  assert(
    (
      await submitPrompt(blockedSession, 'blocked once', {
        turnId: 'turn_hook_blocked',
      })
    ).reason === 'user_prompt_blocked',
    'hook block is observed',
  )
  assert(blockedCalls === 0, 'blocked hook never enters provider')
  assert(
    coordinator.snapshot(blockedSession.id).state === 'idle',
    'hook block releases lease',
  )
  blockedSession.hooks = {}
  assert(
    (
      await submitPrompt(blockedSession, 'allowed next', {
        turnId: 'turn_after_hook_block',
      })
    ).reason === 'completed',
    'next turn acquires after hook block',
  )

  // Abort 终态必须释放，随后仍可继续同一 session。
  let abortCalls = 0
  const abortSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'coordinator_release_abort',
    coordinator,
    systemPrompt: false,
    provider: {
      id: 'coordinator-abort',
      async *completeStream(_messages, options) {
        abortCalls += 1
        if (abortCalls === 1) {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve()
            options?.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            })
          })
          throw Object.assign(new Error('aborted by coordinator test'), {
            name: 'AbortError',
          })
        }
        yield { type: 'done' }
      },
    },
  })
  const abortController = new AbortController()
  const abortPending = submitPrompt(abortSession, 'abort once', {
    turnId: 'turn_abort_once',
    signal: abortController.signal,
  })
  await waitUntil(() => abortCalls === 1, 'abort provider starts')
  abortController.abort('test')
  assert((await abortPending).reason === 'aborted', 'abort is observed')
  assert(
    coordinator.snapshot(abortSession.id).state === 'idle',
    'abort releases lease',
  )
  assert(
    (
      await submitPrompt(abortSession, 'continue after abort', {
        turnId: 'turn_after_abort',
      })
    ).reason === 'completed',
    'next turn acquires after abort',
  )

  console.log('PASS: test-session-coordinator')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
