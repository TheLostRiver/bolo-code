export const DURABLE_TURN_STATES = [
  'admitted',
  'running',
  'completed',
  'error',
  'aborted',
  'interrupted',
] as const

export type DurableTurnState = (typeof DURABLE_TURN_STATES)[number]

export type DurableTurnEvent = {
  turnId: string
  state: DurableTurnState
  timestamp: string
  prompt?: string
  querySource?: string
  terminalReason?: string
  detail?: string
}

export type DurableTurnRecord = {
  turnId: string
  state: DurableTurnState
  prompt?: string
  querySource?: string
  admittedAt?: string
  updatedAt: string
  terminalReason?: string
  detail?: string
  /** admitted/running 在恢复时只投影为 interrupted，不代表自动重放。 */
  recovered?: boolean
}

export function isDurableTurnState(value: unknown): value is DurableTurnState {
  return (
    typeof value === 'string' &&
    (DURABLE_TURN_STATES as readonly string[]).includes(value)
  )
}

export function normalizeDurableTurnId(raw: string): string {
  const turnId = raw.trim()
  if (!turnId) throw new Error('turnId is empty')
  if (turnId.length > 256) throw new Error('turnId is too long')
  if (/[\r\n\0]/.test(turnId)) {
    throw new Error('turnId contains invalid control characters')
  }
  return turnId
}

export function applyDurableTurnEvent(
  records: DurableTurnRecord[],
  event: DurableTurnEvent,
): DurableTurnRecord[] {
  const turnId = normalizeDurableTurnId(event.turnId)
  const next = records.map((record) => ({ ...record }))
  const index = next.findIndex((record) => record.turnId === turnId)
  const previous = index >= 0 ? next[index] : undefined
  const record: DurableTurnRecord = {
    turnId,
    state: event.state,
    updatedAt: event.timestamp,
    ...(previous?.prompt ? { prompt: previous.prompt } : {}),
    ...(previous?.querySource ? { querySource: previous.querySource } : {}),
    ...(previous?.admittedAt ? { admittedAt: previous.admittedAt } : {}),
    ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
    ...(event.querySource ? { querySource: event.querySource } : {}),
    ...(event.terminalReason
      ? { terminalReason: event.terminalReason }
      : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  }
  if (event.state === 'admitted' && !record.admittedAt) {
    record.admittedAt = event.timestamp
  }
  if (index >= 0) next[index] = record
  else next.push(record)
  return next
}

export function projectDurableTurnEvents(
  events: readonly DurableTurnEvent[],
  opts?: { recoverIncomplete?: boolean },
): DurableTurnRecord[] {
  let records: DurableTurnRecord[] = []
  for (const event of events) {
    records = applyDurableTurnEvent(records, event)
  }
  if (opts?.recoverIncomplete === false) return records
  return records.map((record) => {
    if (record.state !== 'admitted' && record.state !== 'running') {
      return record
    }
    return {
      ...record,
      state: 'interrupted',
      terminalReason: 'process_restart',
      recovered: true,
    }
  })
}
