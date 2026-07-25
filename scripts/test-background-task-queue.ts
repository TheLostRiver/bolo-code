/**
 * DR3B：background overflow FIFO/cancel 与父 safe-boundary result promotion。
 * 运行：npx tsx scripts/test-background-task-queue.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_TOOL_NAME,
  createAgentTool,
  createSession,
  defaultAgentPolicy,
  dispatchSlashCommand,
  identityPrepareMessages,
  loadTranscriptFile,
  resumeSession,
  submitPrompt,
  type QueryDeps,
  type SessionEvent,
} from '../packages/core/src/index.ts'
import { createBuiltinTools } from '../packages/tools/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function deferred(): {
  promise: Promise<void>
  resolve(): void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(
  check: () => boolean,
  message: string,
): Promise<void> {
  for (let index = 0; index < 120; index++) {
    if (check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`ASSERT: timed out: ${message}`)
}

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bolo-background-queue-'),
  )
  try {
    const transcript = path.join(root, 'background_queue_session.jsonl')
    const releaseFirst = deferred()
    const startedPrompts: string[] = []
    let activeWorkers = 0
    let maxActiveWorkers = 0
    const queueDeps: QueryDeps = {
      prepareMessages: identityPrepareMessages,
      uuid: () => `queue_uuid_${startedPrompts.length}`,
      callModel: async function* ({ messages }) {
        const prompt =
          messages.find((message) => message.role === 'user')?.content ?? ''
        startedPrompts.push(prompt)
        activeWorkers += 1
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers)
        try {
          if (prompt.includes('queue first')) {
            await releaseFirst.promise
          }
          yield { type: 'text_delta', text: `done:${prompt}` }
          yield { type: 'done' }
        } finally {
          activeWorkers -= 1
        }
      },
    }
    const policy = {
      ...defaultAgentPolicy(),
      maxConcurrent: 1,
      overflow: 'queue' as const,
    }
    const session = await createSession({
      cwd: root,
      sessionId: 'background_queue_session',
      deps: queueDeps,
      agentPolicy: policy,
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      autoSave: {
        scope: 'project',
        filePath: transcript,
      },
    })
    const store = session.backgroundAgents
    assert(store, 'queue session wires background store')
    const tool = createAgentTool()
    const start = async (prompt: string) =>
      await tool.call(
        {
          prompt,
          subagent_type: 'general',
          run_in_background: true,
        },
        {
          cwd: root,
          sessionId: session.id,
          extras: {
            writeTranscript: false,
            subagentParent: {
              parentSessionId: session.id,
              parentTurnId: 'turn_queue_parent',
              cwd: root,
              hooks: {},
              deps: queueDeps,
              permissionMode: 'bypassPermissions' as const,
              askPermission: async () => 'allow' as const,
              allTools: createBuiltinTools(),
              backgroundStore: store,
              parentMessages: session.messages,
              agentPolicy: policy,
            },
          },
        },
      )

    const first = await start('queue first')
    assert(first.ok && first.output.includes('started'), 'first worker starts')
    await waitFor(
      () => startedPrompts.some((prompt) => prompt.includes('queue first')),
      'first worker reaches provider gate',
    )
    const second = await start('queue second')
    const third = await start('queue third')
    const fourth = await start('queue cancel persistence failure')
    assert(
      second.ok && second.output.includes('queued'),
      `second worker queued: ${second.output}`,
    )
    assert(
      third.ok && third.output.includes('queued'),
      `third worker queued: ${third.output}`,
    )
    assert(
      fourth.ok && fourth.output.includes('queued'),
      `fourth worker queued: ${fourth.output}`,
    )

    const ids = Object.keys(store.pendingAgents)
    assert(ids.length === 4, 'running + three queued tasks are visible')
    const [firstId, secondId, thirdId, fourthId] = ids
    assert(
      firstId && secondId && thirdId && fourthId,
      'queue task ids assigned',
    )
    assert(store.pendingAgents[firstId]?.status === 'running', 'first running')
    assert(store.pendingAgents[secondId]?.status === 'queued', 'second queued')
    assert(store.pendingAgents[thirdId]?.status === 'queued', 'third queued')
    assert(store.pendingAgents[fourthId]?.status === 'queued', 'fourth queued')
    const baseLifecycle = store.durableLifecycle
    assert(baseLifecycle, 'queue session wires durable lifecycle')
    const releaseThirdStartPersistence = deferred()
    let thirdStartPersistenceEntered = false
    store.durableLifecycle = {
      admit: async (input) => await baseLifecycle.admit(input),
      markRunning: async (input) => {
        if (input.taskId === thirdId) {
          thirdStartPersistenceEntered = true
          await releaseThirdStartPersistence.promise
        }
        await baseLifecycle.markRunning(input)
      },
      finish: async (input) => await baseLifecycle.finish(input),
    }
    const queueStatus = await dispatchSlashCommand(session, 'bg', 'status')
    assert(
      queueStatus.ok &&
        queueStatus.message.includes('queued=3') &&
        queueStatus.message.includes('[QUEUED]'),
      '/bg status exposes queue count and task rows',
    )
    const rejectRunningCancel = await dispatchSlashCommand(
      session,
      'bg',
      `cancel ${firstId}`,
    )
    assert(
      !rejectRunningCancel.ok &&
        rejectRunningCancel.message.includes('not queued'),
      '/bg cancel refuses a running task',
    )

    const cancelled = await dispatchSlashCommand(
      session,
      'bg',
      `cancel ${secondId}`,
    )
    assert(
      cancelled.ok && cancelled.message.includes(secondId),
      'queued cancellation accepted through /bg',
    )
    assert(
      store.backgroundAgentResults[secondId]?.status === 'aborted',
      'cancelled queued task becomes aborted',
    )
    assert(
      !startedPrompts.some((prompt) => prompt.includes('queue second')),
      'cancelled queued task never calls provider',
    )

    const originalAppendFile = fs.appendFile.bind(fs)
    const writableFs = fs as typeof fs & {
      appendFile: typeof fs.appendFile
    }
    let cancelFailureInjected = false
    writableFs.appendFile = (async (
      file: Parameters<typeof fs.appendFile>[0],
      data: Parameters<typeof fs.appendFile>[1],
      options?: Parameters<typeof fs.appendFile>[2],
    ) => {
      if (
        !cancelFailureInjected &&
        String(file) === transcript &&
        String(data).includes('"type":"task_result"') &&
        String(data).includes(`"taskId":"${fourthId}"`)
      ) {
        cancelFailureInjected = true
        throw Object.assign(new Error('injected queued cancel failure'), {
          code: 'EIO',
        })
      }
      return await originalAppendFile(file, data, options)
    }) as typeof fs.appendFile
    let failedCancel
    try {
      failedCancel = await dispatchSlashCommand(
        session,
        'bg',
        `cancel ${fourthId}`,
      )
    } finally {
      writableFs.appendFile = originalAppendFile
    }
    assert(
      failedCancel?.ok &&
        failedCancel.message.includes('Warning:') &&
        cancelFailureInjected,
      'cancel persistence failure is visible but accepted fail-closed',
    )
    assert(
      store.backgroundAgentResults[fourthId]?.status === 'aborted',
      'cancel persistence failure still removes executable queued task',
    )

    releaseFirst.resolve()
    await waitFor(
      () => store.backgroundAgentResults[firstId]?.status === 'done',
      'first worker completes',
    )
    await waitFor(
      () => thirdStartPersistenceEntered,
      'third task reserves slot before running persistence',
    )
    const rejectStartingCancel = await dispatchSlashCommand(
      session,
      'bg',
      `cancel ${thirdId}`,
    )
    assert(
      !rejectStartingCancel.ok &&
        rejectStartingCancel.message.includes('not queued') &&
        (store.pendingAgents[thirdId]?.status as string | undefined) ===
          'running',
      'cancel cannot race a task after queue pump reserves its slot',
    )
    releaseThirdStartPersistence.resolve()
    await waitFor(
      () => store.backgroundAgentResults[thirdId]?.status === 'done',
      'third worker starts after slot release and completes',
    )
    assert(
      startedPrompts.filter((prompt) => prompt.includes('queue')).join('|') ===
        'queue first|queue third',
      'FIFO skips both cancelled entries without starting them',
    )
    assert(maxActiveWorkers === 1, 'queue never exceeds concurrency cap')

    const loaded = await loadTranscriptFile(transcript)
    const secondLifecycle = loaded.entries.filter(
      (entry) =>
        (entry.type === 'task' || entry.type === 'task_result') &&
        entry.taskId === secondId,
    )
    assert(
      secondLifecycle.map((entry) => entry.type).join(',') ===
        'task,task_result,task',
      'queued cancel persists admitted, result, aborted terminal',
    )
    assert(
      secondLifecycle.every(
        (entry) => entry.type !== 'task' || entry.state !== 'running',
      ),
      'cancelled queued task never persists running',
    )
    const thirdStates: string[] = []
    for (const entry of loaded.entries) {
      if (entry.type === 'task' && entry.taskId === thirdId) {
        thirdStates.push(entry.state)
      }
    }
    assert(
      thirdStates.join(',') === 'admitted,running,completed',
      'queued worker persists running only after acquiring slot',
    )
    const fourthLifecycle = loaded.entries.filter(
      (entry) =>
        (entry.type === 'task' || entry.type === 'task_result') &&
        entry.taskId === fourthId,
    )
    assert(
      fourthLifecycle.length === 1 &&
        fourthLifecycle[0]?.type === 'task' &&
        fourthLifecycle[0].state === 'admitted',
      'cancel write failure leaves durable task admitted without terminal',
    )
    const queueResume = await resumeSession({
      idOrPath: transcript,
      cwd: root,
      create: {
        deps: queueDeps,
        systemPrompt: false,
      },
    })
    assert(
      queueResume.session.durableTasks.find(
        (task) => task.taskId === fourthId,
      )?.state === 'interrupted' &&
        queueResume.session.backgroundAgents?.pendingAgents[fourthId]
          ?.status === 'interrupted',
      'cancel persistence failure resumes diagnostic interrupted without queue replay',
    )

    // 父 turn 已 terminal 后才完成：下一 turn before_provider promotion。
    const promotionTranscript = path.join(
      root,
      'background_promotion_session.jsonl',
    )
    const releaseLateChild = deferred()
    const promotionEvents: SessionEvent[] = []
    const promotionDeps: QueryDeps = {
      prepareMessages: identityPrepareMessages,
      uuid: () => 'promotion_uuid',
      callModel: async function* ({ messages, tools }) {
        const hasAgent =
          tools?.some((entry) => entry.name === AGENT_TOOL_NAME) === true
        if (!hasAgent) {
          await releaseLateChild.promise
          yield { type: 'text_delta', text: 'LATE_BACKGROUND_RESULT' }
          yield { type: 'done' }
          return
        }
        const hasPromotedResult = messages.some(
          (message) =>
            message.role === 'user' &&
            message.content.includes('<background_task_result'),
        )
        if (hasPromotedResult) {
          yield { type: 'text_delta', text: 'consumed background result' }
          yield { type: 'done' }
          return
        }
        const hasAgentToolResult = messages.some(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === 'late_background_call',
        )
        if (!hasAgentToolResult) {
          yield {
            type: 'tool_call',
            id: 'late_background_call',
            name: AGENT_TOOL_NAME,
            arguments: JSON.stringify({
              prompt: 'late background child',
              subagent_type: 'general',
              run_in_background: true,
            }),
          }
          yield { type: 'done' }
          return
        }
        yield { type: 'text_delta', text: 'parent finished before child' }
        yield { type: 'done' }
      },
    }
    const promotionSession = await createSession({
      cwd: root,
      sessionId: 'background_promotion_session',
      deps: promotionDeps,
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      onEvent: (event) => promotionEvents.push(event),
      autoSave: {
        scope: 'project',
        filePath: promotionTranscript,
      },
    })
    const firstParent = await submitPrompt(
      promotionSession,
      'start late background child',
      { turnId: 'turn_background_parent' },
    )
    assert(firstParent.reason === 'completed', 'parent turn completes first')
    assert(
      !promotionSession.messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.includes('<background_task_result'),
      ),
      'background result is absent before worker completion',
    )

    releaseLateChild.resolve()
    const promotionStore = promotionSession.backgroundAgents
    assert(promotionStore, 'promotion session wires background store')
    const lateTaskId = Object.keys(promotionStore.pendingAgents)[0] ?? ''
    assert(lateTaskId, 'late background task id available')
    await waitFor(
      () =>
        promotionStore.backgroundAgentResults[lateTaskId]?.status === 'done',
      'late child completes after parent terminal',
    )
    assert(
      !promotionSession.messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.includes('<background_task_result'),
      ),
      'async completion still does not mutate parent messages',
    )

    const secondParent = await submitPrompt(
      promotionSession,
      'consume pending background result',
      { turnId: 'turn_background_consumer' },
    )
    assert(secondParent.reason === 'completed', 'consumer turn completes')
    const promotedMessages = promotionSession.messages.filter(
      (message) =>
        message.role === 'user' &&
        message.content.includes('<background_task_result'),
    )
    assert(
      promotedMessages.length === 1 &&
        promotedMessages[0]?.content.includes(lateTaskId) &&
        promotedMessages[0]?.content.includes('LATE_BACKGROUND_RESULT'),
      'next safe boundary promotes durable result exactly once',
    )
    assert(
      promotionEvents.some(
        (event) =>
          event.type === 'background_result' &&
          event.taskId === lateTaskId &&
          event.boundary === 'before_provider',
      ),
      'promotion emits structured background_result event',
    )

    await submitPrompt(promotionSession, 'one more turn', {
      turnId: 'turn_background_no_duplicate',
    })
    assert(
      promotionSession.messages.filter(
        (message) =>
          message.role === 'user' &&
          message.content.includes('<background_task_result'),
      ).length === 1,
      'later safe boundaries do not duplicate delivered result',
    )

    console.log('PASS: test-background-task-queue')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
