import { createHash } from 'node:crypto'

import {
  RUNTIME_PROTOCOL_VERSION,
  nowIso,
  type RuntimeCommand,
  type RuntimeCommandAction,
  type RuntimeCommandErrorCode,
  type RuntimeCommandResult,
  type RuntimeControlView,
  type RuntimeSnapshot,
  type RuntimeTaskView,
  type RuntimeTurnView,
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
import {
  appendSessionResolution,
  appendSessionTurnState,
} from './sessionPersist.ts'
import {
  applyDurableResolutionEvent,
  type DurableResolutionAction,
  type DurableResolutionEntityKind,
} from './durableResolution.ts'
import { applyDurableTurnEvent } from './durableTurn.ts'

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

type RecoveryTarget =
  | { entity: 'turn'; row: RuntimeTurnView }
  | { entity: 'control'; row: RuntimeControlView }
  | { entity: 'task'; row: RuntimeTaskView }

function findRecoveryTarget(
  snapshot: RuntimeSnapshot,
  entity: DurableResolutionEntityKind,
  entityId: string,
): RecoveryTarget | undefined {
  if (entity === 'turn') {
    const row = snapshot.session.turns.find(
      (turn) => turn.turnId === entityId,
    )
    return row ? { entity, row } : undefined
  }
  if (entity === 'control') {
    const row = snapshot.session.controls.find(
      (control) => control.controlId === entityId,
    )
    return row ? { entity, row } : undefined
  }
  const row = snapshot.session.tasks.find(
    (task) => task.taskId === entityId,
  )
  return row ? { entity, row } : undefined
}

function recoveryAction(
  command: Extract<
    RuntimeCommand,
    { action: 'runtime.discard' | 'runtime.retry-safe' }
  >,
): DurableResolutionAction {
  return command.action === 'runtime.discard' ? 'discard' : 'retry_safe'
}

function retryIds(requestId: string): {
  controlId: string
  turnId: string
} {
  const digest = createHash('sha256')
    .update(requestId, 'utf8')
    .digest('hex')
    .slice(0, 32)
  return {
    controlId: `runtime_retry_control_${digest}`,
    turnId: `runtime_retry_turn_${digest}`,
  }
}

function retryPayload(
  target: RecoveryTarget,
):
  | { ok: true; prompt: string; querySource?: string }
  | { ok: false; detail: string } {
  if (target.entity === 'turn') {
    if (
      target.row.interruptedFrom !== 'admitted' ||
      !target.row.prompt?.trim()
    ) {
      return {
        ok: false,
        detail:
          `turn "${target.row.turnId}" is not retry-safe; ` +
          'only admitted-only interrupted turns with a prompt may retry',
      }
    }
    return {
      ok: true,
      prompt: target.row.prompt,
      ...(target.row.querySource
        ? { querySource: target.row.querySource }
        : {}),
    }
  }
  if (target.entity === 'control') {
    if (
      target.row.kind !== 'queue' ||
      (target.row.interruptedFrom !== 'pending' &&
        target.row.interruptedFrom !== 'ready') ||
      !target.row.prompt?.trim()
    ) {
      return {
        ok: false,
        detail:
          `control "${target.row.controlId}" is not retry-safe; ` +
          'only interrupted pending/ready queue controls may retry',
      }
    }
    return {
      ok: true,
      prompt: target.row.prompt,
      ...(target.row.querySource
        ? { querySource: target.row.querySource }
        : {}),
    }
  }
  return {
    ok: false,
    detail:
      `task "${target.row.taskId}" is not retry-safe; ` +
      'background worker factories are not recoverable',
  }
}

async function persistResolution(
  session: RuntimeCommandSession,
  command: Extract<
    RuntimeCommand,
    { action: 'runtime.discard' | 'runtime.retry-safe' }
  >,
  replacementId?: string,
): Promise<
  | { ok: true; warning?: string }
  | { ok: false; detail: string }
> {
  const timestamp = nowIso()
  let entry
  try {
    entry = await appendSessionResolution(session, {
      resolutionId: command.requestId,
      entityKind: command.target.entity,
      entityId: command.target.entityId,
      action: recoveryAction(command),
      ...(replacementId ? { replacementId } : {}),
      timestamp,
    })
  } catch (error) {
    return {
      ok: false,
      detail:
        `resolution persistence failed: ` +
        (error instanceof Error ? error.message : String(error)),
    }
  }
  try {
    session.durableResolutions = applyDurableResolutionEvent(
      session.durableResolutions,
      {
        resolutionId: command.requestId,
        sessionId: session.id,
        entityKind: command.target.entity,
        entityId: command.target.entityId,
        action: recoveryAction(command),
        timestamp: entry?.timestamp ?? timestamp,
        ...(replacementId ? { replacementId } : {}),
      },
    )
    return { ok: true }
  } catch (error) {
    return {
      ok: true,
      warning:
        `resolution was persisted but projection failed: ` +
        (error instanceof Error ? error.message : String(error)),
    }
  }
}

async function admitRetryTurn(
  session: RuntimeCommandSession,
  input: {
    turnId: string
    prompt: string
    querySource?: string
    detail: string
  },
): Promise<
  | { ok: true }
  | { ok: false; code: RuntimeCommandErrorCode; detail: string }
> {
  const existing = session.durableTurns.find(
    (turn) => turn.turnId === input.turnId,
  )
  if (existing) {
    const safeExisting =
      existing.prompt === input.prompt &&
      existing.detail === input.detail &&
      (existing.state === 'admitted' ||
        (existing.state === 'interrupted' &&
          existing.interruptedFrom === 'admitted'))
    if (!safeExisting) {
      return {
        ok: false,
        code: 'not_retry_safe',
        detail:
          `replacement turn "${input.turnId}" may already have started; ` +
          'refusing to replay it',
      }
    }
    if (existing.state === 'admitted') return { ok: true }
  }
  const timestamp = nowIso()
  try {
    const entry = await appendSessionTurnState(session, {
      turnId: input.turnId,
      state: 'admitted',
      prompt: input.prompt,
      querySource: input.querySource ?? 'runtime_retry_safe',
      detail: input.detail,
    })
    session.durableTurns = applyDurableTurnEvent(
      session.durableTurns,
      {
        turnId: input.turnId,
        state: 'admitted',
        timestamp: entry?.timestamp ?? timestamp,
        prompt: input.prompt,
        querySource: input.querySource ?? 'runtime_retry_safe',
        detail: input.detail,
      },
    )
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      code: 'persistence_failed',
      detail:
        `replacement turn admission failed: ` +
        (error instanceof Error ? error.message : String(error)),
    }
  }
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

  if (
    command.action === 'runtime.discard' ||
    command.action === 'runtime.retry-safe'
  ) {
    const target = findRecoveryTarget(
      current,
      command.target.entity,
      command.target.entityId,
    )
    if (!target) {
      return failure(
        command,
        'not_found',
        `${command.target.entity} "${command.target.entityId}" was not found`,
      )
    }
    const action = recoveryAction(command)
    if (target.row.resolution) {
      if (
        target.row.resolution.resolutionId === command.requestId &&
        target.row.resolution.action === action
      ) {
        return success(session, command)
      }
      return failure(
        command,
        'state_conflict',
        `${command.target.entity} "${command.target.entityId}" is already resolved`,
      )
    }
    if (target.row.state !== command.target.expectedState) {
      return failure(
        command,
        'state_conflict',
        `${command.target.entity} "${command.target.entityId}" is ${target.row.state}, expected ${command.target.expectedState}`,
      )
    }
    if (command.action === 'runtime.discard') {
      const persisted = await persistResolution(session, command)
      if (!persisted.ok) {
        return failure(command, 'persistence_failed', persisted.detail)
      }
      return success(
        session,
        command,
        persisted.warning ? [persisted.warning] : undefined,
      )
    }

    const payload = retryPayload(target)
    if (!payload.ok) {
      return failure(command, 'not_retry_safe', payload.detail)
    }
    if (current.session.runner.state !== 'idle') {
      return failure(
        command,
        'state_conflict',
        'retry-safe requires an idle session before queue admission',
      )
    }
    const ids = retryIds(command.requestId)
    const retryMarker =
      `runtime_retry_safe_of:${command.target.entity}:` +
      command.target.entityId
    const otherReplacement = session.durableTurns.find(
      (turn) =>
        turn.detail === retryMarker && turn.turnId !== ids.turnId,
    )
    if (otherReplacement) {
      return failure(
        command,
        'state_conflict',
        `${command.target.entity} "${command.target.entityId}" already has replacement turn "${otherReplacement.turnId}"`,
      )
    }
    const admitted = await admitRetryTurn(session, {
      turnId: ids.turnId,
      prompt: payload.prompt,
      querySource: payload.querySource,
      detail: retryMarker,
    })
    if (!admitted.ok) {
      return failure(command, admitted.code, admitted.detail)
    }
    const queued = await requestSessionControl(session, {
      controlId: ids.controlId,
      kind: 'queue',
      sessionId: session.id,
      turnId: ids.turnId,
      prompt: payload.prompt,
      querySource: payload.querySource ?? 'runtime_retry_safe',
    })
    if (!queued.ok) return controlFailure(command, queued)
    if (queued.control.state !== 'ready') {
      return failure(
        command,
        'state_conflict',
        `replacement queue "${ids.controlId}" is ${queued.control.state}, expected ready`,
      )
    }
    const persisted = await persistResolution(
      session,
      command,
      ids.turnId,
    )
    if (!persisted.ok) {
      return success(session, command, [persisted.detail])
    }
    return success(
      session,
      command,
      persisted.warning ? [persisted.warning] : undefined,
    )
  }

  if (command.action !== 'task.cancel') {
    return failure(
      command,
      'invalid_command',
      `unsupported runtime action: ${command.action}`,
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
