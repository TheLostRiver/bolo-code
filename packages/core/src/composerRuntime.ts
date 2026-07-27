import {
  buildComposerActions,
  composerIntentToControl,
  type ComposerActionOption,
  type ComposerIntentResult,
} from '../../shared/src/composerIntent.ts'
import {
  requestSessionControl,
  type SessionControlRuntimeRequestResult,
  type SessionControlRuntimeSession,
} from './sessionControlRuntime.ts'

export type SessionComposerRuntime = SessionControlRuntimeSession & {
  id: string
}

export type SessionComposerControlResult =
  | Exclude<ComposerIntentResult, { ok: true }>
  | SessionControlRuntimeRequestResult

function composerRunner(session: SessionComposerRuntime) {
  const snapshot = session.coordinator.snapshot(session.id)
  return {
    sessionId: session.id,
    ...(snapshot.state === 'running'
      ? { activeTurnId: snapshot.active.turnId }
      : {}),
  }
}

/**
 * UI-facing composer actions derived from the authoritative runner snapshot.
 * The shell renders these options; it does not infer busy/control semantics.
 */
export function getSessionComposerActions(
  session: SessionComposerRuntime,
  text: string,
): ComposerActionOption[] {
  return buildComposerActions({
    runner: composerRunner(session),
    text,
  })
}

/**
 * Translate a composer action against the current runner and admit it through
 * the durable control path. Snapshot and in-memory admission are synchronous,
 * so a turn cannot be replaced between expected-state capture and request.
 */
export async function requestSessionComposerControl(
  session: SessionComposerRuntime,
  input: { action: unknown; text: unknown },
): Promise<SessionComposerControlResult> {
  const intent = composerIntentToControl({
    runner: composerRunner(session),
    action: input.action,
    text: input.text,
  })
  if (!intent.ok) return intent
  return await requestSessionControl(session, intent.control)
}
