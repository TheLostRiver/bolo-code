import {
  RUNTIME_PROTOCOL_FEATURES,
  RUNTIME_PROTOCOL_VERSION,
  nowIso,
  parseRuntimeSnapshot,
  type RuntimeControlView,
  type RuntimeRunnerView,
  type RuntimeResolutionView,
  type RuntimeSessionPhase,
  type RuntimeSnapshot,
  type RuntimeTaskResultView,
  type RuntimeTaskState,
  type RuntimeTaskView,
  type RuntimeTurnView,
  type RuntimeUsageView,
} from '../../shared/src/index.ts'
import type { DurableControlRecord } from './durableControl.ts'
import type { DurableTaskRecord } from './durableTask.ts'
import type { DurableTurnRecord } from './durableTurn.ts'
import type { DurableResolutionRecord } from './durableResolution.ts'
import type {
  SessionControlRecord,
  SessionRunnerSnapshot,
} from './sessionCoordinator.ts'
import type {
  BackgroundAgentEntry,
  BackgroundAgentStore,
  BackgroundAgentStatus,
} from './subagent.ts'

/**
 * Minimal source surface for a runtime snapshot.
 *
 * Deliberately excludes provider, tools, callbacks, leases, and all other
 * execution objects. BoloSession satisfies this interface structurally.
 */
export type RuntimeSnapshotSource = {
  id: string
  cwd: string
  phase: RuntimeSessionPhase
  coordinator: {
    snapshot(sessionId: string): SessionRunnerSnapshot
  }
  durableTurns: readonly DurableTurnRecord[]
  durableControls: readonly DurableControlRecord[]
  durableTasks: readonly DurableTaskRecord[]
  durableResolutions: readonly DurableResolutionRecord[]
  backgroundAgents?: BackgroundAgentStore
}

export type BuildRuntimeSnapshotOptions = {
  generatedAt?: string
  features?: readonly string[]
}

function copyUsage(
  usage: import('./sessionUsage.ts').SessionUsage | undefined,
): RuntimeUsageView | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    calls: usage.calls,
    ...(usage.estimated !== undefined
      ? { estimated: usage.estimated }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? {
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
        }
      : {}),
  }
}

function resolutionView(
  record: DurableResolutionRecord | undefined,
): RuntimeResolutionView | undefined {
  if (!record) return undefined
  return {
    resolutionId: record.resolutionId,
    sessionId: record.sessionId,
    entityKind: record.entityKind,
    entityId: record.entityId,
    action: record.action,
    resolvedAt: record.resolvedAt,
    updatedAt: record.updatedAt,
    ...(record.replacementId
      ? { replacementId: record.replacementId }
      : {}),
    ...(record.detail ? { detail: record.detail } : {}),
  }
}

function resolutionKey(
  entityKind: 'turn' | 'control' | 'task',
  entityId: string,
): string {
  return `${entityKind}:${entityId}`
}

function turnView(
  record: DurableTurnRecord,
  resolution?: DurableResolutionRecord,
): RuntimeTurnView {
  const resolved = resolutionView(resolution)
  return {
    turnId: record.turnId,
    state: record.state,
    ...(record.prompt !== undefined ? { prompt: record.prompt } : {}),
    ...(record.querySource ? { querySource: record.querySource } : {}),
    ...(record.admittedAt ? { admittedAt: record.admittedAt } : {}),
    updatedAt: record.updatedAt,
    ...(record.terminalReason
      ? { terminalReason: record.terminalReason }
      : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    ...(record.recovered !== undefined
      ? { recovered: record.recovered }
      : {}),
    ...(record.interruptedFrom
      ? { interruptedFrom: record.interruptedFrom }
      : {}),
    ...(record.recoveryReason
      ? { recoveryReason: record.recoveryReason }
      : {}),
    ...(resolved ? { resolution: resolved } : {}),
  }
}

function durableControlView(
  record: DurableControlRecord,
  resolution?: DurableResolutionRecord,
): RuntimeControlView {
  const resolved = resolutionView(resolution)
  return {
    controlId: record.controlId,
    sessionId: record.sessionId,
    kind: record.kind,
    state: record.state,
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
    ...(record.expectedTurnId
      ? { expectedTurnId: record.expectedTurnId }
      : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(record.prompt !== undefined ? { prompt: record.prompt } : {}),
    ...(record.querySource ? { querySource: record.querySource } : {}),
    ...(record.boundary ? { boundary: record.boundary } : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    ...(record.recovered !== undefined
      ? { recovered: record.recovered }
      : {}),
    ...(record.interruptedFrom
      ? { interruptedFrom: record.interruptedFrom }
      : {}),
    ...(record.recoveryReason
      ? { recoveryReason: record.recoveryReason }
      : {}),
    ...(resolved ? { resolution: resolved } : {}),
  }
}

function liveControlView(
  record: SessionControlRecord,
  resolution?: RuntimeResolutionView,
): RuntimeControlView {
  return {
    controlId: record.controlId,
    sessionId: record.sessionId,
    kind: record.kind,
    state: record.state,
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
    ...(record.expectedTurnId
      ? { expectedTurnId: record.expectedTurnId }
      : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(record.prompt !== undefined ? { prompt: record.prompt } : {}),
    ...(record.querySource ? { querySource: record.querySource } : {}),
    ...(record.boundary ? { boundary: record.boundary } : {}),
    ...(resolution ? { resolution } : {}),
  }
}

function taskResultView(
  result: DurableTaskRecord['result'],
): RuntimeTaskResultView | undefined {
  if (!result) return undefined
  const usage = copyUsage(result.usage)
  return {
    summary: result.summary,
    isError: result.isError,
    writtenAt: result.writtenAt,
    ...(result.agentTranscriptPath
      ? { agentTranscriptPath: result.agentTranscriptPath }
      : {}),
    ...(usage ? { usage } : {}),
    ...(result.totalDurationMs !== undefined
      ? { totalDurationMs: result.totalDurationMs }
      : {}),
    ...(result.totalToolUseCount !== undefined
      ? { totalToolUseCount: result.totalToolUseCount }
      : {}),
    ...(result.worktreePath
      ? { worktreePath: result.worktreePath }
      : {}),
    ...(result.detail ? { detail: result.detail } : {}),
  }
}

function liveResultView(
  entry: BackgroundAgentEntry | undefined,
): RuntimeTaskResultView | undefined {
  if (!entry?.summary || !entry.finishedAt) return undefined
  const usage = copyUsage(entry.usage)
  return {
    summary: entry.summary,
    isError:
      entry.isError === true ||
      entry.status === 'error' ||
      entry.status === 'aborted',
    writtenAt: entry.finishedAt,
    ...(entry.agentTranscriptPath
      ? { agentTranscriptPath: entry.agentTranscriptPath }
      : {}),
    ...(usage ? { usage } : {}),
    ...(entry.totalDurationMs !== undefined
      ? { totalDurationMs: entry.totalDurationMs }
      : {}),
    ...(entry.totalToolUseCount !== undefined
      ? { totalToolUseCount: entry.totalToolUseCount }
      : {}),
    ...(entry.worktreePath
      ? { worktreePath: entry.worktreePath }
      : {}),
  }
}

function taskState(status: BackgroundAgentStatus): RuntimeTaskState {
  if (status === 'done') return 'completed'
  return status
}

function durableTaskView(
  record: DurableTaskRecord,
  live?: BackgroundAgentEntry,
  resolution?: DurableResolutionRecord,
): RuntimeTaskView {
  const result = taskResultView(record.result) ?? liveResultView(live)
  const resolved = resolutionView(resolution)
  const parentTurnId = live?.parentTurnId ?? record.parentTurnId
  const prompt = live?.prompt ?? record.prompt
  const description = live?.description ?? record.description
  return {
    taskId: record.taskId,
    sessionId: record.sessionId,
    agentType: record.agentType,
    state: live ? taskState(live.status) : record.state,
    admittedAt: record.admittedAt,
    updatedAt: live?.finishedAt ?? record.updatedAt,
    ...(parentTurnId ? { parentTurnId } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(description ? { description } : {}),
    ...(record.isolation ? { isolation: record.isolation } : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    ...(result ? { result } : {}),
    ...(record.recovered !== undefined
      ? { recovered: record.recovered }
      : {}),
    ...(record.interruptedFrom
      ? { interruptedFrom: record.interruptedFrom }
      : {}),
    ...(record.recoveryReason
      ? { recoveryReason: record.recoveryReason }
      : {}),
    ...(resolved ? { resolution: resolved } : {}),
  }
}

function liveOnlyTaskView(
  sessionId: string,
  entry: BackgroundAgentEntry,
): RuntimeTaskView {
  const result = liveResultView(entry)
  return {
    taskId: entry.agentId,
    sessionId,
    agentType: entry.agentType,
    state: taskState(entry.status),
    admittedAt: entry.startedAt,
    updatedAt: entry.finishedAt ?? entry.startedAt,
    ...(entry.parentTurnId ? { parentTurnId: entry.parentTurnId } : {}),
    prompt: entry.prompt,
    ...(entry.description ? { description: entry.description } : {}),
    ...(result ? { result } : {}),
  }
}

function liveBackgroundEntries(
  store: BackgroundAgentStore | undefined,
): Map<string, BackgroundAgentEntry> {
  const entries = new Map<string, BackgroundAgentEntry>()
  if (!store) return entries
  for (const entry of Object.values(store.pendingAgents)) {
    entries.set(entry.agentId, entry)
  }
  for (const entry of Object.values(store.backgroundAgentResults)) {
    entries.set(entry.agentId, entry)
  }
  return entries
}

function runnerView(snapshot: SessionRunnerSnapshot): RuntimeRunnerView {
  if (snapshot.state === 'idle') return { state: 'idle' }
  return {
    state: 'running',
    active: {
      sessionId: snapshot.active.sessionId,
      turnId: snapshot.active.turnId,
      acquiredAt: snapshot.active.acquiredAt,
      ...(snapshot.active.querySource
        ? { querySource: snapshot.active.querySource }
        : {}),
    },
  }
}

export function buildRuntimeSnapshot(
  source: RuntimeSnapshotSource,
  options?: BuildRuntimeSnapshotOptions,
): RuntimeSnapshot {
  const coordinator = source.coordinator.snapshot(source.id)
  const resolutions = new Map<string, DurableResolutionRecord>()
  for (const resolution of source.durableResolutions) {
    const key = resolutionKey(
      resolution.entityKind,
      resolution.entityId,
    )
    if (resolutions.has(key)) {
      throw new Error(`duplicate runtime resolution target "${key}"`)
    }
    resolutions.set(key, resolution)
  }
  const attachedResolutionKeys = new Set<string>()
  const controls = new Map<string, RuntimeControlView>()
  for (const record of source.durableControls) {
    const key = resolutionKey('control', record.controlId)
    const resolution = resolutions.get(key)
    if (resolution) attachedResolutionKeys.add(key)
    controls.set(
      record.controlId,
      durableControlView(record, resolution),
    )
  }
  for (const record of coordinator.controls) {
    const previous = controls.get(record.controlId)
    controls.set(
      record.controlId,
      liveControlView(record, previous?.resolution),
    )
  }

  const liveTasks = liveBackgroundEntries(source.backgroundAgents)
  const tasks = new Map<string, RuntimeTaskView>()
  for (const record of source.durableTasks) {
    const key = resolutionKey('task', record.taskId)
    const resolution = resolutions.get(key)
    if (resolution) attachedResolutionKeys.add(key)
    tasks.set(
      record.taskId,
      durableTaskView(
        record,
        liveTasks.get(record.taskId),
        resolution,
      ),
    )
  }
  for (const [taskId, entry] of liveTasks) {
    if (!tasks.has(taskId)) {
      tasks.set(taskId, liveOnlyTaskView(source.id, entry))
    }
  }

  const candidate: RuntimeSnapshot = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.snapshot',
    generatedAt: options?.generatedAt ?? nowIso(),
    features: [...(options?.features ?? RUNTIME_PROTOCOL_FEATURES)],
    session: {
      sessionId: source.id,
      cwd: source.cwd,
      phase: source.phase,
      runner: runnerView(coordinator),
      turns: source.durableTurns.map((record) => {
        const key = resolutionKey('turn', record.turnId)
        const resolution = resolutions.get(key)
        if (resolution) attachedResolutionKeys.add(key)
        return turnView(record, resolution)
      }),
      controls: [...controls.values()],
      tasks: [...tasks.values()],
    },
  }
  if (attachedResolutionKeys.size !== resolutions.size) {
    const missing = [...resolutions.keys()].find(
      (key) => !attachedResolutionKeys.has(key),
    )
    throw new Error(`runtime resolution target "${missing}" was not found`)
  }
  const parsed = parseRuntimeSnapshot(candidate)
  if (!parsed.ok) {
    throw new Error(`invalid runtime snapshot: ${parsed.detail}`)
  }
  return parsed.value
}
