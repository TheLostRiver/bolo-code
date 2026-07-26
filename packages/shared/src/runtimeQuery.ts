import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeControlView,
  type RuntimeRunnerView,
  type RuntimeSessionPhase,
  type RuntimeSnapshot,
  type RuntimeTaskView,
  type RuntimeTurnView,
} from './runtimeProtocol.ts'

export const RUNTIME_QUERY_ENTITIES = [
  'turn',
  'control',
  'task',
] as const

export type RuntimeQueryEntity =
  (typeof RUNTIME_QUERY_ENTITIES)[number]

export type RuntimeQuery =
  | {
      action: 'list'
      entity?: RuntimeQueryEntity
    }
  | {
      action: 'inspect'
      entity: RuntimeQueryEntity
      entityId: string
    }

export type RuntimeTurnListItem = {
  entity: 'turn'
  entityId: string
  record: RuntimeTurnView
}

export type RuntimeControlListItem = {
  entity: 'control'
  entityId: string
  record: RuntimeControlView
}

export type RuntimeTaskListItem = {
  entity: 'task'
  entityId: string
  record: RuntimeTaskView
}

export type RuntimeListItem =
  | RuntimeTurnListItem
  | RuntimeControlListItem
  | RuntimeTaskListItem

export type RuntimeListView = {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION
  kind: 'runtime.list'
  generatedAt: string
  sessionId: string
  phase: RuntimeSessionPhase
  runner: RuntimeRunnerView
  entity: RuntimeQueryEntity | 'all'
  items: RuntimeListItem[]
}

export type RuntimeInspectView = {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION
  kind: 'runtime.inspect'
  generatedAt: string
  sessionId: string
  entity: RuntimeQueryEntity
  item: RuntimeListItem
}

export type RuntimeQueryView = RuntimeListView | RuntimeInspectView

export type RuntimeQueryResult =
  | {
      ok: true
      view: RuntimeQueryView
    }
  | {
      ok: false
      code: 'invalid_query' | 'not_found'
      detail: string
    }

export function isRuntimeQueryEntity(
  value: unknown,
): value is RuntimeQueryEntity {
  return (
    typeof value === 'string' &&
    (RUNTIME_QUERY_ENTITIES as readonly string[]).includes(value)
  )
}

function listItems(snapshot: RuntimeSnapshot): RuntimeListItem[] {
  return [
    ...snapshot.session.turns.map(
      (record): RuntimeTurnListItem => ({
        entity: 'turn',
        entityId: record.turnId,
        record: structuredClone(record),
      }),
    ),
    ...snapshot.session.controls.map(
      (record): RuntimeControlListItem => ({
        entity: 'control',
        entityId: record.controlId,
        record: structuredClone(record),
      }),
    ),
    ...snapshot.session.tasks.map(
      (record): RuntimeTaskListItem => ({
        entity: 'task',
        entityId: record.taskId,
        record: structuredClone(record),
      }),
    ),
  ]
}

/**
 * AR1A pure runtime query projection.
 *
 * Consumers receive detached records and never inspect coordinator/provider
 * internals. The input remains the validated DR4 RuntimeSnapshot.
 */
export function queryRuntimeSnapshot(
  snapshot: RuntimeSnapshot,
  query: RuntimeQuery,
): RuntimeQueryResult {
  const items = listItems(snapshot)
  if (query.action === 'list') {
    if (
      query.entity !== undefined &&
      !isRuntimeQueryEntity(query.entity)
    ) {
      return {
        ok: false,
        code: 'invalid_query',
        detail: `invalid runtime entity: ${String(query.entity)}`,
      }
    }
    const entity = query.entity ?? 'all'
    return {
      ok: true,
      view: {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'runtime.list',
        generatedAt: snapshot.generatedAt,
        sessionId: snapshot.session.sessionId,
        phase: snapshot.session.phase,
        runner: structuredClone(snapshot.session.runner),
        entity,
        items:
          entity === 'all'
            ? items
            : items.filter((item) => item.entity === entity),
      },
    }
  }

  if (!isRuntimeQueryEntity(query.entity)) {
    return {
      ok: false,
      code: 'invalid_query',
      detail: `invalid runtime entity: ${String(query.entity)}`,
    }
  }
  const entityId = query.entityId.trim()
  if (!entityId) {
    return {
      ok: false,
      code: 'invalid_query',
      detail: 'runtime inspect entityId is empty',
    }
  }
  const item = items.find(
    (candidate) =>
      candidate.entity === query.entity &&
      candidate.entityId === entityId,
  )
  if (!item) {
    return {
      ok: false,
      code: 'not_found',
      detail: `runtime ${query.entity} "${entityId}" not found`,
    }
  }
  return {
    ok: true,
    view: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.inspect',
      generatedAt: snapshot.generatedAt,
      sessionId: snapshot.session.sessionId,
      entity: query.entity,
      item,
    },
  }
}
