import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeControlView,
  type RuntimeCommand,
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

type RuntimeActionCommand = Exclude<
  RuntimeCommand,
  { action: 'runtime.inspect' }
>

type RuntimeCommandIntent<T> = T extends RuntimeCommand
  ? Pick<T, 'action' | 'target'>
  : never

export type RuntimeAvailableAction =
  RuntimeCommandIntent<RuntimeActionCommand>

export type RuntimeTurnListItem = {
  entity: 'turn'
  entityId: string
  record: RuntimeTurnView
  availableActions: RuntimeAvailableAction[]
}

export type RuntimeControlListItem = {
  entity: 'control'
  entityId: string
  record: RuntimeControlView
  availableActions: RuntimeAvailableAction[]
}

export type RuntimeTaskListItem = {
  entity: 'task'
  entityId: string
  record: RuntimeTaskView
  availableActions: RuntimeAvailableAction[]
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
  const sessionId = snapshot.session.sessionId
  const runner = snapshot.session.runner
  return [
    ...snapshot.session.turns.map(
      (record): RuntimeTurnListItem => ({
        entity: 'turn',
        entityId: record.turnId,
        record: structuredClone(record),
        availableActions: (() => {
          const actions: RuntimeAvailableAction[] = []
          if (
            record.state === 'running' &&
            runner.state === 'running' &&
            runner.active.turnId === record.turnId
          ) {
            actions.push({
              action: 'turn.interrupt',
              target: {
                sessionId,
                turnId: record.turnId,
                expectedState: 'running',
              },
            })
          }
          if (record.state === 'interrupted' && !record.resolution) {
            actions.push({
              action: 'runtime.discard',
              target: {
                sessionId,
                entity: 'turn',
                entityId: record.turnId,
                expectedState: 'interrupted',
              },
            })
            if (
              runner.state === 'idle' &&
              record.interruptedFrom === 'admitted' &&
              Boolean(record.prompt?.trim())
            ) {
              actions.push({
                action: 'runtime.retry-safe',
                target: {
                  sessionId,
                  entity: 'turn',
                  entityId: record.turnId,
                  expectedState: 'interrupted',
                },
              })
            }
          }
          return actions
        })(),
      }),
    ),
    ...snapshot.session.controls.map(
      (record): RuntimeControlListItem => ({
        entity: 'control',
        entityId: record.controlId,
        record: structuredClone(record),
        availableActions: (() => {
          const actions: RuntimeAvailableAction[] = []
          if (record.state === 'pending' || record.state === 'ready') {
            actions.push({
              action: 'control.cancel',
              target: {
                sessionId,
                controlId: record.controlId,
                expectedState: record.state,
              },
            })
          }
          if (record.state === 'interrupted' && !record.resolution) {
            actions.push({
              action: 'runtime.discard',
              target: {
                sessionId,
                entity: 'control',
                entityId: record.controlId,
                expectedState: 'interrupted',
              },
            })
            if (
              runner.state === 'idle' &&
              record.kind === 'queue' &&
              (record.interruptedFrom === 'pending' ||
                record.interruptedFrom === 'ready') &&
              Boolean(record.prompt?.trim())
            ) {
              actions.push({
                action: 'runtime.retry-safe',
                target: {
                  sessionId,
                  entity: 'control',
                  entityId: record.controlId,
                  expectedState: 'interrupted',
                },
              })
            }
          }
          return actions
        })(),
      }),
    ),
    ...snapshot.session.tasks.map(
      (record): RuntimeTaskListItem => ({
        entity: 'task',
        entityId: record.taskId,
        record: structuredClone(record),
        availableActions: (() => {
          const actions: RuntimeAvailableAction[] = []
          if (record.state === 'queued') {
            actions.push({
              action: 'task.cancel',
              target: {
                sessionId,
                taskId: record.taskId,
                expectedState: 'queued',
              },
            })
          }
          if (record.state === 'interrupted' && !record.resolution) {
            actions.push({
              action: 'runtime.discard',
              target: {
                sessionId,
                entity: 'task',
                entityId: record.taskId,
                expectedState: 'interrupted',
              },
            })
          }
          return actions
        })(),
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
