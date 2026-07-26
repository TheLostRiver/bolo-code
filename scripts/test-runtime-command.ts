import assert from 'node:assert/strict'

import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommand,
} from '../packages/shared/src/index.ts'
import {
  SessionCoordinator,
  applyDurableTaskEvent,
  createSession,
  enqueueBackgroundAgent,
  executeRuntimeCommand,
  requestSessionControl,
  submitUserInput,
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

const provider: LlmProvider = {
  id: 'runtime-command-test',
  async *completeStream() {
    yield { type: 'done' }
  },
}

const coordinator = new SessionCoordinator()
const session = await createSession({
  cwd: process.cwd(),
  sessionId: 'runtime_command_session',
  coordinator,
  provider,
  systemPrompt: false,
})
if (!session.backgroundAgents) {
  throw new Error('fixture has no background store')
}
const backgroundStore = session.backgroundAgents

const inspected = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_inspect',
    action: 'runtime.inspect',
    target: { sessionId: session.id },
  }),
)
assert.equal(inspected.ok, true)
if (inspected.ok) {
  assert.equal(inspected.snapshot?.session.sessionId, session.id)
  assert.equal(inspected.snapshot?.session.runner.state, 'idle')
}

const wrongSession = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_wrong_session',
    action: 'runtime.inspect',
    target: { sessionId: 'another_session' },
  }),
)
assert.equal(wrongSession.ok, false)
if (!wrongSession.ok) assert.equal(wrongSession.code, 'not_found')

const noActive = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_no_active',
    action: 'turn.interrupt',
    target: {
      sessionId: session.id,
      turnId: 'turn_missing',
      expectedState: 'running',
    },
  }),
)
assert.equal(noActive.ok, false)
if (!noActive.ok) assert.equal(noActive.code, 'state_conflict')

const owner = coordinator.tryAcquire({
  sessionId: session.id,
  turnId: 'turn_active',
  querySource: 'runtime_command_test',
})
assert.equal(owner.ok, true)
if (!owner.ok) throw new Error('fixture failed to acquire owner')

const interrupt = command({
  requestId: 'request_interrupt',
  action: 'turn.interrupt',
  target: {
    sessionId: session.id,
    turnId: 'turn_active',
    expectedState: 'running',
  },
})
const interrupted = await executeRuntimeCommand(session, interrupt)
assert.equal(interrupted.ok, true)
assert.equal(owner.lease.signal.aborted, true)
const duplicateInterrupt = await executeRuntimeCommand(session, interrupt)
assert.equal(duplicateInterrupt.ok, true)
assert.equal(
  coordinator
    .snapshot(session.id)
    .controls.filter((row) => row.kind === 'interrupt').length,
  1,
)

const staleInterrupt = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_stale_interrupt',
    action: 'turn.interrupt',
    target: {
      sessionId: session.id,
      turnId: 'turn_stale',
      expectedState: 'running',
    },
  }),
)
assert.equal(staleInterrupt.ok, false)
if (!staleInterrupt.ok) assert.equal(staleInterrupt.code, 'state_conflict')
owner.lease.release()

const queuedControl = await requestSessionControl(session, {
  controlId: 'control_ready',
  kind: 'queue',
  sessionId: session.id,
  turnId: 'turn_queued',
  prompt: 'queued prompt',
})
assert.equal(queuedControl.ok, true)
const cancelledControl = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_cancel_control',
    action: 'control.cancel',
    target: {
      sessionId: session.id,
      controlId: 'control_ready',
      expectedState: 'ready',
    },
  }),
)
assert.equal(cancelledControl.ok, true)
assert.equal(
  coordinator
    .snapshot(session.id)
    .controls.find((row) => row.controlId === 'control_ready')?.state,
  'cancelled',
)

const slashControl = await requestSessionControl(session, {
  controlId: 'control_slash',
  kind: 'queue',
  sessionId: session.id,
  turnId: 'turn_slash_queue',
  prompt: 'slash queued prompt',
})
assert.equal(slashControl.ok, true)
const slashCancelledControl = await submitUserInput(
  session,
  '/runtime cancel control control_slash',
)
assert.equal(slashCancelledControl.type, 'slash')
if (slashCancelledControl.type === 'slash') {
  assert.match(slashCancelledControl.message, /accepted/)
}
assert.equal(
  coordinator
    .snapshot(session.id)
    .controls.find((row) => row.controlId === 'control_slash')?.state,
  'cancelled',
)

const slashOwner = coordinator.tryAcquire({
  sessionId: session.id,
  turnId: 'turn_slash_active',
  querySource: 'runtime_slash_test',
})
assert.equal(slashOwner.ok, true)
if (!slashOwner.ok) throw new Error('fixture failed to acquire slash owner')
const slashInterrupted = await submitUserInput(
  session,
  '/runtime interrupt turn_slash_active',
)
assert.equal(slashInterrupted.type, 'slash')
if (slashInterrupted.type === 'slash') {
  assert.match(slashInterrupted.message, /accepted/)
}
assert.equal(slashOwner.lease.signal.aborted, true)
slashOwner.lease.release()

function queueTask(taskId: string): void {
  session.durableTasks = applyDurableTaskEvent(session.durableTasks, {
    type: 'state',
    taskId,
    sessionId: session.id,
    agentType: 'explore',
    state: 'admitted',
    timestamp: '2026-07-26T00:00:00.000Z',
    prompt: 'inspect files',
    isolation: 'none',
  })
  enqueueBackgroundAgent(backgroundStore, {
    taskId,
    agentType: 'explore',
    prompt: 'inspect files',
    admittedAt: '2026-07-26T00:00:00.000Z',
    start: async () => {},
    onStartError: () => {},
  })
}

const taskId = 'task_queued'
queueTask(taskId)

const list = await submitUserInput(session, '/runtime list')
assert.equal(list.type, 'slash')
if (list.type === 'slash') {
  assert.match(list.message, /Runtime protocol v1/)
  assert.match(list.message, /task_queued/)
  assert.match(list.message, /queued/)
}
const taskList = await submitUserInput(session, '/runtime list task')
assert.equal(taskList.type, 'slash')
if (taskList.type === 'slash') {
  assert.match(taskList.message, /task entities \(1\)/)
  assert.match(taskList.message, /task_queued/)
}
const inspectTask = await submitUserInput(
  session,
  '/runtime inspect task task_queued',
)
assert.equal(inspectTask.type, 'slash')
if (inspectTask.type === 'slash') {
  assert.match(inspectTask.message, /"taskId": "task_queued"/)
  assert.match(inspectTask.message, /"state": "queued"/)
}
const json = await submitUserInput(session, '/runtime json')
assert.equal(json.type, 'slash')
if (json.type === 'slash') {
  const parsed = JSON.parse(json.message) as {
    protocolVersion: number
    kind: string
  }
  assert.equal(parsed.protocolVersion, RUNTIME_PROTOCOL_VERSION)
  assert.equal(parsed.kind, 'runtime.snapshot')
}

const slashCancelledTask = await submitUserInput(
  session,
  `/runtime cancel task ${taskId}`,
)
assert.equal(slashCancelledTask.type, 'slash')
if (slashCancelledTask.type === 'slash') {
  assert.match(slashCancelledTask.message, /accepted/)
}
assert.equal(
  backgroundStore.backgroundAgentResults[taskId]?.status,
  'aborted',
)

const executorTaskId = 'task_executor'
queueTask(executorTaskId)
const cancelledTask = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_cancel_task',
    action: 'task.cancel',
    target: {
      sessionId: session.id,
      taskId: executorTaskId,
      expectedState: 'queued',
    },
  }),
)
assert.equal(cancelledTask.ok, true)
assert.equal(
  backgroundStore.backgroundAgentResults[executorTaskId]?.status,
  'aborted',
)

const repeatedCancel = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_cancel_task_again',
    action: 'task.cancel',
    target: {
      sessionId: session.id,
      taskId: executorTaskId,
      expectedState: 'queued',
    },
  }),
)
assert.equal(repeatedCancel.ok, false)
if (!repeatedCancel.ok) assert.equal(repeatedCancel.code, 'state_conflict')

console.log('PASS: test-runtime-command')
