import {
  applyDurableControlEvent,
  type DurableControlRecord,
} from './durableControl.ts'
import {
  type SessionControlCancelResult,
  type SessionControlRecord,
  type SessionControlRequest,
  type SessionControlRequestResult,
  type SessionControlPromotionResult,
  type SessionRunnerLease,
  type SessionSafeBoundary,
  type SessionCoordinator,
} from './sessionCoordinator.ts'
import {
  appendSessionControlState,
  type PersistableSession,
} from './sessionPersist.ts'

export type SessionControlRuntimeSession = PersistableSession & {
  coordinator: SessionCoordinator
  durableControls: DurableControlRecord[]
}

export type SessionControlPersistenceFailure = {
  ok: false
  code: 'control_persistence_failed'
  detail: string
  activeTurnId?: string
}

export type SessionControlRuntimeRequestResult =
  | SessionControlPersistenceFailure
  | Exclude<SessionControlRequestResult, { ok: true }>
  | (Extract<SessionControlRequestResult, { ok: true }> & {
      persistenceWarning?: string
    })

export type SessionControlRuntimeCancelResult =
  | Exclude<SessionControlCancelResult, { ok: true }>
  | (Extract<SessionControlCancelResult, { ok: true }> & {
      persistenceWarning?: string
    })

export type SessionControlRuntimePromotionResult =
  | Exclude<SessionControlPromotionResult, { ok: true }>
  | (Extract<SessionControlPromotionResult, { ok: true }> & {
      persistenceWarning?: string
    })

export type SessionControlTakeResult = {
  control: SessionControlRecord | null
  persistenceWarning?: string
}

export type SessionRunnerReleaseResult = {
  released: boolean
  persistenceWarning?: string
}

function errorDetail(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`
}

function applyControlRecord(
  session: SessionControlRuntimeSession,
  control: SessionControlRecord,
  opts?: { timestamp?: string; detail?: string },
): void {
  session.durableControls = applyDurableControlEvent(
    session.durableControls,
    {
      controlId: control.controlId,
      sessionId: control.sessionId,
      kind: control.kind,
      state: control.state,
      timestamp: opts?.timestamp ?? control.updatedAt,
      ...(control.expectedTurnId
        ? { expectedTurnId: control.expectedTurnId }
        : {}),
      ...(control.turnId ? { turnId: control.turnId } : {}),
      ...(control.prompt !== undefined ? { prompt: control.prompt } : {}),
      ...(control.querySource ? { querySource: control.querySource } : {}),
      ...(control.boundary ? { boundary: control.boundary } : {}),
      ...(opts?.detail ? { detail: opts.detail } : {}),
    },
  )
}

async function persistControlRecord(
  session: SessionControlRuntimeSession,
  control: SessionControlRecord,
): Promise<void> {
  const entry = await appendSessionControlState(session, {
    controlId: control.controlId,
    kind: control.kind,
    state: control.state,
    expectedTurnId: control.expectedTurnId,
    turnId: control.turnId,
    prompt: control.prompt,
    querySource: control.querySource,
    boundary: control.boundary,
    timestamp: control.updatedAt,
  })
  applyControlRecord(session, control, {
    timestamp: entry?.timestamp,
  })
}

/**
 * 产品 admission 路径：accepted intent 必须先落盘才返回调用方。
 * queue/steer 写失败会立即取消；interrupt 已发出则返回明确 warning。
 */
export async function requestSessionControl(
  session: SessionControlRuntimeSession,
  input: SessionControlRequest,
): Promise<SessionControlRuntimeRequestResult> {
  const result = session.coordinator.requestControl(input)
  if (!result.ok || result.duplicate) return result
  try {
    await persistControlRecord(session, result.control)
    return result
  } catch (error) {
    const warning = errorDetail('control persistence failed', error)
    if (result.control.kind === 'interrupt') {
      applyControlRecord(session, result.control, { detail: warning })
      return { ...result, persistenceWarning: warning }
    }
    const cancelled = session.coordinator.cancelControl({
      sessionId: result.control.sessionId,
      controlId: result.control.controlId,
    })
    if (cancelled.ok) {
      applyControlRecord(session, cancelled.control, { detail: warning })
    }
    return {
      ok: false,
      code: 'control_persistence_failed',
      detail: warning,
      ...(result.activeTurnId
        ? { activeTurnId: result.activeTurnId }
        : {}),
    }
  }
}

/**
 * 取消优先 fail-safe：内存 cancellation 已生效时，审计写失败只报告 warning。
 */
export async function cancelSessionControl(
  session: SessionControlRuntimeSession,
  input: { controlId: string },
): Promise<SessionControlRuntimeCancelResult> {
  const result = session.coordinator.cancelControl({
    sessionId: session.id,
    controlId: input.controlId,
  })
  if (!result.ok) return result
  try {
    await persistControlRecord(session, result.control)
    return result
  } catch (error) {
    const warning = errorDetail('control cancellation persistence failed', error)
    applyControlRecord(session, result.control, { detail: warning })
    return { ...result, persistenceWarning: warning }
  }
}

/**
 * safe-boundary promotion 只有全部目标状态已落盘才交给 queryLoop。
 * 写失败时 coordinator 中仍保持 promoted，避免稍后无审计重试；调用方拿到空列表。
 */
export async function promoteSessionControls(
  session: SessionControlRuntimeSession,
  input: {
    turnId: string
    boundary: SessionSafeBoundary
  },
): Promise<SessionControlRuntimePromotionResult> {
  const result = session.coordinator.promoteControls({
    sessionId: session.id,
    ...input,
  })
  if (!result.ok || result.controls.length === 0) return result
  try {
    for (const control of result.controls) {
      await persistControlRecord(session, control)
    }
    return result
  } catch (error) {
    const warning = errorDetail('control promotion persistence failed', error)
    for (const control of result.controls) {
      applyControlRecord(session, control, { detail: warning })
    }
    return {
      ok: true,
      boundary: result.boundary,
      controls: [],
      persistenceWarning: warning,
    }
  }
}

/**
 * CLI queue drain：promoted 写成功后才把 prompt 交给执行器。
 */
export async function takeNextSessionQueued(
  session: SessionControlRuntimeSession,
): Promise<SessionControlTakeResult> {
  const control = session.coordinator.takeNextQueued(session.id)
  if (!control) return { control: null }
  try {
    await persistControlRecord(session, control)
    return { control }
  } catch (error) {
    const warning = errorDetail('queued control persistence failed', error)
    applyControlRecord(session, control, { detail: warning })
    return { control: null, persistenceWarning: warning }
  }
}

/**
 * terminal boundary：ready/cancelled 记录持久化完成前保持 session ownership。
 * barrier 失败后 lease 必须释放，且 coordinator 会把未审计 ready queue 取消。
 */
export async function releaseSessionRunner(
  session: SessionControlRuntimeSession,
  lease: SessionRunnerLease,
): Promise<SessionRunnerReleaseResult> {
  try {
    const released = await lease.releaseWithBarrier(async (controls) => {
      for (const control of controls) {
        await persistControlRecord(session, control)
      }
    })
    return { released }
  } catch (error) {
    const warning = errorDetail('runner release persistence failed', error)
    const snapshot = session.coordinator.snapshot(session.id)
    for (const control of snapshot.controls) {
      if (
        control.expectedTurnId === lease.turnId &&
        control.boundary === 'turn_terminal'
      ) {
        applyControlRecord(session, control, { detail: warning })
      }
    }
    return { released: true, persistenceWarning: warning }
  }
}
