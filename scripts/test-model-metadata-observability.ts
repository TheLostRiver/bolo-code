/**
 * CTX-3: resolved model metadata observability across CLI surfaces.
 *
 * Run: npm run test:model-metadata-observability
 */

import {
  formatModelMetadataLines,
  formatModelMetadataSummary,
  normalizeProviderRegistry,
  resolveModelMetadata,
  toModelMetadataView,
  type ResolvedModelMetadata,
} from '../packages/config/src/index.ts'
import {
  createSession,
  dispatchSlashCommand,
  listSessionProviders,
  productionDeps,
  switchSessionProvider,
} from '../packages/core/src/index.ts'
import { createMockProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function metadata(
  providerId: string,
  model: string,
  contextWindowTokens: number,
  maxOutputTokens: number,
  contextSource: ResolvedModelMetadata['sources']['contextWindow'],
  outputSource: ResolvedModelMetadata['sources']['maxOutput'],
  warnings: string[] = [],
): ResolvedModelMetadata {
  return {
    providerId,
    model,
    contextWindowTokens,
    maxOutputTokens,
    sources: {
      contextWindow: contextSource,
      maxOutput: outputSource,
    },
    usedFallback:
      contextSource === 'fallback' || outputSource === 'fallback',
    warnings,
  }
}

async function main(): Promise<void> {
  const mixed = metadata(
    'work',
    'work-v1',
    200_000,
    32_000,
    'model',
    'provider',
  )
  const mixedView = toModelMetadataView(mixed)
  assert(mixedView.status === 'ok', 'valid mixed-source metadata is healthy')
  assert(
    mixedView.context.tokens === 200_000 &&
      mixedView.context.displayTokens === '200k' &&
      mixedView.context.source === 'model' &&
      mixedView.context.sourceLabel === 'model override',
    'context view preserves value, display and source',
  )
  assert(
    mixedView.maxOutput.tokens === 32_000 &&
      mixedView.maxOutput.displayTokens === '32k' &&
      mixedView.maxOutput.source === 'provider' &&
      mixedView.maxOutput.sourceLabel === 'provider default',
    'output view preserves its independent source',
  )
  assert(
    formatModelMetadataSummary(mixedView).includes(
      'ctx 200k (model override)',
    ) &&
      formatModelMetadataSummary(mixedView).includes(
        'out 32k (provider default)',
      ),
    'compact summary renders both independent sources',
  )
  assert(
    formatModelMetadataLines(mixedView).join('\n').includes(
      'context: 200k tokens (model override)',
    ),
    'full formatter renders context source',
  )

  const fallback = metadata(
    'unknown',
    'mystery-v1',
    128_000,
    8_192,
    'fallback',
    'fallback',
    ['unknown model metadata for "mystery-v1"; using fallback limits'],
  )
  const fallbackView = toModelMetadataView(fallback)
  assert(
    fallbackView.status === 'warning' && fallbackView.usedFallback,
    'fallback metadata is visibly unhealthy',
  )
  const fallbackText = formatModelMetadataLines(fallbackView).join('\n')
  assert(
    fallbackText.includes('metadata: WARNING') &&
      fallbackText.includes('unknown model metadata'),
    'fallback formatter exposes warning and reason',
  )

  const registry = normalizeProviderRegistry({
    defaultProvider: 'work',
    providers: {
      work: {
        kind: 'mock',
        model: 'work-v1',
        contextWindowTokens: 64_000,
        maxTokens: 32_000,
        models: {
          'work-v1': {
            contextWindowTokens: 200_000,
          },
        },
      },
      huge: {
        kind: 'mock',
        model: 'huge-v1',
        contextWindowTokens: 1_000_000,
        maxTokens: 64_000,
      },
    },
  })
  const provider = createMockProvider()
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    deps: productionDeps(provider),
    systemPrompt: false,
    model: 'work-v1',
    providerRegistry: registry,
    providerId: 'work',
    providerProfile: registry.profiles.work,
    resolvedModel: resolveModelMetadata({
      providerId: 'work',
      model: 'work-v1',
      profile: registry.profiles.work,
    }),
  })

  const context = await dispatchSlashCommand(session, 'context', '')
  assert(context.ok && context.contextView, '/context returns structured view')
  assert(
    context.contextView.modelMetadata.context.source === 'model' &&
      context.contextView.modelMetadata.maxOutput.source === 'provider',
    '/context carries independent metadata provenance',
  )
  assert(
    context.message.includes('context: 200k tokens (model override)') &&
      context.message.includes('max output: 32k tokens (provider default)'),
    '/context plain output explains both limits',
  )

  const details = await dispatchSlashCommand(session, 'context', 'details')
  assert(
    details.ok &&
      details.message.includes('metadata status: ok') &&
      details.message.includes('context source: model override'),
    '/context details includes metadata health and source',
  )

  const doctor = await dispatchSlashCommand(session, 'doctor', '')
  assert(
    doctor.ok &&
      doctor.message.includes('context window:  200k tokens (model override)') &&
      doctor.message.includes('max output:      32k tokens (provider default)'),
    '/doctor exposes active limits and sources',
  )

  const model = await dispatchSlashCommand(session, 'model', '')
  assert(
    model.ok &&
      model.message.includes('context: 200k tokens (model override)') &&
      model.message.includes('max output: 32k tokens (provider default)'),
    '/model query exposes active metadata',
  )

  const listed = listSessionProviders(session)
  assert(
    listed.every((item) => item.modelMetadata),
    'provider summaries carry structured model metadata',
  )
  assert(
    listed.find((item) => item.id === 'huge')?.modelMetadata.context
      .displayTokens === '1m',
    'inactive provider metadata resolves from its own profile',
  )
  const providerList = await dispatchSlashCommand(session, 'provider', 'list')
  assert(
    providerList.ok &&
      providerList.message.includes('ctx 200k (model override)') &&
      providerList.message.includes('ctx 1m (provider default)'),
    '/provider list explains active and inactive limits',
  )

  const switched = switchSessionProvider(session, 'huge')
  assert(switched.ok, 'provider switch succeeds')
  if (switched.ok) {
    assert(
      switched.modelMetadata.context.tokens === 1_000_000 &&
        switched.modelMetadata.maxOutput.tokens === 64_000,
      'provider switch returns refreshed structured metadata',
    )
    assert(
      switched.message.includes('ctx 1m (provider default)') &&
        switched.message.includes('out 64k (provider default)'),
      'provider switch message exposes refreshed metadata',
    )
  }

  const fallbackProvider = createMockProvider()
  const fallbackSession = await createSession({
    cwd: process.cwd(),
    provider: fallbackProvider,
    deps: productionDeps(fallbackProvider),
    systemPrompt: false,
    model: 'mystery-v1',
    resolvedModel: fallback,
  })
  const fallbackDoctor = await dispatchSlashCommand(
    fallbackSession,
    'doctor',
    '',
  )
  assert(
    fallbackDoctor.ok &&
      fallbackDoctor.message.includes('metadata:        WARNING') &&
      fallbackDoctor.message.includes('unknown model metadata'),
    '/doctor makes fallback and its reason visible',
  )

  console.log('PASS: CTX-3 model metadata observability')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
