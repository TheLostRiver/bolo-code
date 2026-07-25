import type { SessionUsage } from './sessionUsage.ts'

export const DURABLE_TASK_STATES = [
  'admitted',
  'running',
  'completed',
  'error',
  'aborted',
  'interrupted',
] as const

export const DURABLE_TASK_ISOLATIONS = ['none', 'worktree'] as const

export type DurableTaskState = (typeof DURABLE_TASK_STATES)[number]
export type DurableTaskIsolation =
  (typeof DURABLE_TASK_ISOLATIONS)[number]

export type DurableTaskStateEvent = {
  type: 'state'
  taskId: string
  sessionId: string
  agentType: string
  state: DurableTaskState
  timestamp: string
  parentTurnId?: string
  prompt?: string
  description?: string
  isolation?: DurableTaskIsolation
  detail?: string
}

export type DurableTaskResultEvent = {
  type: 'result'
  taskId: string
  sessionId: string
  timestamp: string
  summary: string
  isError: boolean
  agentTranscriptPath?: string
  usage?: SessionUsage
  totalDurationMs?: number
  totalToolUseCount?: number
  worktreePath?: string
  detail?: string
}

export type DurableTaskEvent =
  | DurableTaskStateEvent
  | DurableTaskResultEvent

export type DurableTaskResult = {
  summary: string
  isError: boolean
  writtenAt: string
  agentTranscriptPath?: string
  usage?: SessionUsage
  totalDurationMs?: number
  totalToolUseCount?: number
  worktreePath?: string
  detail?: string
}

export type DurableTaskRecord = {
  taskId: string
  sessionId: string
  agentType: string
  state: DurableTaskState
  admittedAt: string
  updatedAt: string
  parentTurnId?: string
  prompt?: string
  description?: string
  isolation?: DurableTaskIsolation
  detail?: string
  result?: DurableTaskResult
  recovered?: boolean
  interruptedFrom?: Extract<DurableTaskState, 'admitted' | 'running'>
  recoveryReason?: 'process_restart'
}

export function isDurableTaskState(
  value: unknown,
): value is DurableTaskState {
  return (
    typeof value === 'string' &&
    (DURABLE_TASK_STATES as readonly string[]).includes(value)
  )
}

export function isDurableTaskIsolation(
  value: unknown,
): value is DurableTaskIsolation {
  return (
    typeof value === 'string' &&
    (DURABLE_TASK_ISOLATIONS as readonly string[]).includes(value)
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

export function normalizeDurableTaskId(raw: string): string {
  return normalizeRef(raw, 'taskId')
}

export function normalizeDurableTaskSessionId(raw: string): string {
  return normalizeRef(raw, 'sessionId')
}

function optionalText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  return value || undefined
}

function cloneUsage(usage: SessionUsage | undefined): SessionUsage | undefined {
  if (!usage) return undefined
  return structuredClone(usage)
}

function isTerminal(state: DurableTaskState): boolean {
  return (
    state === 'completed' ||
    state === 'error' ||
    state === 'aborted' ||
    state === 'interrupted'
  )
}

function validTransition(
  previous: DurableTaskState,
  next: DurableTaskState,
): boolean {
  if (previous === next) return true
  if (isTerminal(previous)) return false
  if (previous === 'admitted') {
    return next === 'running' || next === 'error' || next === 'aborted'
  }
  return next === 'completed' || next === 'error' || next === 'aborted'
}

export function applyDurableTaskEvent(
  records: DurableTaskRecord[],
  event: DurableTaskEvent,
): DurableTaskRecord[] {
  const taskId = normalizeDurableTaskId(event.taskId)
  const sessionId = normalizeDurableTaskSessionId(event.sessionId)
  const next = records.map((record) => ({
    ...record,
    ...(record.result
      ? { result: { ...record.result, usage: cloneUsage(record.result.usage) } }
      : {}),
  }))
  const index = next.findIndex((record) => record.taskId === taskId)
  const previous = index >= 0 ? next[index] : undefined
  if (previous && previous.sessionId !== sessionId) {
    throw new Error(`taskId "${taskId}" conflicts with another session`)
  }

  if (event.type === 'result') {
    if (!previous) {
      throw new Error(`task result "${taskId}" has no admitted lifecycle`)
    }
    if (isTerminal(previous.state)) {
      throw new Error(`task result "${taskId}" arrived after terminal state`)
    }
    const summary = event.summary.trim()
    if (!summary) throw new Error('task result summary is empty')
    next[index] = {
      ...previous,
      updatedAt: event.timestamp,
      result: {
        summary,
        isError: event.isError,
        writtenAt: event.timestamp,
        ...(optionalText(event.agentTranscriptPath)
          ? { agentTranscriptPath: optionalText(event.agentTranscriptPath) }
          : {}),
        ...(event.usage ? { usage: cloneUsage(event.usage) } : {}),
        ...(event.totalDurationMs != null
          ? { totalDurationMs: Math.max(0, event.totalDurationMs) }
          : {}),
        ...(event.totalToolUseCount != null
          ? { totalToolUseCount: Math.max(0, event.totalToolUseCount) }
          : {}),
        ...(optionalText(event.worktreePath)
          ? { worktreePath: optionalText(event.worktreePath) }
          : {}),
        ...(optionalText(event.detail)
          ? { detail: optionalText(event.detail) }
          : {}),
      },
    }
    return next
  }

  if (!isDurableTaskState(event.state)) {
    throw new Error(`invalid task state: ${String(event.state)}`)
  }
  const agentType = normalizeRef(event.agentType, 'agentType')
  if (!previous && event.state !== 'admitted') {
    throw new Error(`task "${taskId}" must begin with admitted`)
  }
  if (previous) {
    if (previous.agentType !== agentType) {
      throw new Error(`taskId "${taskId}" conflicts with another agentType`)
    }
    if (!validTransition(previous.state, event.state)) {
      throw new Error(
        `invalid task transition ${previous.state} -> ${event.state}`,
      )
    }
    if (
      (event.state === 'completed' ||
        event.state === 'error' ||
        event.state === 'aborted') &&
      !previous.result
    ) {
      throw new Error(
        `task "${taskId}" cannot enter ${event.state} before result`,
      )
    }
  }

  const record: DurableTaskRecord = {
    taskId,
    sessionId,
    agentType,
    state: event.state,
    admittedAt: previous?.admittedAt ?? event.timestamp,
    updatedAt: event.timestamp,
    ...(previous?.parentTurnId
      ? { parentTurnId: previous.parentTurnId }
      : {}),
    ...(previous?.prompt !== undefined ? { prompt: previous.prompt } : {}),
    ...(previous?.description
      ? { description: previous.description }
      : {}),
    ...(previous?.isolation ? { isolation: previous.isolation } : {}),
    ...(previous?.detail ? { detail: previous.detail } : {}),
    ...(previous?.result ? { result: previous.result } : {}),
    ...(optionalText(event.parentTurnId)
      ? { parentTurnId: optionalText(event.parentTurnId) }
      : {}),
    ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
    ...(optionalText(event.description)
      ? { description: optionalText(event.description) }
      : {}),
    ...(event.isolation ? { isolation: event.isolation } : {}),
    ...(optionalText(event.detail)
      ? { detail: optionalText(event.detail) }
      : {}),
  }
  if (index >= 0) next[index] = record
  else next.push(record)
  return next
}

export function projectDurableTaskEvents(
  events: readonly DurableTaskEvent[],
  opts?: { recoverIncomplete?: boolean },
): DurableTaskRecord[] {
  let records: DurableTaskRecord[] = []
  for (const event of events) {
    try {
      records = applyDurableTaskEvent(records, event)
    } catch {
      // transcript 是外部边界；非法/冲突/乱序记录 fail-closed 跳过。
    }
  }
  if (opts?.recoverIncomplete === false) return records
  return records.map((record) => {
    if (record.state !== 'admitted' && record.state !== 'running') {
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
