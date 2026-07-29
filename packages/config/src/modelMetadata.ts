/**
 * CTX-1: provider/model limits validation and pure resolution.
 *
 * This module owns config semantics only. Session/runtime consumers are wired
 * in CTX-2 and must consume the resolved result instead of re-reading JSON.
 */

import type {
  ModelLimitsConfigJson,
  ProviderConfigJson,
} from './types.ts'

export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 128_000
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 8_192

export type ModelMetadataSource =
  | 'model'
  | 'provider'
  | 'catalog'
  | 'legacy'
  | 'snapshot'
  | 'fallback'

export type ResolvedModelMetadata = {
  providerId: string
  model?: string
  contextWindowTokens: number
  maxOutputTokens: number
  sources: {
    contextWindow: ModelMetadataSource
    maxOutput: ModelMetadataSource
  }
  usedFallback: boolean
  warnings: string[]
}

export type ModelMetadataCatalogEntry = {
  model: string
  contextWindowTokens: number
  maxOutputTokens: number
  providerKinds?: readonly string[]
}

/**
 * Deliberately small exact-model catalog. Unknown/proxy models must use
 * explicit provider/model config or an honest legacy/fallback source.
 */
export const BUILTIN_MODEL_METADATA: readonly ModelMetadataCatalogEntry[] = [
  {
    model: 'gpt-4o-mini',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    providerKinds: ['openai-compatible', 'openai-responses'],
  },
  {
    model: 'gpt-4o',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    providerKinds: ['openai-compatible', 'openai-responses'],
  },
] as const

export type ProviderModelMetadataProfile = {
  id?: string
  kind?: string
  model?: string
  contextWindowTokens?: number
  maxTokens?: number
  models?: Record<string, ModelLimitsConfigJson>
  modelMetadataWarnings?: readonly string[]
}

export type ResolveModelMetadataOptions = {
  providerId: string
  model?: string
  profile?: ProviderModelMetadataProfile
  legacyContextWindowTokens?: unknown
  /**
   * Supplying a snapshot explicitly opts into resume fallback semantics.
   * Normal create callers omit it.
   */
  snapshot?: ResolvedModelMetadata
  /** Tests/embedders may replace the built-in catalog; [] disables it. */
  catalog?: readonly ModelMetadataCatalogEntry[]
}

export type NormalizedProviderModelMetadata = {
  contextWindowTokens?: number
  maxTokens?: number
  models?: Record<string, ModelLimitsConfigJson>
  warnings: string[]
}

const PROVIDER_KEYS = new Set([
  'kind',
  'label',
  'apiKey',
  'apiKeyEnv',
  'baseUrl',
  'model',
  'timeoutMs',
  'contextWindowTokens',
  'maxTokens',
  'models',
  'effort',
])

const MODEL_LIMIT_KEYS = new Set(['contextWindowTokens', 'maxTokens'])

const LIMIT_ALIASES: Readonly<Record<string, string>> = {
  contextWindow: 'contextWindowTokens',
  context_window: 'contextWindowTokens',
  maxOutputTokens: 'maxTokens',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  )
}

const MODEL_METADATA_SOURCES = new Set<ModelMetadataSource>([
  'model',
  'provider',
  'catalog',
  'legacy',
  'snapshot',
  'fallback',
])

/**
 * Parse persisted resolved metadata without trusting arbitrary transcript JSON.
 */
export function parseResolvedModelMetadata(
  raw: unknown,
): ResolvedModelMetadata | undefined {
  if (!isRecord(raw)) return undefined
  const providerId =
    typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  const model =
    typeof raw.model === 'string' && raw.model.trim()
      ? raw.model.trim()
      : undefined
  const contextWindowTokens = raw.contextWindowTokens
  const maxOutputTokens = raw.maxOutputTokens
  const sources = raw.sources
  if (
    !providerId ||
    !isPositiveInteger(contextWindowTokens) ||
    !isPositiveInteger(maxOutputTokens) ||
    maxOutputTokens > contextWindowTokens ||
    !isRecord(sources) ||
    !MODEL_METADATA_SOURCES.has(
      sources.contextWindow as ModelMetadataSource,
    ) ||
    !MODEL_METADATA_SOURCES.has(sources.maxOutput as ModelMetadataSource)
  ) {
    return undefined
  }
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter(
        (warning): warning is string => typeof warning === 'string',
      )
    : []
  const contextSource = sources.contextWindow as ModelMetadataSource
  const outputSource = sources.maxOutput as ModelMetadataSource
  return {
    providerId,
    ...(model ? { model } : {}),
    contextWindowTokens,
    maxOutputTokens,
    sources: {
      contextWindow: contextSource,
      maxOutput: outputSource,
    },
    usedFallback:
      raw.usedFallback === true ||
      contextSource === 'fallback' ||
      outputSource === 'fallback',
    warnings: [...warnings],
  }
}

function pushUnique(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning)
}

function collectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  warnings: string[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue
    const replacement = LIMIT_ALIASES[key]
    if (replacement) {
      pushUnique(
        warnings,
        `${path}.${key} is not supported; use ${replacement} instead`,
      )
      continue
    }
    pushUnique(
      warnings,
      `${path}.${key} is unknown and will be ignored`,
    )
  }
}

function collectLimitWarnings(
  value: Record<string, unknown>,
  path: string,
  warnings: string[],
): void {
  for (const key of ['contextWindowTokens', 'maxTokens'] as const) {
    if (!(key in value) || value[key] === undefined) continue
    if (!isPositiveInteger(value[key])) {
      pushUnique(
        warnings,
        `${path}.${key} must be a finite positive integer; value ignored`,
      )
    }
  }

  const context = value.contextWindowTokens
  const output = value.maxTokens
  if (
    isPositiveInteger(context) &&
    isPositiveInteger(output) &&
    output > context
  ) {
    pushUnique(
      warnings,
      `${path}.maxTokens ${output} exceeds contextWindowTokens ${context}; value ignored`,
    )
  }
}

function collectProviderWarnings(
  value: unknown,
  path: string,
  warnings: string[],
): void {
  if (!isRecord(value)) {
    pushUnique(warnings, `${path} must be an object; value ignored`)
    return
  }

  collectUnknownKeys(value, PROVIDER_KEYS, path, warnings)
  collectLimitWarnings(value, path, warnings)

  if (!('models' in value) || value.models === undefined) return
  if (!isRecord(value.models)) {
    pushUnique(warnings, `${path}.models must be an object; value ignored`)
    return
  }

  for (const [rawId, entry] of Object.entries(value.models)) {
    const id = rawId.trim()
    if (!id) {
      pushUnique(
        warnings,
        `${path}.models has an empty model id; entry ignored`,
      )
      continue
    }
    const entryPath = `${path}.models.${id}`
    if (!isRecord(entry)) {
      pushUnique(warnings, `${entryPath} must be an object; entry ignored`)
      continue
    }
    collectUnknownKeys(entry, MODEL_LIMIT_KEYS, entryPath, warnings)
    collectLimitWarnings(entry, entryPath, warnings)
  }
}

/**
 * Validate only CTX-owned fields. Other config sections keep their existing
 * validators and are intentionally not treated as unknown here.
 */
export function validateBoloConfigModelMetadata(
  raw: unknown,
  sourceLabel = 'config',
): string[] {
  if (!isRecord(raw)) return []
  const local: string[] = []

  if (
    'contextWindowTokens' in raw &&
    raw.contextWindowTokens !== undefined &&
    !isPositiveInteger(raw.contextWindowTokens)
  ) {
    pushUnique(
      local,
      `contextWindowTokens must be a finite positive integer; value ignored`,
    )
  }

  if ('provider' in raw && raw.provider !== undefined) {
    collectProviderWarnings(raw.provider, 'provider', local)
  }

  if ('providers' in raw && raw.providers !== undefined) {
    if (!isRecord(raw.providers)) {
      pushUnique(local, 'providers must be an object; value ignored')
    } else {
      for (const [rawId, provider] of Object.entries(raw.providers)) {
        const id = rawId.trim()
        if (!id) {
          pushUnique(local, 'providers has an empty provider id; entry ignored')
          continue
        }
        collectProviderWarnings(provider, `providers.${id}`, local)
      }
    }
  }

  const prefix = sourceLabel.trim()
  return prefix ? local.map((warning) => `${prefix}: ${warning}`) : local
}

function normalizedLimit(
  value: unknown,
): number | undefined {
  return isPositiveInteger(value) ? value : undefined
}

/**
 * Convert one provider JSON object to safe limits while retaining warnings.
 */
export function normalizeProviderModelMetadata(
  raw?: ProviderConfigJson,
  sourcePath = 'provider',
): NormalizedProviderModelMetadata {
  const value = isRecord(raw) ? raw : {}
  const warnings: string[] = []
  collectProviderWarnings(value, sourcePath, warnings)

  const contextWindowTokens = normalizedLimit(value.contextWindowTokens)
  let maxTokens = normalizedLimit(value.maxTokens)
  if (
    contextWindowTokens !== undefined &&
    maxTokens !== undefined &&
    maxTokens > contextWindowTokens
  ) {
    maxTokens = undefined
  }

  let models: Record<string, ModelLimitsConfigJson> | undefined
  if (isRecord(value.models)) {
    const normalized: Record<string, ModelLimitsConfigJson> = {}
    for (const [rawId, rawEntry] of Object.entries(value.models)) {
      const id = rawId.trim()
      if (!id || !isRecord(rawEntry)) continue

      const context = normalizedLimit(rawEntry.contextWindowTokens)
      let output = normalizedLimit(rawEntry.maxTokens)
      if (context !== undefined && output !== undefined && output > context) {
        output = undefined
      }
      if (context === undefined && output === undefined) continue

      normalized[id] = {
        ...(context !== undefined ? { contextWindowTokens: context } : {}),
        ...(output !== undefined ? { maxTokens: output } : {}),
      }
    }
    if (Object.keys(normalized).length) models = normalized
  }

  return {
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(models ? { models } : {}),
    warnings,
  }
}

function normalizedModelId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sameModelId(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
}

function findExactModelLimits(
  profile: ProviderModelMetadataProfile | undefined,
  model: string | undefined,
): ModelLimitsConfigJson | undefined {
  if (!profile?.models || !model) return undefined
  if (profile.models[model]) return profile.models[model]
  const lower = model.toLowerCase()
  const key = Object.keys(profile.models).find(
    (candidate) => candidate.toLowerCase() === lower,
  )
  return key ? profile.models[key] : undefined
}

function findCatalogEntry(
  catalog: readonly ModelMetadataCatalogEntry[],
  model: string | undefined,
  providerKind: string | undefined,
): ModelMetadataCatalogEntry | undefined {
  if (!model) return undefined
  const lowerModel = model.toLowerCase()
  const lowerKind = providerKind?.toLowerCase()
  return catalog.find((entry) => {
    if (entry.model.toLowerCase() !== lowerModel) return false
    if (!entry.providerKinds?.length || !lowerKind) return true
    return entry.providerKinds.some((kind) => kind.toLowerCase() === lowerKind)
  })
}

type Candidate = {
  value: unknown
  source: ModelMetadataSource
  label: string
}

function pickContext(
  candidates: readonly Candidate[],
  warnings: string[],
): { value: number; source: ModelMetadataSource } {
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue
    if (!isPositiveInteger(candidate.value)) {
      pushUnique(
        warnings,
        `${candidate.label} must be a finite positive integer; candidate ignored`,
      )
      continue
    }
    return { value: candidate.value, source: candidate.source }
  }
  return {
    value: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    source: 'fallback',
  }
}

function pickOutput(
  candidates: readonly Candidate[],
  contextWindowTokens: number,
  warnings: string[],
): { value: number; source: ModelMetadataSource } {
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue
    if (!isPositiveInteger(candidate.value)) {
      pushUnique(
        warnings,
        `${candidate.label} must be a finite positive integer; candidate ignored`,
      )
      continue
    }
    if (candidate.value > contextWindowTokens) {
      pushUnique(
        warnings,
        `${candidate.label} ${candidate.value} exceeds resolved context window ${contextWindowTokens}; candidate ignored`,
      )
      continue
    }
    return { value: candidate.value, source: candidate.source }
  }

  const fallback = Math.min(
    DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    contextWindowTokens,
  )
  if (fallback < DEFAULT_MODEL_MAX_OUTPUT_TOKENS) {
    pushUnique(
      warnings,
      `max output fallback clamped to context window ${contextWindowTokens}`,
    )
  }
  return { value: fallback, source: 'fallback' }
}

export function resolveModelMetadata(
  options: ResolveModelMetadataOptions,
): ResolvedModelMetadata {
  const providerId = options.providerId.trim() || 'default'
  const profile = options.profile
  const model =
    normalizedModelId(options.model) ?? normalizedModelId(profile?.model)
  const exact = findExactModelLimits(profile, model)
  const catalog = options.catalog ?? BUILTIN_MODEL_METADATA
  const catalogEntry = findCatalogEntry(catalog, model, profile?.kind)
  const snapshotMatches =
    options.snapshot?.providerId === providerId &&
    sameModelId(options.snapshot.model, model)
  const snapshot = snapshotMatches ? options.snapshot : undefined
  const warnings = [...(profile?.modelMetadataWarnings ?? [])]

  const context = pickContext(
    [
      {
        value: exact?.contextWindowTokens,
        source: 'model',
        label: `model ${model ?? '(unset)'} contextWindowTokens`,
      },
      {
        value: profile?.contextWindowTokens,
        source: 'provider',
        label: `provider ${providerId} contextWindowTokens`,
      },
      {
        value: catalogEntry?.contextWindowTokens,
        source: 'catalog',
        label: `catalog ${model ?? '(unset)'} contextWindowTokens`,
      },
      {
        value: options.legacyContextWindowTokens,
        source: 'legacy',
        label: 'legacy contextWindowTokens',
      },
      {
        value: snapshot?.contextWindowTokens,
        source: 'snapshot',
        label: 'snapshot contextWindowTokens',
      },
    ],
    warnings,
  )

  const output = pickOutput(
    [
      {
        value: exact?.maxTokens,
        source: 'model',
        label: `model ${model ?? '(unset)'} maxTokens`,
      },
      {
        value: profile?.maxTokens,
        source: 'provider',
        label: `provider ${providerId} maxTokens`,
      },
      {
        value: catalogEntry?.maxOutputTokens,
        source: 'catalog',
        label: `catalog ${model ?? '(unset)'} maxTokens`,
      },
      {
        value: snapshot?.maxOutputTokens,
        source: 'snapshot',
        label: 'snapshot maxTokens',
      },
    ],
    context.value,
    warnings,
  )

  const hasProviderMetadata =
    isPositiveInteger(profile?.contextWindowTokens) ||
    isPositiveInteger(profile?.maxTokens)
  if (
    model &&
    !exact &&
    !catalogEntry &&
    !hasProviderMetadata &&
    !snapshot
  ) {
    pushUnique(
      warnings,
      `unknown model metadata for "${model}"; using legacy/fallback limits`,
    )
  }
  if (context.source === 'fallback') {
    pushUnique(
      warnings,
      `context window metadata missing; using ${context.value} fallback`,
    )
  }
  if (output.source === 'fallback') {
    pushUnique(
      warnings,
      `max output metadata missing; using ${output.value} fallback`,
    )
  }

  return {
    providerId,
    ...(model ? { model } : {}),
    contextWindowTokens: context.value,
    maxOutputTokens: output.value,
    sources: {
      contextWindow: context.source,
      maxOutput: output.source,
    },
    usedFallback:
      context.source === 'fallback' || output.source === 'fallback',
    warnings: [...new Set(warnings)],
  }
}
