/**
 * Agent Runtime 入口（骨架）
 *
 * 职责：会话状态机、query 循环、挂载 HookBus / Permission / Subagent
 * 禁止：Electron / DOM
 */

export type SessionPhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'running'
  | 'awaiting_permission'
  | 'compacting'
  | 'stopping'
  | 'ended'

export type CreateSessionInput = {
  cwd: string
  sessionId?: string
}

export function createSessionPlaceholder(input: CreateSessionInput) {
  return {
    id: input.sessionId ?? cryptoRandomId(),
    cwd: input.cwd,
    phase: 'idle' as SessionPhase,
  }
}

function cryptoRandomId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}