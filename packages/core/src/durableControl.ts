import {
  SESSION_CONTROL_KINDS,
  SESSION_SAFE_BOUNDARIES,
  type SessionControlKind,
  type SessionControlState,
  type SessionSafeBoundary,
} from './sessionCoordinator.ts'

export const DURABLE_CONTROL_STATES = [
  'pending',
  'ready',
  'promoted',
  'cancelled',
  'interrupted',
] as const

export const DURABLE_CONTROL_BOUNDARIES = [
  ...SESSION_SAFE_BOUNDARIES,
  'between_turns',
  'interrupt_signal',
] as const

export type DurableControlState =
  (typeof DURABLE_CONTROL_STATES)[number]
export type DurableControlBoundary =
  | SessionSafeBoundary
  | 'between_turns'
  | 'interrupt_signal'

export type DurableControlEvent = {
  controlId: string
  sessionId: string
  kind: SessionControlKind
  state: DurableControlState
  timestamp: string
  expectedTurnId?: string
  turnId?: string
  prompt?: string
  querySource?: string
  boundary?: DurableControlBoundary
  detail?: string
}

export type DurableControlRecord = {
  controlId: string
  sessionId: string
  kind: SessionControlKind
  state: DurableControlState
  requestedAt: string
  updatedAt: string
  expectedTurnId?: string
  turnId?: string
  prompt?: string
  querySource?: string
  boundary?: DurableControlBoundary
  detail?: string
  /** pending/ready 只恢复为诊断记录，不自动重新入队。 */
  recovered?: boolean
  interruptedFrom?: Extract<SessionControlState, 'pending' | 'ready'>
  recoveryReason?: 'process_restart'
}

export function isDurableControlState(
  value: unknown,
): value is DurableControlState {
  return (
    typeof value === 'string' &&
    (DURABLE_CONTROL_STATES as readonly string[]).includes(value)
  )
}

export function isSessionControlKind(
  value: unknown,
): value is SessionControlKind {
  return (
    typeof value === 'string' &&
    (SESSION_CONTROL_KINDS as readonly string[]).includes(value)
  )
}

export function isDurableControlBoundary(
  value: unknown,
): value is DurableControlBoundary {
  return (
    typeof value === 'string' &&
    (DURABLE_CONTROL_BOUNDARIES as readonly string[]).includes(value)
  )
}

function normalizeRef(raw: string, name: string): string {
  const value = raw.trim()
  if (!value) throw new Error(`${name} is empty`)
  if (value.length > 256) throw new Error(`${name} is too long`)
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${name} contains invalid control characters`)
  }
  return value
}

export function normalizeDurableControlId(raw: string): string {
  return normalizeRef(raw, 'controlId')
}

export function normalizeDurableControlSessionId(raw: string): string {
  return normalizeRef(raw, 'sessionId')
}

function optionalText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  return value || undefined
}

export function applyDurableControlEvent(
  records: DurableControlRecord[],
  event: DurableControlEvent,
): DurableControlRecord[] {
  const controlId = normalizeDurableControlId(event.controlId)
  const sessionId = normalizeDurableControlSessionId(event.sessionId)
  if (!isSessionControlKind(event.kind)) {
    throw new Error(`invalid control kind: ${String(event.kind)}`)
  }
  if (!isDurableControlState(event.state)) {
    throw new Error(`invalid control state: ${String(event.state)}`)
  }
  if (
    event.boundary !== undefined &&
    !isDurableControlBoundary(event.boundary)
  ) {
    throw new Error(`invalid control boundary: ${String(event.boundary)}`)
  }

  const next = records.map((record) => ({ ...record }))
  const index = next.findIndex((record) => record.controlId === controlId)
  const previous = index >= 0 ? next[index] : undefined
  if (
    previous &&
    (previous.sessionId !== sessionId || previous.kind !== event.kind)
  ) {
    throw new Error(
      `controlId "${controlId}" conflicts with an existing control`,
    )
  }

  const record: DurableControlRecord = {
    controlId,
    sessionId,
    kind: event.kind,
    state: event.state,
    requestedAt: previous?.requestedAt ?? event.timestamp,
    updatedAt: event.timestamp,
    ...(previous?.expectedTurnId
      ? { expectedTurnId: previous.expectedTurnId }
      : {}),
    ...(previous?.turnId ? { turnId: previous.turnId } : {}),
    ...(previous?.prompt !== undefined ? { prompt: previous.prompt } : {}),
    ...(previous?.querySource ? { querySource: previous.querySource } : {}),
    ...(previous?.boundary ? { boundary: previous.boundary } : {}),
    ...(previous?.detail ? { detail: previous.detail } : {}),
    ...(event.expectedTurnId?.trim()
      ? { expectedTurnId: event.expectedTurnId.trim() }
      : {}),
    ...(event.turnId?.trim() ? { turnId: event.turnId.trim() } : {}),
    ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
    ...(optionalText(event.querySource)
      ? { querySource: optionalText(event.querySource) }
      : {}),
    ...(event.boundary ? { boundary: event.boundary } : {}),
    ...(optionalText(event.detail)
      ? { detail: optionalText(event.detail) }
      : {}),
  }

  if (index >= 0) next[index] = record
  else next.push(record)
  return next
}

export function projectDurableControlEvents(
  events: readonly DurableControlEvent[],
  opts?: { recoverIncomplete?: boolean },
): DurableControlRecord[] {
  let records: DurableControlRecord[] = []
  for (const event of events) {
    try {
      records = applyDurableControlEvent(records, event)
    } catch {
      // transcript 是外部持久化边界；坏行/冲突行 fail-closed 跳过。
    }
  }
  if (opts?.recoverIncomplete === false) return records
  return records.map((record) => {
    if (record.state !== 'pending' && record.state !== 'ready') {
      return record
    }
    return {
      ...record,
      state: 'interrupted',
      interruptedFrom: record.state,
      recoveryReason: 'process_restart',
      recovered: true,
    }
  })
}
