import assert from 'node:assert/strict'

import {
  RUNTIME_PROTOCOL_FEATURES,
  RUNTIME_PROTOCOL_VERSION,
  createRuntimeProtocolHello,
  negotiateRuntimeProtocol,
  parseRuntimeCommand,
  parseRuntimeCommandResult,
  parseRuntimeSnapshot,
} from '../packages/shared/src/index.ts'
import { buildRuntimeSnapshot } from '../packages/core/src/index.ts'

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const secretProvider = {
  apiKey: 'must-never-cross-runtime-protocol',
  completeStream: async function* () {
    yield { type: 'done' as const }
  },
}
const secretController = new AbortController()
const secretPromise = Promise.resolve('must-never-cross-runtime-protocol')

const source = {
  id: 'session_protocol',
  cwd: 'C:\\repo',
  phase: 'running' as const,
  coordinator: {
    snapshot: () => ({
      sessionId: 'session_protocol',
      state: 'running' as const,
      active: {
        sessionId: 'session_protocol',
        turnId: 'turn_active',
        acquiredAt: '2026-07-26T00:00:01.000Z',
        querySource: 'test',
      },
      controls: [
        {
          controlId: 'control_live',
          kind: 'steer' as const,
          sessionId: 'session_protocol',
          state: 'pending' as const,
          requestedAt: '2026-07-26T00:00:02.000Z',
          updatedAt: '2026-07-26T00:00:02.000Z',
          expectedTurnId: 'turn_active',
          prompt: 'correct course',
        },
      ],
    }),
  },
  durableTurns: [
    {
      turnId: 'turn_active',
      state: 'running' as const,
      prompt: 'do work',
      querySource: 'test',
      admittedAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:01.000Z',
    },
    {
      turnId: 'turn_old',
      state: 'completed' as const,
      admittedAt: '2026-07-25T23:59:00.000Z',
      updatedAt: '2026-07-25T23:59:03.000Z',
    },
    {
      turnId: 'turn_interrupted',
      state: 'interrupted' as const,
      prompt: 'acknowledge old input',
      admittedAt: '2026-07-25T23:58:00.000Z',
      updatedAt: '2026-07-25T23:58:01.000Z',
      recovered: true,
      interruptedFrom: 'admitted' as const,
      recoveryReason: 'process_restart' as const,
    },
  ],
  durableControls: [
    {
      controlId: 'control_live',
      sessionId: 'session_protocol',
      kind: 'steer' as const,
      state: 'pending' as const,
      requestedAt: '2026-07-26T00:00:02.000Z',
      updatedAt: '2026-07-26T00:00:02.000Z',
      expectedTurnId: 'turn_active',
      prompt: 'stale durable copy',
    },
    {
      controlId: 'control_done',
      sessionId: 'session_protocol',
      kind: 'queue' as const,
      state: 'promoted' as const,
      requestedAt: '2026-07-25T23:59:00.000Z',
      updatedAt: '2026-07-25T23:59:04.000Z',
      turnId: 'turn_old',
      prompt: 'next',
    },
  ],
  durableTasks: [
    {
      taskId: 'task_queued',
      sessionId: 'session_protocol',
      agentType: 'explore',
      state: 'admitted' as const,
      admittedAt: '2026-07-26T00:00:03.000Z',
      updatedAt: '2026-07-26T00:00:03.000Z',
      parentTurnId: 'turn_active',
      prompt: 'inspect',
    },
    {
      taskId: 'task_done',
      sessionId: 'session_protocol',
      agentType: 'general',
      state: 'completed' as const,
      admittedAt: '2026-07-25T23:58:00.000Z',
      updatedAt: '2026-07-25T23:58:10.000Z',
      result: {
        summary: 'finished',
        isError: false,
        writtenAt: '2026-07-25T23:58:09.000Z',
        usage: {
          inputTokens: 5,
          outputTokens: 7,
          totalTokens: 12,
          calls: 1,
        },
      },
    },
  ],
  durableResolutions: [
    {
      resolutionId: 'resolution_discard_turn',
      sessionId: 'session_protocol',
      entityKind: 'turn' as const,
      entityId: 'turn_interrupted',
      action: 'discard' as const,
      resolvedAt: '2026-07-26T00:00:04.000Z',
      updatedAt: '2026-07-26T00:00:04.000Z',
    },
  ],
  backgroundAgents: {
    pendingAgents: {
      task_queued: {
        agentId: 'task_queued',
        agentType: 'explore',
        prompt: 'inspect',
        status: 'queued' as const,
        startedAt: '2026-07-26T00:00:03.000Z',
        parentTurnId: 'turn_active',
      },
    },
    backgroundAgentResults: {},
    queuedAgentIds: ['task_queued'],
    resultPromotionQueue: [],
    maxConcurrent: 1,
    durableLifecycle: {
      admit: async () => {},
      markRunning: async () => {},
      finish: async () => {},
    },
  },
  provider: secretProvider,
  tools: [{ name: 'secret-tool', execute: () => secretPromise }],
  controller: secretController,
  promise: secretPromise,
}

const snapshot = buildRuntimeSnapshot(source, {
  generatedAt: '2026-07-26T00:00:05.000Z',
})
assert.equal(snapshot.protocolVersion, RUNTIME_PROTOCOL_VERSION)
assert.equal(snapshot.kind, 'runtime.snapshot')
assert.deepEqual(snapshot.features, [...RUNTIME_PROTOCOL_FEATURES])
assert.equal(snapshot.session.runner.state, 'running')
assert.equal(snapshot.session.runner.active?.turnId, 'turn_active')
assert.equal(snapshot.session.controls.length, 2)
assert.equal(
  snapshot.session.controls.find((row) => row.controlId === 'control_live')
    ?.prompt,
  'correct course',
)
assert.equal(
  snapshot.session.tasks.find((row) => row.taskId === 'task_queued')?.state,
  'queued',
)
assert.equal(
  snapshot.session.tasks.find((row) => row.taskId === 'task_done')?.result
    ?.summary,
  'finished',
)
assert.equal(
  snapshot.session.turns.find(
    (row) => row.turnId === 'turn_interrupted',
  )?.resolution?.action,
  'discard',
)

const serialized = JSON.stringify(snapshot)
for (const forbidden of [
  'must-never-cross-runtime-protocol',
  'completeStream',
  'secret-tool',
  'durableLifecycle',
  'resultPromotionQueue',
]) {
  assert.equal(serialized.includes(forbidden), false, forbidden)
}

const roundTrip = parseRuntimeSnapshot(JSON.parse(serialized))
assert.equal(roundTrip.ok, true)
if (roundTrip.ok) assert.deepEqual(roundTrip.value, snapshot)

const withUnknownFields = cloneJson(snapshot) as unknown as Record<
  string,
  unknown
>
withUnknownFields.futureEnvelopeField = { enabled: true }
const unknownSession = withUnknownFields.session as Record<string, unknown>
unknownSession.futureSessionField = 'ignored'
const unknownTurns = unknownSession.turns as Array<Record<string, unknown>>
unknownTurns[0].futureTurnField = 42
const resolvedTurn = unknownTurns.find(
  (turn) => turn.turnId === 'turn_interrupted',
)
if (resolvedTurn?.resolution) {
  ;(resolvedTurn.resolution as Record<string, unknown>).futureField =
    'ignored'
}
const forwardCompatible = parseRuntimeSnapshot(withUnknownFields)
assert.equal(forwardCompatible.ok, true)
if (forwardCompatible.ok) assert.deepEqual(forwardCompatible.value, snapshot)

const invalidSnapshot = cloneJson(snapshot)
;(invalidSnapshot.session.turns[0] as { state: string }).state =
  'teleported'
const rejectedSnapshot = parseRuntimeSnapshot(invalidSnapshot)
assert.equal(rejectedSnapshot.ok, false)
if (!rejectedSnapshot.ok) {
  assert.equal(rejectedSnapshot.code, 'invalid_snapshot')
}

const crossSessionSnapshot = cloneJson(snapshot)
crossSessionSnapshot.session.tasks[0].sessionId = 'another_session'
const rejectedCrossSession = parseRuntimeSnapshot(crossSessionSnapshot)
assert.equal(rejectedCrossSession.ok, false)
if (!rejectedCrossSession.ok) {
  assert.equal(rejectedCrossSession.code, 'invalid_snapshot')
  assert.match(rejectedCrossSession.detail, /another session/)
}

const duplicateSnapshot = cloneJson(snapshot)
duplicateSnapshot.session.turns.push({
  ...duplicateSnapshot.session.turns[0],
})
const rejectedDuplicate = parseRuntimeSnapshot(duplicateSnapshot)
assert.equal(rejectedDuplicate.ok, false)
if (!rejectedDuplicate.ok) {
  assert.equal(rejectedDuplicate.code, 'invalid_snapshot')
  assert.match(rejectedDuplicate.detail, /duplicate id/)
}

const invalidResolution = cloneJson(snapshot)
const invalidResolvedTurn = invalidResolution.session.turns.find(
  (turn) => turn.turnId === 'turn_interrupted',
)
if (!invalidResolvedTurn?.resolution) {
  throw new Error('resolution fixture missing')
}
;(invalidResolvedTurn.resolution as { action: string }).action =
  'force_replay'
const rejectedResolution = parseRuntimeSnapshot(invalidResolution)
assert.equal(rejectedResolution.ok, false)
if (!rejectedResolution.ok) {
  assert.equal(rejectedResolution.code, 'invalid_snapshot')
}

const hello = createRuntimeProtocolHello()
assert.deepEqual(hello.supportedVersions, [RUNTIME_PROTOCOL_VERSION])
assert.deepEqual(hello.features, [...RUNTIME_PROTOCOL_FEATURES])

const negotiated = negotiateRuntimeProtocol({
  supportedVersions: [999, RUNTIME_PROTOCOL_VERSION],
  requestedFeatures: [
    RUNTIME_PROTOCOL_FEATURES[0],
    'future.optional.feature',
  ],
})
assert.equal(negotiated.ok, true)
if (negotiated.ok) {
  assert.equal(negotiated.protocolVersion, RUNTIME_PROTOCOL_VERSION)
  assert.deepEqual(negotiated.features, [RUNTIME_PROTOCOL_FEATURES[0]])
}
const missingRequired = negotiateRuntimeProtocol({
  supportedVersions: [RUNTIME_PROTOCOL_VERSION],
  requiredFeatures: ['future.required.feature'],
})
assert.equal(missingRequired.ok, false)
if (!missingRequired.ok) {
  assert.equal(missingRequired.code, 'unsupported_features')
}
const missingVersion = negotiateRuntimeProtocol({
  supportedVersions: [999],
})
assert.equal(missingVersion.ok, false)
if (!missingVersion.ok) {
  assert.equal(missingVersion.code, 'unsupported_version')
}

const interruptCommand = parseRuntimeCommand({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'request_interrupt',
  action: 'turn.interrupt',
  target: {
    sessionId: 'session_protocol',
    turnId: 'turn_active',
    expectedState: 'running',
    futureTargetField: true,
  },
  futureEnvelopeField: true,
})
assert.equal(interruptCommand.ok, true)
if (interruptCommand.ok) {
  assert.deepEqual(interruptCommand.value, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.command',
    requestId: 'request_interrupt',
    action: 'turn.interrupt',
    target: {
      sessionId: 'session_protocol',
      turnId: 'turn_active',
      expectedState: 'running',
    },
  })
}

const illegalTransition = parseRuntimeCommand({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'request_bad_state',
  action: 'task.cancel',
  target: {
    sessionId: 'session_protocol',
    taskId: 'task_queued',
    expectedState: 'running',
  },
})
assert.equal(illegalTransition.ok, false)
if (!illegalTransition.ok) {
  assert.equal(illegalTransition.code, 'invalid_transition')
}

const unknownAction = parseRuntimeCommand({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'request_unknown',
  action: 'task.force-replay',
  target: {
    sessionId: 'session_protocol',
    taskId: 'task_queued',
  },
})
assert.equal(unknownAction.ok, false)
if (!unknownAction.ok) {
  assert.equal(unknownAction.code, 'unsupported_action')
}

const parsedResult = parseRuntimeCommandResult({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.result',
  requestId: 'request_interrupt',
  action: 'turn.interrupt',
  ok: false,
  code: 'state_conflict',
  detail: 'turn already completed',
  futureResultField: true,
})
assert.equal(parsedResult.ok, true)
if (parsedResult.ok) {
  assert.deepEqual(parsedResult.value, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.result',
    requestId: 'request_interrupt',
    action: 'turn.interrupt',
    ok: false,
    code: 'state_conflict',
    detail: 'turn already completed',
  })
}

const parsedRetryFailure = parseRuntimeCommandResult({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.result',
  requestId: 'request_retry_rejected',
  action: 'runtime.retry-safe',
  ok: false,
  code: 'not_retry_safe',
  detail: 'running work may have side effects',
})
assert.equal(parsedRetryFailure.ok, true)

const parsedSuccessResult = parseRuntimeCommandResult({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.result',
  requestId: 'request_inspect',
  action: 'runtime.inspect',
  ok: true,
  warnings: ['accepted with durable audit warning'],
  snapshot: {
    ...snapshot,
    futureSnapshotField: true,
  },
})
assert.equal(parsedSuccessResult.ok, true)
if (parsedSuccessResult.ok) {
  assert.equal(parsedSuccessResult.value.ok, true)
  if (parsedSuccessResult.value.ok) {
    assert.deepEqual(parsedSuccessResult.value.snapshot, snapshot)
    assert.deepEqual(parsedSuccessResult.value.warnings, [
      'accepted with durable audit warning',
    ])
  }
}

console.log('PASS: test-runtime-protocol')
