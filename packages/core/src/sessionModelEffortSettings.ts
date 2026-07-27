import { getProviderPreset } from '../../config/src/providerPresets.ts'
import {
  assertEffortChoosable,
  detectEffortDialectId,
  listEffortChoosable,
  resolveEffortDialect,
  type EffortDialect,
} from '../../providers/src/index.ts'
import {
  maybeAutoSaveSession,
  type PersistableSession,
} from './sessionPersist.ts'
import {
  switchSessionModel,
  type SwitchableProviderSession,
} from './sessionProvider.ts'

const MAX_MODEL_NAME_CHARS = 256

export type SessionModelEffortSession = PersistableSession &
  SwitchableProviderSession

type SessionModelEffortView = {
  model?: string
  providerId?: string
  provider?: { id?: string }
  providerProfile?: {
    model?: string
    baseUrl?: string
    effortDialect?: string | Record<string, unknown>
  }
  effortDialect?: string | Record<string, unknown>
  effortLevel?: string
}

export type SessionModelEffortSettings = {
  model: string
  modelSuggestions: string[]
  effortLevel: string
  dialectId: string | null
  choosable: string[]
}

export type SessionModelEffortUpdate = {
  model?: string
  effort?: string
}

export type SessionModelEffortUpdateResult =
  | {
      ok: true
      persisted: boolean
      settings: SessionModelEffortSettings
    }
  | {
      ok: false
      code:
        | 'invalid_settings'
        | 'invalid_model'
        | 'invalid_effort'
        | 'settings_persistence_failed'
      reason: string
      settings: SessionModelEffortSettings
    }

type EffortDialectInput = string | EffortDialect | null | undefined

function effortDialectForSession(
  session: SessionModelEffortView,
): EffortDialectInput {
  return (
    session.effortDialect ??
    session.providerProfile?.effortDialect ??
    detectEffortDialectId({
      kind: session.provider?.id,
      baseUrl: session.providerProfile?.baseUrl,
      model: session.model ?? session.providerProfile?.model,
    })
  ) as EffortDialectInput
}

export function suggestModelsForSession(
  session: SessionModelEffortView,
): string[] {
  const models: string[] = []
  const seen = new Set<string>()
  const add = (model?: string) => {
    const value = model?.trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    models.push(value)
  }

  add(session.model)
  add(session.providerProfile?.model)
  const providerId = session.providerId?.trim()
  if (providerId) {
    for (const model of getProviderPreset(providerId)?.models ?? []) add(model)
  }

  const kind = session.provider?.id
  if (kind === 'anthropic') {
    for (const model of getProviderPreset('anthropic')?.models ?? []) add(model)
  } else if (kind === 'openai-responses') {
    for (const model of getProviderPreset('openai-responses')?.models ?? []) {
      add(model)
    }
  } else if (kind === 'openai-compatible') {
    const baseUrl = (session.providerProfile?.baseUrl ?? '').toLowerCase()
    const presetId = baseUrl.includes('deepseek')
      ? 'deepseek'
      : baseUrl.includes('siliconflow')
        ? 'siliconflow'
        : 'openai'
    for (const model of getProviderPreset(presetId)?.models ?? []) add(model)
  }

  return models.slice(0, 8)
}

export function getSessionModelEffortSettings(
  session: SessionModelEffortView,
): SessionModelEffortSettings {
  const model = session.model?.trim() || session.providerProfile?.model?.trim() || ''
  try {
    const dialect = effortDialectForSession(session)
    const resolved = resolveEffortDialect(dialect)
    return {
      model,
      modelSuggestions: suggestModelsForSession(session),
      effortLevel: session.effortLevel?.trim() || 'auto',
      dialectId: resolved.id ?? null,
      choosable: listEffortChoosable(dialect, {
        isAgent: true,
        model,
      }),
    }
  } catch {
    return {
      model,
      modelSuggestions: suggestModelsForSession(session),
      effortLevel: session.effortLevel?.trim() || 'auto',
      dialectId: null,
      choosable: [],
    }
  }
}

function validatedModel(
  value: unknown,
): { ok: true; model: string } | { ok: false; reason: string } {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'model must be a string' }
  }
  const model = value.trim()
  if (!model) return { ok: false, reason: 'model name required' }
  if (model.length > MAX_MODEL_NAME_CHARS) {
    return {
      ok: false,
      reason: `model name exceeds ${MAX_MODEL_NAME_CHARS} characters`,
    }
  }
  for (let i = 0; i < model.length; i++) {
    const code = model.charCodeAt(i)
    if (code <= 31 || (code >= 127 && code <= 159)) {
      return { ok: false, reason: 'model name contains control characters' }
    }
  }
  return { ok: true, model }
}

function restorePromptCacheState(
  session: SessionModelEffortSession,
  original: SessionModelEffortSession['promptCacheState'],
  snapshot: SessionModelEffortSession['promptCacheState'],
) {
  if (!original || !snapshot) {
    session.promptCacheState = original
    return
  }
  const target = original as Record<string, unknown>
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, snapshot)
  session.promptCacheState = original
}

export async function updateSessionModelEffort(
  session: SessionModelEffortSession,
  input: unknown,
): Promise<SessionModelEffortUpdateResult> {
  const currentSettings = () => getSessionModelEffortSettings(session)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      code: 'invalid_settings',
      reason: 'settings patch must be an object',
      settings: currentSettings(),
    }
  }

  const patch = input as Record<string, unknown>
  const hasModel = Object.prototype.hasOwnProperty.call(patch, 'model')
  const hasEffort = Object.prototype.hasOwnProperty.call(patch, 'effort')
  if (!hasModel && !hasEffort) {
    return {
      ok: false,
      code: 'invalid_settings',
      reason: 'settings patch requires model or effort',
      settings: currentSettings(),
    }
  }

  let nextModel = session.model?.trim() || session.providerProfile?.model?.trim() || ''
  if (hasModel) {
    const checked = validatedModel(patch.model)
    if (!checked.ok) {
      return {
        ok: false,
        code: 'invalid_model',
        reason: checked.reason,
        settings: currentSettings(),
      }
    }
    nextModel = checked.model
  }

  let nextEffort: string | undefined
  if (hasEffort) {
    if (typeof patch.effort !== 'string') {
      return {
        ok: false,
        code: 'invalid_effort',
        reason: 'effort must be a string',
        settings: currentSettings(),
      }
    }
    const rawEffort = patch.effort.trim().toLowerCase()
    if (!rawEffort) {
      return {
        ok: false,
        code: 'invalid_effort',
        reason: 'effort is required',
        settings: currentSettings(),
      }
    }
    try {
      const check = assertEffortChoosable(
        effortDialectForSession(session),
        rawEffort,
        {
          isAgent: true,
          model: nextModel,
        },
      )
      if (!check.ok) {
        return {
          ok: false,
          code: 'invalid_effort',
          reason: check.reason,
          settings: currentSettings(),
        }
      }
      nextEffort = check.intent === 'auto' ? undefined : check.intent
    } catch (error) {
      return {
        ok: false,
        code: 'invalid_effort',
        reason: error instanceof Error ? error.message : String(error),
        settings: currentSettings(),
      }
    }
  }

  const previousModel = session.model
  const previousEffort = session.effortLevel
  const previousClassifier = session.classifyPermission
  const previousPromptCacheState = session.promptCacheState
  const previousPromptCacheSnapshot = previousPromptCacheState
    ? {
        ...previousPromptCacheState,
        ...(previousPromptCacheState.lastToolNames
          ? { lastToolNames: [...previousPromptCacheState.lastToolNames] }
          : {}),
      }
    : undefined

  if (hasModel) {
    const switched = switchSessionModel(session, nextModel)
    if (!switched.ok) {
      return {
        ok: false,
        code: 'invalid_model',
        reason: switched.reason,
        settings: currentSettings(),
      }
    }
  }
  if (hasEffort) session.effortLevel = nextEffort

  try {
    const persisted = await maybeAutoSaveSession(session, {
      throwOnError: true,
    })
    return {
      ok: true,
      persisted,
      settings: currentSettings(),
    }
  } catch (error) {
    session.model = previousModel
    session.effortLevel = previousEffort
    session.classifyPermission = previousClassifier
    restorePromptCacheState(
      session,
      previousPromptCacheState,
      previousPromptCacheSnapshot,
    )
    return {
      ok: false,
      code: 'settings_persistence_failed',
      reason: error instanceof Error ? error.message : String(error),
      settings: currentSettings(),
    }
  }
}
