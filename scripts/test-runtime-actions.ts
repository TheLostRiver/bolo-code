/**
 * AR1B1：runtime available-actions 纯状态矩阵。
 * 运行：npx tsx scripts/test-runtime-actions.ts
 */
import assert from 'node:assert/strict'

import {
  queryRuntimeSnapshot,
  type RuntimeAvailableAction,
  type RuntimeListItem,
} from '../packages/shared/src/runtimeQuery.ts'
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeSnapshot,
} from '../packages/shared/src/runtimeProtocol.ts'

const timestamp = '2026-07-26T11:00:00.000Z'

function fixture(runner: RuntimeSnapshot['session']['runner']): RuntimeSnapshot {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.snapshot',
    generatedAt: timestamp,
    features: [],
    session: {
      sessionId: 'runtime_actions',
      cwd: process.cwd(),
      phase: runner.state === 'running' ? 'running' : 'ready',
      runner,
      turns: [
        {
          turnId: 'turn_active',
          state: 'running',
          prompt: 'active',
          updatedAt: timestamp,
        },
        {
          turnId: 'turn_retry_safe',
          state: 'interrupted',
          prompt: 'retry me',
          interruptedFrom: 'admitted',
          recovered: true,
          recoveryReason: 'process_restart',
          updatedAt: timestamp,
        },
        {
          turnId: 'turn_side_effect_unknown',
          state: 'interrupted',
          prompt: 'do not retry',
          interruptedFrom: 'running',
          recovered: true,
          recoveryReason: 'process_restart',
          updatedAt: timestamp,
        },
        {
          turnId: 'turn_resolved',
          state: 'interrupted',
          prompt: 'already discarded',
          interruptedFrom: 'admitted',
          updatedAt: timestamp,
          resolution: {
            resolutionId: 'resolution_turn',
            sessionId: 'runtime_actions',
            entityKind: 'turn',
            entityId: 'turn_resolved',
            action: 'discard',
            resolvedAt: timestamp,
            updatedAt: timestamp,
          },
        },
        {
          turnId: 'turn_completed',
          state: 'completed',
          updatedAt: timestamp,
        },
      ],
      controls: [
        {
          controlId: 'control_pending',
          sessionId: 'runtime_actions',
          kind: 'queue',
          state: 'pending',
          requestedAt: timestamp,
          updatedAt: timestamp,
          prompt: 'pending input',
        },
        {
          controlId: 'control_ready',
          sessionId: 'runtime_actions',
          kind: 'queue',
          state: 'ready',
          requestedAt: timestamp,
          updatedAt: timestamp,
          prompt: 'ready input',
        },
        {
          controlId: 'control_steer_pending',
          sessionId: 'runtime_actions',
          kind: 'steer',
          state: 'pending',
          requestedAt: timestamp,
          updatedAt: timestamp,
          prompt: 'pending steer',
          expectedTurnId: 'turn_active',
        },
        {
          controlId: 'control_retry_safe',
          sessionId: 'runtime_actions',
          kind: 'queue',
          state: 'interrupted',
          requestedAt: timestamp,
          updatedAt: timestamp,
          prompt: 'retry queue',
          interruptedFrom: 'ready',
          recovered: true,
          recoveryReason: 'process_restart',
        },
        {
          controlId: 'control_steer_interrupted',
          sessionId: 'runtime_actions',
          kind: 'steer',
          state: 'interrupted',
          requestedAt: timestamp,
          updatedAt: timestamp,
          prompt: 'never retry steer',
          interruptedFrom: 'pending',
          recovered: true,
          recoveryReason: 'process_restart',
        },
        {
          controlId: 'control_promoted',
          sessionId: 'runtime_actions',
          kind: 'queue',
          state: 'promoted',
          requestedAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      tasks: [
        {
          taskId: 'task_queued',
          sessionId: 'runtime_actions',
          agentType: 'explore',
          state: 'queued',
          admittedAt: timestamp,
          updatedAt: timestamp,
        },
        {
          taskId: 'task_interrupted',
          sessionId: 'runtime_actions',
          agentType: 'explore',
          state: 'interrupted',
          admittedAt: timestamp,
          updatedAt: timestamp,
          interruptedFrom: 'admitted',
          recovered: true,
          recoveryReason: 'process_restart',
        },
        {
          taskId: 'task_completed',
          sessionId: 'runtime_actions',
          agentType: 'explore',
          state: 'completed',
          admittedAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  }
}

function listItems(snapshot: RuntimeSnapshot): RuntimeListItem[] {
  const result = queryRuntimeSnapshot(snapshot, { action: 'list' })
  assert.equal(result.ok, true)
  if (!result.ok || result.view.kind !== 'runtime.list') {
    throw new Error('runtime list fixture failed')
  }
  return result.view.items
}

function actions(
  items: RuntimeListItem[],
  entityId: string,
): RuntimeAvailableAction[] {
  const item = items.find((candidate) => candidate.entityId === entityId)
  assert(item, `missing item ${entityId}`)
  return item.availableActions
}

function actionNames(
  items: RuntimeListItem[],
  entityId: string,
): string[] {
  return actions(items, entityId).map((action) => action.action)
}

const runningItems = listItems(
  fixture({
    state: 'running',
    active: {
      sessionId: 'runtime_actions',
      turnId: 'turn_active',
      acquiredAt: timestamp,
    },
  }),
)

assert.deepEqual(actionNames(runningItems, 'turn_active'), ['turn.interrupt'])
assert.deepEqual(actionNames(runningItems, 'turn_retry_safe'), [
  'runtime.discard',
])
assert.deepEqual(actionNames(runningItems, 'turn_side_effect_unknown'), [
  'runtime.discard',
])
assert.deepEqual(actionNames(runningItems, 'turn_resolved'), [])
assert.deepEqual(actionNames(runningItems, 'turn_completed'), [])
assert.deepEqual(actionNames(runningItems, 'control_pending'), [
  'control.cancel',
  'control.replace',
])
assert.deepEqual(actionNames(runningItems, 'control_ready'), [
  'control.cancel',
  'control.replace',
])
assert.deepEqual(actionNames(runningItems, 'control_steer_pending'), [
  'control.cancel',
])
assert.deepEqual(actionNames(runningItems, 'control_retry_safe'), [
  'runtime.discard',
])
assert.deepEqual(actionNames(runningItems, 'control_steer_interrupted'), [
  'runtime.discard',
])
assert.deepEqual(actionNames(runningItems, 'control_promoted'), [])
assert.deepEqual(actionNames(runningItems, 'task_queued'), ['task.cancel'])
assert.deepEqual(actionNames(runningItems, 'task_interrupted'), [
  'runtime.discard',
])
assert.deepEqual(actionNames(runningItems, 'task_completed'), [])

const idleItems = listItems(fixture({ state: 'idle' }))
assert.deepEqual(actionNames(idleItems, 'turn_active'), [])
assert.deepEqual(actionNames(idleItems, 'turn_retry_safe'), [
  'runtime.discard',
  'runtime.retry-safe',
])
assert.deepEqual(actionNames(idleItems, 'turn_side_effect_unknown'), [
  'runtime.discard',
])
assert.deepEqual(actionNames(idleItems, 'control_retry_safe'), [
  'runtime.discard',
  'runtime.retry-safe',
])
assert.deepEqual(actionNames(idleItems, 'control_steer_interrupted'), [
  'runtime.discard',
])

assert.deepEqual(actions(runningItems, 'turn_active')[0], {
  action: 'turn.interrupt',
  target: {
    sessionId: 'runtime_actions',
    turnId: 'turn_active',
    expectedState: 'running',
  },
})
assert.deepEqual(actions(idleItems, 'turn_retry_safe')[1], {
  action: 'runtime.retry-safe',
  target: {
    sessionId: 'runtime_actions',
    entity: 'turn',
    entityId: 'turn_retry_safe',
    expectedState: 'interrupted',
  },
})
assert.deepEqual(actions(runningItems, 'control_pending')[0], {
  action: 'control.cancel',
  target: {
    sessionId: 'runtime_actions',
    controlId: 'control_pending',
    expectedState: 'pending',
  },
})
assert.deepEqual(actions(runningItems, 'task_queued')[0], {
  action: 'task.cancel',
  target: {
    sessionId: 'runtime_actions',
    taskId: 'task_queued',
    expectedState: 'queued',
  },
})

// Action descriptors are detached output, not aliases into later queries.
const mutableTarget = actions(idleItems, 'turn_retry_safe')[1]?.target as {
  expectedState: string
}
mutableTarget.expectedState = 'mutated'
const freshIdleItems = listItems(fixture({ state: 'idle' }))
assert.equal(
  (
    actions(freshIdleItems, 'turn_retry_safe')[1]?.target as {
      expectedState: string
    }
  ).expectedState,
  'interrupted',
)

console.log('PASS: test-runtime-actions')
