/**
 * CX6：热切 / resume 后统一 effort clamp（降到 auto，不静默脏档）。
 * 见 docs/PROVIDER_UX.md
 */

import {
  assertEffortChoosable,
  detectEffortDialectId,
  listEffortChoosable,
} from '../../providers/src/effortDialect.ts'

export type EffortClampSession = {
  effortLevel?: string
  effortDialect?: string | Record<string, unknown>
  model?: string
  provider?: { id?: string }
  providerProfile?: {
    effortDialect?: string | Record<string, unknown>
    baseUrl?: string
    model?: string
  }
}

export type ClampEffortResult = {
  /** 是否改写了 session.effortLevel */
  changed: boolean
  /** clamp 前 */
  previous?: string
  /** clamp 后；undefined = auto */
  next?: string
  warning?: string
}

function resolveDialect(session: EffortClampSession) {
  return (
    session.effortDialect ??
    session.providerProfile?.effortDialect ??
    detectEffortDialectId({
      kind: session.provider?.id,
      baseUrl: session.providerProfile?.baseUrl,
      model: session.model ?? session.providerProfile?.model,
    })
  )
}

/**
 * 若当前 effort 在 dialect+model 下不可选 → 清为 auto 并返回 warning。
 * 就地修改 session.effortLevel。
 */
export function clampEffortForSession(
  session: EffortClampSession,
): ClampEffortResult {
  const raw = session.effortLevel?.trim()
  if (!raw) {
    return { changed: false, next: undefined }
  }

  const dialect = resolveDialect(session)
  const model = session.model ?? session.providerProfile?.model
  const check = assertEffortChoosable(dialect as string | undefined, raw, {
    isAgent: true,
    model,
  })

  if (check.ok) {
    // 归一 intent（别名）
    if (check.intent !== raw) {
      session.effortLevel = check.intent
      return {
        changed: true,
        previous: raw,
        next: check.intent,
      }
    }
    return { changed: false, previous: raw, next: raw }
  }

  session.effortLevel = undefined
  const choosable = listEffortChoosable(dialect as string | undefined, {
    isAgent: true,
    model,
  })
  const warning =
    `effort "${raw}" not available on this backend → auto` +
    (choosable.length ? ` (choosable: ${choosable.join(', ')})` : '')

  return {
    changed: true,
    previous: raw,
    next: undefined,
    warning,
  }
}