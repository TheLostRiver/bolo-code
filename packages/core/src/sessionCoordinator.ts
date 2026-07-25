import { nowIso } from '../../shared/src/index.ts'
import { normalizeDurableTurnId } from './durableTurn.ts'

export const SESSION_RUNNER_BUSY_CODE = 'session_runner_busy' as const
export const SESSION_CONTROL_KINDS = [
  'queue',
  'steer',
  'interrupt',
] as const
export const SESSION_SAFE_BOUNDARIES = [
  'before_provider',
  'after_provider',
  'before_tools',
  'after_tools',
  'after_permission',
  'after_diff_approval',
  'after_compact',
  'before_stop',
  'turn_terminal',
] as const

export type SessionControlKind = (typeof SESSION_CONTROL_KINDS)[number]
export type SessionSafeBoundary = (typeof SESSION_SAFE_BOUNDARIES)[number]
export type SessionControlState =
  | 'pending'
  | 'ready'
  | 'promoted'
  | 'cancelled'

export type SessionControlRecord = {
  controlId: string
  kind: SessionControlKind
  sessionId: string
  state: SessionControlState
  requestedAt: string
  updatedAt: string
  expectedTurnId?: string
  /** queue 的新 turn id。 */
  turnId?: string
  prompt?: string
  querySource?: string
  boundary?: SessionSafeBoundary | 'between_turns' | 'interrupt_signal'
}

export type SessionControlRequest =
  | {
      controlId: string
      kind: 'queue'
      sessionId: string
      expectedTurnId?: string
      turnId: string
      prompt: string
      querySource?: string
      requestedAt?: string
    }
  | {
      controlId: string
      kind: 'steer'
      sessionId: string
      expectedTurnId?: string
      prompt: string
      requestedAt?: string
    }
  | {
      controlId: string
      kind: 'interrupt'
      sessionId: string
      expectedTurnId?: string
      requestedAt?: string
    }

export type SessionControlRejectCode =
  | 'invalid_control'
  | 'no_active_turn'
  | 'expected_turn_required'
  | 'active_turn_mismatch'
  | 'control_id_conflict'
  | 'control_not_found'
  | 'control_not_cancellable'

export type SessionControlRequestResult =
  | {
      ok: true
      control: SessionControlRecord
      duplicate?: boolean
      activeTurnId?: string
    }
  | {
      ok: false
      code: SessionControlRejectCode
      detail: string
      activeTurnId?: string
    }

export type SessionControlPromotionResult =
  | {
      ok: true
      boundary: SessionSafeBoundary
      controls: SessionControlRecord[]
    }
  | {
      ok: false
      code: 'no_active_turn' | 'active_turn_mismatch'
      detail: string
      activeTurnId?: string
    }

export type SessionControlCancelResult =
  | {
      ok: true
      control: SessionControlRecord
    }
  | {
      ok: false
      code:
        | 'invalid_control'
        | 'control_not_found'
        | 'control_not_cancellable'
      detail: string
    }

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
      controls: SessionControlRecord[]
    }
  | {
      sessionId: string
      state: 'running'
      active: SessionRunnerOwner
      controls: SessionControlRecord[]
    }

export type SessionRunnerLease = SessionRunnerOwner & {
  /** coordinator interrupt control 的 runner-local signal。 */
  signal: AbortSignal
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
  controller: AbortController
}

type CanonicalControl = Omit<
  SessionControlRecord,
  'state' | 'requestedAt' | 'updatedAt' | 'boundary'
>

type InternalControl = SessionControlRecord & {
  fingerprint: string
}

const MAX_SESSION_CONTROL_PROMPT_CHARS = 100_000

const STEER_PROMOTION_BOUNDARIES = new Set<SessionSafeBoundary>([
  'before_provider',
  'after_tools',
  'after_compact',
  'before_stop',
])

function normalizeSessionId(raw: string): string {
  const sessionId = raw.trim()
  if (!sessionId) throw new Error('sessionId is empty')
  if (sessionId.length > 256) throw new Error('sessionId is too long')
  if (/[\r\n\0]/.test(sessionId)) {
    throw new Error('sessionId contains invalid control characters')
  }
  return sessionId
}

function normalizeControlId(raw: string): string {
  const controlId = raw.trim()
  if (!controlId) throw new Error('controlId is empty')
  if (controlId.length > 256) throw new Error('controlId is too long')
  if (/[\r\n\0]/.test(controlId)) {
    throw new Error('controlId contains invalid control characters')
  }
  return controlId
}

function normalizeControlPrompt(raw: string): string {
  const prompt = raw.trim()
  if (!prompt) throw new Error('control prompt is empty')
  if (prompt.length > MAX_SESSION_CONTROL_PROMPT_CHARS) {
    throw new Error(
      `control prompt exceeds ${MAX_SESSION_CONTROL_PROMPT_CHARS} characters`,
    )
  }
  if (prompt.includes('\0')) {
    throw new Error('control prompt contains invalid null character')
  }
  return prompt
}

function publicOwner(active: ActiveRunner): SessionRunnerOwner {
  return {
    sessionId: active.sessionId,
    turnId: active.turnId,
    acquiredAt: active.acquiredAt,
    ...(active.querySource ? { querySource: active.querySource } : {}),
  }
}

function publicControl(control: InternalControl): SessionControlRecord {
  return {
    controlId: control.controlId,
    kind: control.kind,
    sessionId: control.sessionId,
    state: control.state,
    requestedAt: control.requestedAt,
    updatedAt: control.updatedAt,
    ...(control.expectedTurnId
      ? { expectedTurnId: control.expectedTurnId }
      : {}),
    ...(control.turnId ? { turnId: control.turnId } : {}),
    ...(control.prompt !== undefined ? { prompt: control.prompt } : {}),
    ...(control.querySource ? { querySource: control.querySource } : {}),
    ...(control.boundary ? { boundary: control.boundary } : {}),
  }
}

function controlFingerprint(control: CanonicalControl): string {
  return JSON.stringify(control)
}

function canonicalControl(input: SessionControlRequest): CanonicalControl {
  const controlId = normalizeControlId(input.controlId)
  const sessionId = normalizeSessionId(input.sessionId)
  const expectedTurnId = input.expectedTurnId
    ? normalizeDurableTurnId(input.expectedTurnId)
    : undefined
  if (input.kind === 'interrupt') {
    return {
      controlId,
      kind: input.kind,
      sessionId,
      ...(expectedTurnId ? { expectedTurnId } : {}),
    }
  }
  const prompt = normalizeControlPrompt(input.prompt)
  if (input.kind === 'steer') {
    return {
      controlId,
      kind: input.kind,
      sessionId,
      prompt,
      ...(expectedTurnId ? { expectedTurnId } : {}),
    }
  }
  const turnId = normalizeDurableTurnId(input.turnId)
  return {
    controlId,
    kind: input.kind,
    sessionId,
    turnId,
    prompt,
    ...(expectedTurnId ? { expectedTurnId } : {}),
    ...(input.querySource?.trim()
      ? { querySource: input.querySource.trim() }
      : {}),
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
  readonly #controlsBySession = new Map<string, InternalControl[]>()
  readonly #controlsById = new Map<string, InternalControl>()

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
    const controller = new AbortController()
    const active: ActiveRunner = {
      sessionId,
      turnId,
      acquiredAt: input.acquiredAt ?? nowIso(),
      ...(input.querySource?.trim()
        ? { querySource: input.querySource.trim() }
        : {}),
      token,
      controller,
    }
    this.#active.set(sessionId, active)

    let released = false
    const lease: SessionRunnerLease = {
      ...publicOwner(active),
      signal: controller.signal,
      release: () => {
        if (released) return false
        released = true
        const current = this.#active.get(sessionId)
        if (!current || current.token !== token) return false
        const timestamp = nowIso()
        for (const control of this.#controlsFor(sessionId)) {
          if (
            control.state !== 'pending' ||
            control.expectedTurnId !== current.turnId
          ) {
            continue
          }
          if (control.kind === 'queue') {
            control.state = 'ready'
            control.updatedAt = timestamp
            control.boundary = 'turn_terminal'
          } else if (control.kind === 'steer') {
            control.state = 'cancelled'
            control.updatedAt = timestamp
            control.boundary = 'turn_terminal'
          }
        }
        this.#active.delete(sessionId)
        return true
      },
    }
    return { ok: true, lease }
  }

  requestControl(input: SessionControlRequest): SessionControlRequestResult {
    let canonical: CanonicalControl
    try {
      canonical = canonicalControl(input)
    } catch (error) {
      return {
        ok: false,
        code: 'invalid_control',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    const fingerprint = controlFingerprint(canonical)
    const previous = this.#controlsById.get(canonical.controlId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return {
          ok: false,
          code: 'control_id_conflict',
          detail: `controlId "${canonical.controlId}" already has a different payload`,
        }
      }
      return {
        ok: true,
        control: publicControl(previous),
        duplicate: true,
        ...(this.#active.get(canonical.sessionId)
          ? {
              activeTurnId: this.#active.get(canonical.sessionId)!.turnId,
            }
          : {}),
      }
    }

    const active = this.#active.get(canonical.sessionId)
    if (canonical.kind === 'steer' || canonical.kind === 'interrupt') {
      if (!active) {
        return {
          ok: false,
          code: 'no_active_turn',
          detail: `session "${canonical.sessionId}" has no active turn`,
        }
      }
      if (!canonical.expectedTurnId) {
        return {
          ok: false,
          code: 'expected_turn_required',
          detail: `${canonical.kind} requires expectedTurnId`,
          activeTurnId: active.turnId,
        }
      }
      if (canonical.expectedTurnId !== active.turnId) {
        return {
          ok: false,
          code: 'active_turn_mismatch',
          detail:
            `expected turn "${canonical.expectedTurnId}" but active turn is ` +
            `"${active.turnId}"`,
          activeTurnId: active.turnId,
        }
      }
    } else if (active) {
      if (!canonical.expectedTurnId) {
        return {
          ok: false,
          code: 'expected_turn_required',
          detail: 'queue behind an active turn requires expectedTurnId',
          activeTurnId: active.turnId,
        }
      }
      if (canonical.expectedTurnId !== active.turnId) {
        return {
          ok: false,
          code: 'active_turn_mismatch',
          detail:
            `expected turn "${canonical.expectedTurnId}" but active turn is ` +
            `"${active.turnId}"`,
          activeTurnId: active.turnId,
        }
      }
    } else if (canonical.expectedTurnId) {
      return {
        ok: false,
        code: 'no_active_turn',
        detail:
          `session "${canonical.sessionId}" has no active turn for ` +
          `expectedTurnId "${canonical.expectedTurnId}"`,
      }
    }

    const timestamp = input.requestedAt ?? nowIso()
    const control: InternalControl = {
      ...canonical,
      state:
        canonical.kind === 'interrupt'
          ? 'promoted'
          : canonical.kind === 'queue' && !active
            ? 'ready'
            : 'pending',
      requestedAt: timestamp,
      updatedAt: timestamp,
      ...(canonical.kind === 'interrupt'
        ? { boundary: 'interrupt_signal' as const }
        : {}),
      fingerprint,
    }
    this.#controlsFor(canonical.sessionId).push(control)
    this.#controlsById.set(canonical.controlId, control)
    if (canonical.kind === 'interrupt') {
      active!.controller.abort('session_control_interrupt')
    }
    return {
      ok: true,
      control: publicControl(control),
      ...(active ? { activeTurnId: active.turnId } : {}),
    }
  }

  promoteControls(input: {
    sessionId: string
    turnId: string
    boundary: SessionSafeBoundary
  }): SessionControlPromotionResult {
    const sessionId = normalizeSessionId(input.sessionId)
    const turnId = normalizeDurableTurnId(input.turnId)
    const active = this.#active.get(sessionId)
    if (!active) {
      return {
        ok: false,
        code: 'no_active_turn',
        detail: `session "${sessionId}" has no active turn`,
      }
    }
    if (active.turnId !== turnId) {
      return {
        ok: false,
        code: 'active_turn_mismatch',
        detail: `expected active turn "${turnId}" but found "${active.turnId}"`,
        activeTurnId: active.turnId,
      }
    }
    if (!STEER_PROMOTION_BOUNDARIES.has(input.boundary)) {
      return { ok: true, boundary: input.boundary, controls: [] }
    }
    const timestamp = nowIso()
    const promoted: SessionControlRecord[] = []
    for (const control of this.#controlsFor(sessionId)) {
      if (
        control.kind !== 'steer' ||
        control.state !== 'pending' ||
        control.expectedTurnId !== turnId
      ) {
        continue
      }
      control.state = 'promoted'
      control.updatedAt = timestamp
      control.boundary = input.boundary
      promoted.push(publicControl(control))
    }
    return { ok: true, boundary: input.boundary, controls: promoted }
  }

  cancelControl(input: {
    sessionId: string
    controlId: string
  }): SessionControlCancelResult {
    let sessionId: string
    let controlId: string
    try {
      sessionId = normalizeSessionId(input.sessionId)
      controlId = normalizeControlId(input.controlId)
    } catch (error) {
      return {
        ok: false,
        code: 'invalid_control',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    const control = this.#controlsById.get(controlId)
    if (!control || control.sessionId !== sessionId) {
      return {
        ok: false,
        code: 'control_not_found',
        detail: `controlId "${controlId}" was not found in session "${sessionId}"`,
      }
    }
    if (control.state !== 'pending' && control.state !== 'ready') {
      return {
        ok: false,
        code: 'control_not_cancellable',
        detail: `controlId "${controlId}" is ${control.state}`,
      }
    }
    control.state = 'cancelled'
    control.updatedAt = nowIso()
    return { ok: true, control: publicControl(control) }
  }

  /**
   * 只允许在 session idle 时取得 ready queue；取出即 promotion，绝不重放。
   */
  takeNextQueued(rawSessionId: string): SessionControlRecord | null {
    const sessionId = normalizeSessionId(rawSessionId)
    if (this.#active.has(sessionId)) return null
    const control = this.#controlsFor(sessionId).find(
      (row) => row.kind === 'queue' && row.state === 'ready',
    )
    if (!control) return null
    control.state = 'promoted'
    control.updatedAt = nowIso()
    control.boundary = 'between_turns'
    return publicControl(control)
  }

  snapshot(rawSessionId: string): SessionRunnerSnapshot {
    const sessionId = normalizeSessionId(rawSessionId)
    const active = this.#active.get(sessionId)
    const controls = this.#controlsFor(sessionId).map(publicControl)
    if (!active) return { sessionId, state: 'idle', controls }
    return {
      sessionId,
      state: 'running',
      active: publicOwner(active),
      controls,
    }
  }

  #controlsFor(sessionId: string): InternalControl[] {
    let controls = this.#controlsBySession.get(sessionId)
    if (!controls) {
      controls = []
      this.#controlsBySession.set(sessionId, controls)
    }
    return controls
  }
}

/**
 * 默认 runtime domain：同一进程中指向相同 sessionId 的对象共享 ownership。
 * 测试/嵌入方可以显式注入独立 coordinator。
 */
export const defaultSessionCoordinator = new SessionCoordinator()
