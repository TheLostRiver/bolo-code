/**
 * DR4B2：interrupted discard/retry-safe resolution 与失败窗口。
 * 运行：npx tsx scripts/test-runtime-recovery.ts
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  RUNTIME_PROTOCOL_VERSION,
  parseRuntimeCommand,
  type RuntimeCommand,
} from '../packages/shared/src/index.ts'
import {
  SessionCoordinator,
  appendResolutionEntry,
  appendTurnEntry,
  applyDurableResolutionEvent,
  createSession,
  ensureTranscriptFile,
  executeRuntimeCommand,
  loadTranscriptFile,
  metaInputFromSession,
  projectDurableControlEvents,
  projectDurableResolutionEvents,
  projectDurableResolutions,
  projectDurableTaskEvents,
  projectDurableTurnEvents,
  resumeSession,
  rewriteTranscriptFromMessages,
  setSessionPersistMeta,
  submitPrompt,
  submitUserInput,
  takeNextSessionQueued,
  type DurableResolutionEvent,
} from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function command(
  value: Omit<RuntimeCommand, 'protocolVersion' | 'kind'>,
): RuntimeCommand {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.command',
    ...value,
  } as RuntimeCommand
}

const parsedRetry = parseRuntimeCommand({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'request_parse_retry',
  action: 'runtime.retry-safe',
  target: {
    sessionId: 'session_parse',
    entity: 'turn',
    entityId: 'turn_parse',
    expectedState: 'interrupted',
    futureTargetField: true,
  },
})
assert.equal(parsedRetry.ok, true)
const rejectedRetryState = parseRuntimeCommand({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'request_parse_bad_retry',
  action: 'runtime.retry-safe',
  target: {
    sessionId: 'session_parse',
    entity: 'turn',
    entityId: 'turn_parse',
    expectedState: 'running',
  },
})
assert.equal(rejectedRetryState.ok, false)
if (!rejectedRetryState.ok) {
  assert.equal(rejectedRetryState.code, 'invalid_transition')
}

const admittedRecovery = projectDurableTurnEvents([
  {
    turnId: 'turn_admitted',
    state: 'admitted',
    timestamp: '2026-07-26T08:00:00.000Z',
    prompt: 'safe admitted work',
  },
])
assert.deepEqual(
  {
    state: admittedRecovery[0]?.state,
    interruptedFrom: admittedRecovery[0]?.interruptedFrom,
    recoveryReason: admittedRecovery[0]?.recoveryReason,
  },
  {
    state: 'interrupted',
    interruptedFrom: 'admitted',
    recoveryReason: 'process_restart',
  },
)
const runningRecovery = projectDurableTurnEvents([
  {
    turnId: 'turn_running',
    state: 'admitted',
    timestamp: '2026-07-26T08:00:01.000Z',
    prompt: 'unsafe running work',
  },
  {
    turnId: 'turn_running',
    state: 'running',
    timestamp: '2026-07-26T08:00:02.000Z',
  },
])
assert.equal(runningRecovery[0]?.interruptedFrom, 'running')

const resolutionEvent: DurableResolutionEvent = {
  resolutionId: 'resolution_discard',
  sessionId: 'resolution_projection',
  entityKind: 'task',
  entityId: 'task_old',
  action: 'discard',
  timestamp: '2026-07-26T08:01:00.000Z',
  detail: 'acknowledged after restart',
}
const firstResolution = applyDurableResolutionEvent([], resolutionEvent)
const duplicateResolution = applyDurableResolutionEvent(
  firstResolution,
  resolutionEvent,
)
assert.deepEqual(
  duplicateResolution,
  firstResolution,
  'same resolution id and payload is idempotent',
)
assert.throws(
  () =>
    applyDurableResolutionEvent(firstResolution, {
      ...resolutionEvent,
      resolutionId: 'resolution_conflict',
      action: 'retry_safe',
      replacementId: 'task_replacement',
    }),
  /already resolved/,
)
assert.equal(
  projectDurableResolutionEvents([
    resolutionEvent,
    {
      ...resolutionEvent,
      resolutionId: 'resolution_conflict',
      action: 'retry_safe',
      replacementId: 'task_replacement',
    },
  ]).length,
  1,
  'conflicting transcript resolution fails closed',
)

const tempBase = path.resolve('.bolo-tmp')
await fs.mkdir(tempBase, { recursive: true })
const root = path.resolve(
  tempBase,
  `runtime-recovery-${process.pid}-${Date.now()}`,
)
const relativeRoot = path.relative(tempBase, root)
assert(
  relativeRoot !== '' &&
    !relativeRoot.startsWith(`..${path.sep}`) &&
    relativeRoot !== '..' &&
    !path.isAbsolute(relativeRoot),
  'temporary test root stays inside .bolo-tmp',
)
await fs.mkdir(root, { recursive: true })

let providerCalls = 0
const provider: LlmProvider = {
  id: 'runtime-recovery-test',
  async *completeStream() {
    providerCalls += 1
    yield { type: 'done' }
  },
}

try {
  const transcript = path.join(root, 'resolution_transcript.jsonl')
  const transcriptSession = await createSession({
    cwd: root,
    sessionId: 'resolution_transcript',
    systemPrompt: false,
  })
  await ensureTranscriptFile(
    transcript,
    metaInputFromSession(transcriptSession),
  )
  await appendTurnEntry(transcript, {
    sessionId: transcriptSession.id,
    turnId: 'turn_transcript_admitted',
    state: 'admitted',
    prompt: 'survive transcript rewrite',
  })
  await appendResolutionEntry(transcript, {
    resolutionId: 'resolution_transcript_discard',
    sessionId: transcriptSession.id,
    entityKind: 'turn',
    entityId: 'turn_transcript_admitted',
    action: 'discard',
    timestamp: '2026-07-26T08:02:00.000Z',
  })
  let loaded = await loadTranscriptFile(transcript)
  assert.equal(projectDurableResolutions(loaded.entries).length, 1)
  transcriptSession.messages.push(
    { role: 'user', content: 'rewrite resolution transcript' },
    { role: 'assistant', content: 'preserve append-only audit' },
  )
  await rewriteTranscriptFromMessages(transcript, transcriptSession, {
    compactBoundarySummary: 'DR4B2 rewrite fixture',
  })
  loaded = await loadTranscriptFile(transcript)
  assert.equal(
    loaded.entries.filter((entry) => entry.type === 'resolution').length,
    1,
    'compact rewrite preserves resolution entries',
  )
  const resumedTranscript = await resumeSession({
    idOrPath: transcript,
    cwd: root,
    reassembleSystem: false,
    systemPrompt: false,
    create: { coordinator: new SessionCoordinator() },
  })
  assert.equal(
    resumedTranscript.session.durableTurns.find(
      (turn) => turn.turnId === 'turn_transcript_admitted',
    )?.interruptedFrom,
    'admitted',
  )
  assert.equal(resumedTranscript.session.durableResolutions.length, 1)
  assert.equal(
    resumedTranscript.session.coordinator.snapshot(
      resumedTranscript.session.id,
    ).controls.length,
    0,
    'resume never rebuilds executable queue from transcript',
  )

  const session = await createSession({
    cwd: root,
    sessionId: 'runtime_recovery_executor',
    coordinator: new SessionCoordinator(),
    provider,
    systemPrompt: false,
  })
  session.durableTurns = projectDurableTurnEvents([
    {
      turnId: 'turn_safe',
      state: 'admitted',
      timestamp: '2026-07-26T08:03:00.000Z',
      prompt: 'retry this safe input',
      querySource: 'recovery_fixture',
    },
    {
      turnId: 'turn_unsafe',
      state: 'admitted',
      timestamp: '2026-07-26T08:03:01.000Z',
      prompt: 'do not replay running input',
    },
    {
      turnId: 'turn_unsafe',
      state: 'running',
      timestamp: '2026-07-26T08:03:02.000Z',
    },
    {
      turnId: 'turn_slash_safe',
      state: 'admitted',
      timestamp: '2026-07-26T08:03:03.000Z',
      prompt: 'retry through slash',
    },
  ])
  session.durableControls = projectDurableControlEvents([
    {
      controlId: 'control_queue_safe',
      sessionId: session.id,
      kind: 'queue',
      state: 'ready',
      turnId: 'turn_queue_old',
      prompt: 'retry queued input',
      querySource: 'queue_fixture',
      timestamp: '2026-07-26T08:04:00.000Z',
    },
    {
      controlId: 'control_queue_slash',
      sessionId: session.id,
      kind: 'queue',
      state: 'pending',
      turnId: 'turn_queue_slash_old',
      prompt: 'retry queued input through slash',
      timestamp: '2026-07-26T08:04:01.000Z',
    },
    {
      controlId: 'control_steer_unsafe',
      sessionId: session.id,
      kind: 'steer',
      state: 'pending',
      expectedTurnId: 'turn_unsafe',
      prompt: 'unsafe steer',
      timestamp: '2026-07-26T08:04:02.000Z',
    },
  ])
  session.durableTasks = projectDurableTaskEvents([
    {
      type: 'state',
      taskId: 'task_discard',
      sessionId: session.id,
      agentType: 'explore',
      state: 'admitted',
      timestamp: '2026-07-26T08:05:00.000Z',
      prompt: 'discard diagnostic task',
    },
    {
      type: 'state',
      taskId: 'task_retry_unsafe',
      sessionId: session.id,
      agentType: 'general',
      state: 'admitted',
      timestamp: '2026-07-26T08:05:01.000Z',
      prompt: 'no worker factory after restart',
    },
  ])

  const retryTurn = command({
    requestId: 'request_retry_turn_safe',
    action: 'runtime.retry-safe',
    target: {
      sessionId: session.id,
      entity: 'turn',
      entityId: 'turn_safe',
      expectedState: 'interrupted',
    },
  })
  const retriedTurn = await executeRuntimeCommand(session, retryTurn)
  assert.equal(retriedTurn.ok, true)
  if (!retriedTurn.ok || !retriedTurn.snapshot) {
    throw new Error('retry-safe turn did not return a snapshot')
  }
  const originalTurn = retriedTurn.snapshot.session.turns.find(
    (turn) => turn.turnId === 'turn_safe',
  )
  assert.equal(originalTurn?.resolution?.action, 'retry_safe')
  const replacementTurnId = originalTurn?.resolution?.replacementId
  assert(replacementTurnId, 'retry-safe exposes replacement turn id')
  assert.equal(
    retriedTurn.snapshot.session.turns.find(
      (turn) => turn.turnId === replacementTurnId,
    )?.state,
    'admitted',
  )
  assert.equal(providerCalls, 0, 'retry-safe queues work without provider replay')
  assert.equal(
    session.coordinator
      .snapshot(session.id)
      .controls.filter(
        (control) => control.turnId === replacementTurnId,
      ).length,
    1,
  )

  const duplicateRetry = await executeRuntimeCommand(session, retryTurn)
  assert.equal(duplicateRetry.ok, true)
  assert.equal(
    session.durableResolutions.filter(
      (resolution) => resolution.entityId === 'turn_safe',
    ).length,
    1,
  )
  assert.equal(
    session.coordinator
      .snapshot(session.id)
      .controls.filter(
        (control) => control.turnId === replacementTurnId,
      ).length,
    1,
    'duplicate request never creates a second queue',
  )

  const conflictingResolution = await executeRuntimeCommand(
    session,
    command({
      requestId: 'request_discard_resolved_turn',
      action: 'runtime.discard',
      target: {
        sessionId: session.id,
        entity: 'turn',
        entityId: 'turn_safe',
        expectedState: 'interrupted',
      },
    }),
  )
  assert.equal(conflictingResolution.ok, false)
  if (!conflictingResolution.ok) {
    assert.equal(conflictingResolution.code, 'state_conflict')
  }

  const taken = await takeNextSessionQueued(session)
  assert.equal(taken.control?.turnId, replacementTurnId)
  const executedReplacement = await submitPrompt(
    session,
    taken.control?.prompt ?? '',
    {
      turnId: replacementTurnId,
      querySource: taken.control?.querySource,
    },
  )
  assert.equal(executedReplacement.reason, 'completed')
  assert.equal(providerCalls, 1)

  for (const target of [
    { entity: 'turn' as const, entityId: 'turn_unsafe' },
    { entity: 'control' as const, entityId: 'control_steer_unsafe' },
    { entity: 'task' as const, entityId: 'task_retry_unsafe' },
  ]) {
    const rejected = await executeRuntimeCommand(
      session,
      command({
        requestId: `request_reject_${target.entity}`,
        action: 'runtime.retry-safe',
        target: {
          sessionId: session.id,
          ...target,
          expectedState: 'interrupted',
        },
      }),
    )
    assert.equal(rejected.ok, false)
    if (!rejected.ok) assert.equal(rejected.code, 'not_retry_safe')
  }

  const retryQueue = await executeRuntimeCommand(
    session,
    command({
      requestId: 'request_retry_queue',
      action: 'runtime.retry-safe',
      target: {
        sessionId: session.id,
        entity: 'control',
        entityId: 'control_queue_safe',
        expectedState: 'interrupted',
      },
    }),
  )
  assert.equal(retryQueue.ok, true)

  const discardTask = await executeRuntimeCommand(
    session,
    command({
      requestId: 'request_discard_task',
      action: 'runtime.discard',
      target: {
        sessionId: session.id,
        entity: 'task',
        entityId: 'task_discard',
        expectedState: 'interrupted',
      },
    }),
  )
  assert.equal(discardTask.ok, true)
  if (discardTask.ok) {
    assert.equal(
      discardTask.snapshot?.session.tasks.find(
        (task) => task.taskId === 'task_discard',
      )?.resolution?.action,
      'discard',
    )
  }

  const slashRetry = await submitUserInput(
    session,
    '/runtime retry-safe control control_queue_slash',
  )
  assert.equal(slashRetry.type, 'slash')
  if (slashRetry.type === 'slash') {
    assert.match(slashRetry.message, /accepted/)
  }
  const slashDiscard = await submitUserInput(
    session,
    '/runtime discard turn turn_slash_safe',
  )
  assert.equal(slashDiscard.type, 'slash')
  if (slashDiscard.type === 'slash') {
    assert.match(slashDiscard.message, /accepted/)
  }
  const slashInspect = await submitUserInput(
    session,
    '/runtime inspect turn turn_slash_safe',
  )
  assert.equal(slashInspect.type, 'slash')
  if (slashInspect.type === 'slash') {
    assert.match(slashInspect.message, /"action": "discard"/)
  }

  const blocker = path.join(root, 'not-a-directory')
  await fs.writeFile(blocker, 'block transcript writes', 'utf8')
  const failingSession = await createSession({
    cwd: root,
    sessionId: 'runtime_resolution_failure',
    coordinator: new SessionCoordinator(),
    systemPrompt: false,
  })
  failingSession.durableTurns = projectDurableTurnEvents([
    {
      turnId: 'turn_discard_failure',
      state: 'admitted',
      timestamp: '2026-07-26T08:06:00.000Z',
      prompt: 'discard failure target',
    },
  ])
  setSessionPersistMeta(failingSession, {
    autoSave: true,
    scope: 'project',
    filePath: path.join(blocker, 'failure.jsonl'),
  })
  const failedDiscard = await executeRuntimeCommand(
    failingSession,
    command({
      requestId: 'request_discard_failure',
      action: 'runtime.discard',
      target: {
        sessionId: failingSession.id,
        entity: 'turn',
        entityId: 'turn_discard_failure',
        expectedState: 'interrupted',
      },
    }),
  )
  assert.equal(failedDiscard.ok, false)
  if (!failedDiscard.ok) {
    assert.equal(failedDiscard.code, 'persistence_failed')
  }
  assert.equal(failingSession.durableResolutions.length, 0)

  const warningTranscript = path.join(root, 'resolution_warning.jsonl')
  const warningSession = await createSession({
    cwd: root,
    sessionId: 'runtime_resolution_warning',
    coordinator: new SessionCoordinator(),
    systemPrompt: false,
    autoSave: {
      scope: 'project',
      filePath: warningTranscript,
    },
  })
  warningSession.durableTurns = projectDurableTurnEvents([
    {
      turnId: 'turn_warning_target',
      state: 'admitted',
      timestamp: '2026-07-26T08:07:00.000Z',
      prompt: 'queue before resolution warning',
    },
  ])
  const originalAppendFile = fs.appendFile.bind(fs)
  let failedResolutionOnce = false
  const writableFs = fs as typeof fs & {
    appendFile: typeof fs.appendFile
  }
  writableFs.appendFile = (async (
    file: Parameters<typeof fs.appendFile>[0],
    data: Parameters<typeof fs.appendFile>[1],
    options?: Parameters<typeof fs.appendFile>[2],
  ) => {
    if (
      !failedResolutionOnce &&
      String(file) === warningTranscript &&
      String(data).includes('"type":"resolution"')
    ) {
      failedResolutionOnce = true
      throw Object.assign(new Error('injected resolution append failure'), {
        code: 'EIO',
      })
    }
    return await originalAppendFile(file, data, options)
  }) as typeof fs.appendFile
  const warningCommand = command({
    requestId: 'request_retry_warning',
    action: 'runtime.retry-safe',
    target: {
      sessionId: warningSession.id,
      entity: 'turn',
      entityId: 'turn_warning_target',
      expectedState: 'interrupted',
    },
  })
  try {
    const warned = await executeRuntimeCommand(
      warningSession,
      warningCommand,
    )
    assert.equal(warned.ok, true)
    if (warned.ok) {
      assert(
        warned.warnings?.some((warning) =>
          warning.includes('resolution persistence failed'),
        ),
      )
    }
    assert.equal(warningSession.durableResolutions.length, 0)
    assert.equal(
      warningSession.coordinator
        .snapshot(warningSession.id)
        .controls.filter((control) => control.kind === 'queue').length,
      1,
      'accepted queue remains singular after resolution warning',
    )
    const differentRequest = await executeRuntimeCommand(
      warningSession,
      command({
        requestId: 'request_retry_warning_different',
        action: 'runtime.retry-safe',
        target: {
          sessionId: warningSession.id,
          entity: 'turn',
          entityId: 'turn_warning_target',
          expectedState: 'interrupted',
        },
      }),
    )
    assert.equal(differentRequest.ok, false)
    if (!differentRequest.ok) {
      assert.equal(differentRequest.code, 'state_conflict')
    }
  } finally {
    writableFs.appendFile = originalAppendFile
  }
  const warningRecovered = await executeRuntimeCommand(
    warningSession,
    warningCommand,
  )
  assert.equal(warningRecovered.ok, true)
  assert.equal(warningSession.durableResolutions.length, 1)
  assert.equal(
    warningSession.coordinator
      .snapshot(warningSession.id)
      .controls.filter((control) => control.kind === 'queue').length,
    1,
    'same request only repairs missing resolution audit',
  )
  const warningLoaded = await loadTranscriptFile(warningTranscript)
  assert.equal(
    warningLoaded.entries.filter(
      (entry) =>
        entry.type === 'turn' &&
        entry.state === 'admitted' &&
        entry.turnId !== 'turn_warning_target',
    ).length,
    1,
    'resolution retry does not duplicate replacement turn admission',
  )
  assert.equal(
    warningLoaded.entries.filter(
      (entry) => entry.type === 'resolution',
    ).length,
    1,
  )

  console.log('PASS: test-runtime-recovery')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
