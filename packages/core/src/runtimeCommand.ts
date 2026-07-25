import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommand,
  type RuntimeCommandAction,
  type RuntimeCommandErrorCode,
  type RuntimeCommandResult,
} from '../../shared/src/index.ts'
import {
  cancelSessionControl,
  requestSessionControl,
  type SessionControlRuntimeSession,
} from './sessionControlRuntime.ts'
import {
  buildRuntimeSnapshot,
  type RuntimeSnapshotSource,
} from './runtimeSnapshot.ts'
import { cancelQueuedBackgroundAgent } from './subagent.ts'

export type RuntimeCommandSession =
  RuntimeSnapshotSource & SessionControlRuntimeSession

function resultBase(
  command: RuntimeCommand,
): {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION
  kind: 'runtime.result'
  requestId: string
  action: RuntimeCommandAction
} {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.result',
    requestId: command.requestId,
    action: command.action,
  }
}

function failure(
  command: RuntimeCommand,
  code: RuntimeCommandErrorCode,
  detail: string,
): RuntimeCommandResult {
  return { ...resultBase(command), ok: false, code, detail }
}

function success(
  session: RuntimeCommandSession,
  command: RuntimeCommand,
  warnings?: readonly string[],
): RuntimeCommandResult {
  const nextWarnings = [...(warnings ?? [])]
  try {
    return {
      ...resultBase(command),
      ok: true,
      snapshot: buildRuntimeSnapshot(session),
      ...(nextWarnings.length ? { warnings: nextWarnings } : {}),
    }
  } catch (error) {
    nextWarnings.push(
      `runtime snapshot unavailable after accepted action: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return {
      ...resultBase(command),
      ok: true,
      warnings: nextWarnings,
    }
  }
}

function controlFailure(
  command: RuntimeCommand,
  result: { code: string; detail: string },
): RuntimeCommandResult {
  if (result.code === 'control_persistence_failed') {
    return failure(command, 'persistence_failed', result.detail)
  }
  if (
    result.code === 'no_active_turn' ||
    result.code === 'active_turn_mismatch' ||
    result.code === 'expected_turn_required' ||
    result.code === 'turn_releasing' ||
    result.code === 'control_id_conflict'
  ) {
    return failure(command, 'state_conflict', result.detail)
  }
  if (result.code === 'control_not_found') {
    return failure(command, 'not_found', result.detail)
  }
  if (result.code === 'control_not_cancellable') {
    return failure(command, 'not_cancellable', result.detail)
  }
  if (result.code === 'invalid_control') {
    return failure(command, 'invalid_command', result.detail)
  }
  return failure(command, 'internal_error', result.detail)
}

/**
 * DR4B protocol executor.
 *
 * This function is intentionally transport-neutral. It validates the command
 * against one current snapshot before calling existing durable control/task
 * operations. No interrupted work is replayed here.
 */
export async function executeRuntimeCommand(
  session: RuntimeCommandSession,
  command: RuntimeCommand,
): Promise<RuntimeCommandResult> {
  if (command.target.sessionId !== session.id) {
    return failure(
      command,
      'not_found',
      `session "${command.target.sessionId}" is not loaded`,
    )
  }

  let current
  try {
    current = buildRuntimeSnapshot(session)
  } catch (error) {
    return failure(
      command,
      'internal_error',
      `runtime snapshot unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  if (command.action === 'runtime.inspect') {
    return {
      ...resultBase(command),
      ok: true,
      snapshot: current,
    }
  }

  if (command.action === 'turn.interrupt') {
    const runner = current.session.runner
    if (
      runner.state !== 'running' ||
      runner.active.turnId !== command.target.turnId
    ) {
      return failure(
        command,
        'state_conflict',
        `turn "${command.target.turnId}" is not the active running turn`,
      )
    }
    const result = await requestSessionControl(session, {
      controlId: command.requestId,
      kind: 'interrupt',
      sessionId: session.id,
      expectedTurnId: command.target.turnId,
    })
    if (!result.ok) return controlFailure(command, result)
    return success(
      session,
      command,
      result.persistenceWarning ? [result.persistenceWarning] : undefined,
    )
  }

  if (command.action === 'control.cancel') {
    const target = current.session.controls.find(
      (control) => control.controlId === command.target.controlId,
    )
    if (!target) {
      return failure(
        command,
        'not_found',
        `control "${command.target.controlId}" was not found`,
      )
    }
    if (target.state !== command.target.expectedState) {
      return failure(
        command,
        'state_conflict',
        `control "${target.controlId}" is ${target.state}, expected ${command.target.expectedState}`,
      )
    }
    const result = await cancelSessionControl(session, {
      controlId: command.target.controlId,
    })
    if (!result.ok) return controlFailure(command, result)
    return success(
      session,
      command,
      result.persistenceWarning ? [result.persistenceWarning] : undefined,
    )
  }

  const target = current.session.tasks.find(
    (task) => task.taskId === command.target.taskId,
  )
  if (!target) {
    return failure(
      command,
      'not_found',
      `task "${command.target.taskId}" was not found`,
    )
  }
  if (target.state !== command.target.expectedState) {
    return failure(
      command,
      'state_conflict',
      `task "${target.taskId}" is ${target.state}, expected ${command.target.expectedState}`,
    )
  }
  if (!session.backgroundAgents) {
    return failure(
      command,
      'internal_error',
      'session has no background task store',
    )
  }
  const result = await cancelQueuedBackgroundAgent(
    session.backgroundAgents,
    command.target.taskId,
  )
  if (!result.ok) {
    return failure(
      command,
      result.code === 'task_not_found' ? 'not_found' : 'state_conflict',
      result.detail,
    )
  }
  return success(
    session,
    command,
    result.persistenceWarning ? [result.persistenceWarning] : undefined,
  )
}
