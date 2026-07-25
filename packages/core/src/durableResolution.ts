export const DURABLE_RESOLUTION_ACTIONS = [
  'discard',
  'retry_safe',
] as const

export const DURABLE_RESOLUTION_ENTITY_KINDS = [
  'turn',
  'control',
  'task',
] as const

export type DurableResolutionAction =
  (typeof DURABLE_RESOLUTION_ACTIONS)[number]
export type DurableResolutionEntityKind =
  (typeof DURABLE_RESOLUTION_ENTITY_KINDS)[number]

export type DurableResolutionEvent = {
  resolutionId: string
  sessionId: string
  entityKind: DurableResolutionEntityKind
  entityId: string
  action: DurableResolutionAction
  timestamp: string
  replacementId?: string
  detail?: string
}

export type DurableResolutionRecord = {
  resolutionId: string
  sessionId: string
  entityKind: DurableResolutionEntityKind
  entityId: string
  action: DurableResolutionAction
  resolvedAt: string
  updatedAt: string
  replacementId?: string
  detail?: string
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

function optionalDetail(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (raw.includes('\0')) {
    throw new Error('resolution detail contains a null character')
  }
  const detail = raw.trim()
  return detail || undefined
}

export function normalizeDurableResolutionId(raw: string): string {
  return normalizeRef(raw, 'resolutionId')
}

export function normalizeDurableResolutionSessionId(raw: string): string {
  return normalizeRef(raw, 'sessionId')
}

export function normalizeDurableResolutionEntityId(raw: string): string {
  return normalizeRef(raw, 'entityId')
}

export function isDurableResolutionAction(
  value: unknown,
): value is DurableResolutionAction {
  return (
    typeof value === 'string' &&
    (DURABLE_RESOLUTION_ACTIONS as readonly string[]).includes(value)
  )
}

export function isDurableResolutionEntityKind(
  value: unknown,
): value is DurableResolutionEntityKind {
  return (
    typeof value === 'string' &&
    (DURABLE_RESOLUTION_ENTITY_KINDS as readonly string[]).includes(value)
  )
}

function canonicalEvent(event: DurableResolutionEvent): {
  resolutionId: string
  sessionId: string
  entityKind: DurableResolutionEntityKind
  entityId: string
  action: DurableResolutionAction
  replacementId?: string
  detail?: string
} {
  const resolutionId = normalizeDurableResolutionId(event.resolutionId)
  const sessionId = normalizeDurableResolutionSessionId(event.sessionId)
  const entityId = normalizeDurableResolutionEntityId(event.entityId)
  if (!isDurableResolutionEntityKind(event.entityKind)) {
    throw new Error(
      `invalid resolution entity kind: ${String(event.entityKind)}`,
    )
  }
  if (!isDurableResolutionAction(event.action)) {
    throw new Error(`invalid resolution action: ${String(event.action)}`)
  }
  const replacementId = event.replacementId
    ? normalizeDurableResolutionEntityId(event.replacementId)
    : undefined
  if (event.action === 'discard' && replacementId) {
    throw new Error('discard resolution cannot have a replacementId')
  }
  if (event.action === 'retry_safe' && !replacementId) {
    throw new Error('retry_safe resolution requires replacementId')
  }
  const detail = optionalDetail(event.detail)
  return {
    resolutionId,
    sessionId,
    entityKind: event.entityKind,
    entityId,
    action: event.action,
    ...(replacementId ? { replacementId } : {}),
    ...(detail ? { detail } : {}),
  }
}

function recordFingerprint(
  record: Pick<
    DurableResolutionRecord,
    | 'sessionId'
    | 'entityKind'
    | 'entityId'
    | 'action'
    | 'replacementId'
  >,
): string {
  return JSON.stringify({
    sessionId: record.sessionId,
    entityKind: record.entityKind,
    entityId: record.entityId,
    action: record.action,
    ...(record.replacementId
      ? { replacementId: record.replacementId }
      : {}),
  })
}

export function applyDurableResolutionEvent(
  records: DurableResolutionRecord[],
  event: DurableResolutionEvent,
): DurableResolutionRecord[] {
  const canonical = canonicalEvent(event)
  const next = records.map((record) => ({ ...record }))
  const sameId = next.find(
    (record) => record.resolutionId === canonical.resolutionId,
  )
  if (sameId) {
    if (recordFingerprint(sameId) !== recordFingerprint(canonical)) {
      throw new Error(
        `resolutionId "${canonical.resolutionId}" conflicts with an existing resolution`,
      )
    }
    return next
  }
  const sameEntity = next.find(
    (record) =>
      record.sessionId === canonical.sessionId &&
      record.entityKind === canonical.entityKind &&
      record.entityId === canonical.entityId,
  )
  if (sameEntity) {
    throw new Error(
      `${canonical.entityKind} "${canonical.entityId}" is already resolved by "${sameEntity.resolutionId}"`,
    )
  }
  next.push({
    ...canonical,
    resolvedAt: event.timestamp,
    updatedAt: event.timestamp,
  })
  return next
}

export function projectDurableResolutionEvents(
  events: readonly DurableResolutionEvent[],
): DurableResolutionRecord[] {
  let records: DurableResolutionRecord[] = []
  for (const event of events) {
    try {
      records = applyDurableResolutionEvent(records, event)
    } catch {
      // transcript 是外部边界；冲突/非法 resolution fail-closed 跳过。
    }
  }
  return records
}
