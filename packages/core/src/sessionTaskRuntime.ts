import {
  applyDurableTaskEvent,
  type DurableTaskRecord,
  type DurableTaskStateEvent,
  type DurableTaskResultEvent,
} from './durableTask.ts'
import {
  appendSessionTaskResult,
  appendSessionTaskState,
  type PersistableSession,
} from './sessionPersist.ts'
import type {
  BackgroundTaskAdmission,
  BackgroundTaskCompletion,
  DurableBackgroundTaskLifecycle,
} from './subagent.ts'

export type SessionTaskRuntimeSession = PersistableSession & {
  durableTasks: DurableTaskRecord[]
}

function applyState(
  session: SessionTaskRuntimeSession,
  event: DurableTaskStateEvent,
): void {
  session.durableTasks = applyDurableTaskEvent(session.durableTasks, event)
}

function applyResult(
  session: SessionTaskRuntimeSession,
  event: DurableTaskResultEvent,
): void {
  session.durableTasks = applyDurableTaskEvent(session.durableTasks, event)
}

export function createSessionBackgroundTaskLifecycle(
  session: SessionTaskRuntimeSession,
): DurableBackgroundTaskLifecycle {
  return {
    async admit(input: BackgroundTaskAdmission): Promise<void> {
      const entry = await appendSessionTaskState(session, {
        taskId: input.taskId,
        parentTurnId: input.parentTurnId,
        agentType: input.agentType,
        state: 'admitted',
        prompt: input.prompt,
        description: input.description,
        isolation: input.isolation,
      })
      applyState(session, {
        type: 'state',
        taskId: input.taskId,
        sessionId: session.id,
        parentTurnId: input.parentTurnId,
        agentType: input.agentType,
        state: 'admitted',
        prompt: input.prompt,
        description: input.description,
        isolation: input.isolation,
        timestamp: entry?.timestamp ?? new Date().toISOString(),
      })
    },

    async markRunning(input): Promise<void> {
      const entry = await appendSessionTaskState(session, {
        taskId: input.taskId,
        agentType: input.agentType,
        state: 'running',
      })
      applyState(session, {
        type: 'state',
        taskId: input.taskId,
        sessionId: session.id,
        agentType: input.agentType,
        state: 'running',
        timestamp: entry?.timestamp ?? new Date().toISOString(),
      })
    },

    async finish(input: BackgroundTaskCompletion): Promise<void> {
      const resultEntry = await appendSessionTaskResult(session, {
        taskId: input.taskId,
        summary: input.summary,
        isError: input.isError,
        agentTranscriptPath: input.agentTranscriptPath,
        usage: input.usage,
        totalDurationMs: input.totalDurationMs,
        totalToolUseCount: input.totalToolUseCount,
        worktreePath: input.worktreePath,
        detail: input.detail,
      })
      applyResult(session, {
        type: 'result',
        taskId: input.taskId,
        sessionId: session.id,
        summary: input.summary,
        isError: input.isError,
        agentTranscriptPath: input.agentTranscriptPath,
        usage: input.usage,
        totalDurationMs: input.totalDurationMs,
        totalToolUseCount: input.totalToolUseCount,
        worktreePath: input.worktreePath,
        detail: input.detail,
        timestamp: resultEntry?.timestamp ?? new Date().toISOString(),
      })

      const terminalEntry = await appendSessionTaskState(session, {
        taskId: input.taskId,
        agentType: input.agentType,
        state: input.state,
        detail: input.detail,
      })
      applyState(session, {
        type: 'state',
        taskId: input.taskId,
        sessionId: session.id,
        agentType: input.agentType,
        state: input.state,
        detail: input.detail,
        timestamp: terminalEntry?.timestamp ?? new Date().toISOString(),
      })
    },
  }
}
