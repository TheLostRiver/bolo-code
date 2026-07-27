/**
 * Active session ownership and replacement.
 *
 * Frontends may expose several persisted sessions while hosting only one live
 * session object. This manager keeps create/resume/recreate/close operations in
 * one queue so two UI actions cannot publish competing active sessions.
 */

export type ActiveSessionHandle = {
  id: string
  phase: string
}

export type SessionDisposeReason =
  | 'replace'
  | 'shutdown'
  | 'candidate_rejected'

export type SessionSelectionFailureCode =
  | 'invalid_request'
  | 'active_session_busy'
  | 'load_failed'
  | 'session_id_mismatch'
  | 'activation_failed'

export type SessionSelectionSuccess<T extends ActiveSessionHandle> = {
  ok: true
  status: 'created' | 'selected' | 'unchanged'
  session: T
  sessionId: string
  scope: string
  previousSessionId?: string
}

export type SessionSelectionFailure = {
  ok: false
  code: SessionSelectionFailureCode
  detail: string
  activeSessionId?: string
}

export type SessionSelectionResult<T extends ActiveSessionHandle> =
  | SessionSelectionSuccess<T>
  | SessionSelectionFailure

export type ActiveSessionManagerDeps<T extends ActiveSessionHandle> = {
  create: (scope: string) => Promise<T>
  resume: (sessionId: string, scope: string) => Promise<T>
  dispose: (session: T, reason: SessionDisposeReason) => Promise<void>
  /**
   * Cancel process-level pending UI interactions before the old owner is
   * disposed. It is intentionally not called when target loading fails.
   */
  beforeReplace?: (session: T) => void | Promise<void>
  nextScope?: () => string
}

export type ActiveSessionManager<T extends ActiveSessionHandle> = {
  current: () => T | null
  currentScope: () => string | null
  isCurrent: (session: T, scope?: string) => boolean
  ensure: () => Promise<T>
  recreate: () => Promise<SessionSelectionResult<T>>
  select: (request: unknown) => Promise<SessionSelectionResult<T>>
  close: () => Promise<void>
}

const REPLACEABLE_PHASES = new Set(['idle', 'ready', 'ended'])

export function canReplaceActiveSession(
  session: ActiveSessionHandle,
): boolean {
  return REPLACEABLE_PHASES.has(session.phase)
}

function requestedSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const id = (value as { sessionId?: unknown }).sessionId
  if (typeof id !== 'string') return undefined
  const normalized = id.trim()
  return normalized || undefined
}

/**
 * Prefix a renderer-facing request id with its live session instance.
 *
 * Length prefixes make the mapping unambiguous even if either component
 * contains `:`. A resumed copy of the same persisted session receives a new
 * scope, so a late response from its previous instance cannot match.
 */
export function scopeSessionRequestId(scope: string, requestId: string): string {
  const normalizedScope = scope.trim()
  if (!normalizedScope) throw new Error('session request scope is required')
  const normalizedRequestId = requestId || 'anonymous'
  return `${normalizedScope.length}:${normalizedScope}:${normalizedRequestId.length}:${normalizedRequestId}`
}

export function createActiveSessionManager<T extends ActiveSessionHandle>(
  deps: ActiveSessionManagerDeps<T>,
): ActiveSessionManager<T> {
  let active: T | null = null
  let activeScope: string | null = null
  let scopeSequence = 0
  let operationTail: Promise<void> = Promise.resolve()

  const nextScope =
    deps.nextScope ?? (() => `session_scope_${++scopeSequence}`)

  function serialize<R>(operation: () => Promise<R>): Promise<R> {
    const run = operationTail.then(operation, operation)
    operationTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function discardCandidate(candidate: T): Promise<void> {
    try {
      await deps.dispose(candidate, 'candidate_rejected')
    } catch {
      // Preserve the primary selection failure. Candidate cleanup is best effort.
    }
  }

  function failure(
    code: SessionSelectionFailureCode,
    detail: string,
  ): SessionSelectionFailure {
    return {
      ok: false,
      code,
      detail,
      ...(active ? { activeSessionId: active.id } : {}),
    }
  }

  async function publishCandidate(
    candidate: T,
    scope: string,
    status: 'created' | 'selected',
    expectedSessionId?: string,
  ): Promise<SessionSelectionResult<T>> {
    if (!candidate?.id?.trim()) {
      await discardCandidate(candidate)
      return failure('load_failed', 'loaded session has no id')
    }
    if (expectedSessionId && candidate.id !== expectedSessionId) {
      await discardCandidate(candidate)
      return failure(
        'session_id_mismatch',
        `requested session "${expectedSessionId}" but loaded "${candidate.id}"`,
      )
    }

    const previous = active
    try {
      if (previous) {
        await deps.beforeReplace?.(previous)
        await deps.dispose(previous, 'replace')
      }
    } catch (error) {
      await discardCandidate(candidate)
      const detail = error instanceof Error ? error.message : String(error)
      return failure(
        'activation_failed',
        `could not close active session: ${detail}`,
      )
    }

    active = candidate
    activeScope = scope
    return {
      ok: true,
      status,
      session: candidate,
      sessionId: candidate.id,
      scope,
      ...(previous ? { previousSessionId: previous.id } : {}),
    }
  }

  async function createCandidate(): Promise<SessionSelectionResult<T>> {
    const scope = nextScope()
    let candidate: T
    try {
      candidate = await deps.create(scope)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return failure('load_failed', `could not create session: ${detail}`)
    }
    return publishCandidate(candidate, scope, 'created')
  }

  return {
    current: () => active,
    currentScope: () => activeScope,
    isCurrent: (session, scope) =>
      active === session && (scope === undefined || activeScope === scope),

    ensure: () =>
      serialize(async () => {
        if (active) return active
        const created = await createCandidate()
        if (!created.ok) throw new Error(created.detail)
        return created.session
      }),

    recreate: () =>
      serialize(async () => {
        if (active && !canReplaceActiveSession(active)) {
          return failure(
            'active_session_busy',
            `session "${active.id}" is ${active.phase}; finish or interrupt it before replacing it`,
          )
        }
        return createCandidate()
      }),

    select: (request) =>
      serialize(async () => {
        const sessionId = requestedSessionId(request)
        if (!sessionId) {
          return failure(
            'invalid_request',
            'sessionId must be a non-empty string',
          )
        }
        if (active?.id === sessionId) {
          return {
            ok: true,
            status: 'unchanged',
            session: active,
            sessionId: active.id,
            scope: activeScope ?? '',
          }
        }
        if (active && !canReplaceActiveSession(active)) {
          return failure(
            'active_session_busy',
            `session "${active.id}" is ${active.phase}; finish or interrupt it before switching`,
          )
        }

        const scope = nextScope()
        let candidate: T
        try {
          candidate = await deps.resume(sessionId, scope)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return failure(
            'load_failed',
            `could not resume session "${sessionId}": ${detail}`,
          )
        }
        return publishCandidate(candidate, scope, 'selected', sessionId)
      }),

    close: () =>
      serialize(async () => {
        if (!active) return
        const closing = active
        await deps.beforeReplace?.(closing)
        await deps.dispose(closing, 'shutdown')
        if (active === closing) {
          active = null
          activeScope = null
        }
      }),
  }
}
