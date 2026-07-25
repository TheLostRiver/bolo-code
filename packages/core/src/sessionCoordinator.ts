import { nowIso } from '../../shared/src/index.ts'
import { normalizeDurableTurnId } from './durableTurn.ts'

export const SESSION_RUNNER_BUSY_CODE = 'session_runner_busy' as const

export type SessionRunnerOwner = {
  sessionId: string
  turnId: string
  acquiredAt: string
  querySource?: string
}

export type SessionRunnerSnapshot =
  | {
      sessionId: string
      state: 'idle'
    }
  | {
      sessionId: string
      state: 'running'
      active: SessionRunnerOwner
    }

export type SessionRunnerLease = SessionRunnerOwner & {
  /**
   * 释放 ownership；只有创建本 lease 的 token 可以释放。
   * 首次成功返回 true，重复或 stale release 返回 false。
   */
  release(): boolean
}

export type SessionRunnerAcquireResult =
  | {
      ok: true
      lease: SessionRunnerLease
    }
  | {
      ok: false
      code: typeof SESSION_RUNNER_BUSY_CODE
      active: SessionRunnerOwner
    }

type ActiveRunner = SessionRunnerOwner & {
  token: symbol
}

function normalizeSessionId(raw: string): string {
  const sessionId = raw.trim()
  if (!sessionId) throw new Error('sessionId is empty')
  if (sessionId.length > 256) throw new Error('sessionId is too long')
  if (/[\r\n\0]/.test(sessionId)) {
    throw new Error('sessionId contains invalid control characters')
  }
  return sessionId
}

function publicOwner(active: ActiveRunner): SessionRunnerOwner {
  return {
    sessionId: active.sessionId,
    turnId: active.turnId,
    acquiredAt: active.acquiredAt,
    ...(active.querySource ? { querySource: active.querySource } : {}),
  }
}

/**
 * DR2A：进程内 session runner ownership。
 *
 * - 按 sessionId 分槽，同 session 最多一个 active runner。
 * - tryAcquire 在第一个 await 前同步完成，不存在 check-then-act 窗口。
 * - 不同 SessionCoordinator 实例是不同 runtime domain；产品默认使用进程级实例。
 * - queue/steer/interrupt 在 DR2B 通过 safe-boundary control 扩展。
 */
export class SessionCoordinator {
  readonly #active = new Map<string, ActiveRunner>()

  tryAcquire(input: {
    sessionId: string
    turnId: string
    querySource?: string
    acquiredAt?: string
  }): SessionRunnerAcquireResult {
    const sessionId = normalizeSessionId(input.sessionId)
    const turnId = normalizeDurableTurnId(input.turnId)
    const existing = this.#active.get(sessionId)
    if (existing) {
      return {
        ok: false,
        code: SESSION_RUNNER_BUSY_CODE,
        active: publicOwner(existing),
      }
    }

    const token = Symbol(`session-runner:${sessionId}:${turnId}`)
    const active: ActiveRunner = {
      sessionId,
      turnId,
      acquiredAt: input.acquiredAt ?? nowIso(),
      ...(input.querySource?.trim()
        ? { querySource: input.querySource.trim() }
        : {}),
      token,
    }
    this.#active.set(sessionId, active)

    let released = false
    const lease: SessionRunnerLease = {
      ...publicOwner(active),
      release: () => {
        if (released) return false
        released = true
        const current = this.#active.get(sessionId)
        if (!current || current.token !== token) return false
        this.#active.delete(sessionId)
        return true
      },
    }
    return { ok: true, lease }
  }

  snapshot(rawSessionId: string): SessionRunnerSnapshot {
    const sessionId = normalizeSessionId(rawSessionId)
    const active = this.#active.get(sessionId)
    if (!active) return { sessionId, state: 'idle' }
    return {
      sessionId,
      state: 'running',
      active: publicOwner(active),
    }
  }
}

/**
 * 默认 runtime domain：同一进程中指向相同 sessionId 的对象共享 ownership。
 * 测试/嵌入方可以显式注入独立 coordinator。
 */
export const defaultSessionCoordinator = new SessionCoordinator()
