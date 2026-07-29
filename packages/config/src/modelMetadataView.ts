import type {
  ModelMetadataSource,
  ResolvedModelMetadata,
} from './modelMetadata.ts'

export type ModelMetadataLimitView = {
  tokens: number
  displayTokens: string
  source: ModelMetadataSource
  sourceLabel: string
}

export type ModelMetadataView = {
  providerId: string
  model?: string
  context: ModelMetadataLimitView
  maxOutput: ModelMetadataLimitView
  usedFallback: boolean
  status: 'ok' | 'warning'
  warnings: string[]
}

const SOURCE_LABELS: Readonly<Record<ModelMetadataSource, string>> = {
  model: 'model override',
  provider: 'provider default',
  catalog: 'built-in catalog',
  legacy: 'legacy config',
  snapshot: 'session snapshot',
  fallback: 'fallback',
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}m`
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}k`
  }
  return tokens.toLocaleString('en-US')
}

function toLimitView(
  tokens: number,
  source: ModelMetadataSource,
): ModelMetadataLimitView {
  return {
    tokens,
    displayTokens: formatTokenCount(tokens),
    source,
    sourceLabel: SOURCE_LABELS[source],
  }
}

export function toModelMetadataView(
  metadata: ResolvedModelMetadata,
): ModelMetadataView {
  const warnings = [...metadata.warnings]
  return {
    providerId: metadata.providerId,
    ...(metadata.model ? { model: metadata.model } : {}),
    context: toLimitView(
      metadata.contextWindowTokens,
      metadata.sources.contextWindow,
    ),
    maxOutput: toLimitView(
      metadata.maxOutputTokens,
      metadata.sources.maxOutput,
    ),
    usedFallback: metadata.usedFallback,
    status:
      metadata.usedFallback || warnings.length > 0 ? 'warning' : 'ok',
    warnings,
  }
}

export function formatModelMetadataSummary(
  view: ModelMetadataView,
): string {
  return [
    `ctx ${view.context.displayTokens} (${view.context.sourceLabel})`,
    `out ${view.maxOutput.displayTokens} (${view.maxOutput.sourceLabel})`,
  ].join(' · ')
}

export function formatModelMetadataLines(
  view: ModelMetadataView,
): string[] {
  return [
    `metadata status: ${view.status}`,
    ...(view.status === 'warning' ? ['metadata: WARNING'] : []),
    `context: ${view.context.displayTokens} tokens (${view.context.sourceLabel})`,
    `context source: ${view.context.sourceLabel}`,
    `max output: ${view.maxOutput.displayTokens} tokens (${view.maxOutput.sourceLabel})`,
    `max output source: ${view.maxOutput.sourceLabel}`,
    ...view.warnings.map((warning) => `warning: ${warning}`),
  ]
}
