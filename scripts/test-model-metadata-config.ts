/**
 * CTX-1: provider/model limits config, validation, merge and pure resolution.
 *
 * Run: npm run test:model-metadata-config
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_MODEL_METADATA,
  loadConfigJsonWithWarnings,
  mergeConfigs,
  mergeProviderConfigJson,
  normalizeProviderRegistry,
  resolveModelMetadata,
  validateBoloConfigModelMetadata,
  type ResolvedModelMetadata,
} from '../packages/config/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`FAIL: ${message}`)
  }
}

function assertIncludes(
  values: readonly string[],
  pattern: RegExp,
  message: string,
): void {
  assert(
    values.some((value) => pattern.test(value)),
    `${message}: ${values.join(' | ')}`,
  )
}

async function main(): Promise<void> {
  const merged = mergeProviderConfigJson(
    {
      kind: 'openai-responses',
      contextWindowTokens: 200_000,
      maxTokens: 32_000,
      models: {
        'model-a': {
          contextWindowTokens: 180_000,
          maxTokens: 16_000,
        },
        'base-only': {
          contextWindowTokens: 64_000,
        },
      },
    },
    {
      maxTokens: 24_000,
      models: {
        'model-a': {
          maxTokens: 12_000,
        },
        'project-only': {
          contextWindowTokens: 1_000_000,
          maxTokens: 64_000,
        },
      },
    },
  )
  assert(merged?.contextWindowTokens === 200_000, 'provider context survives merge')
  assert(merged?.maxTokens === 24_000, 'project provider output wins')
  assert(
    merged?.models?.['model-a']?.contextWindowTokens === 180_000,
    'model entry keeps user context',
  )
  assert(
    merged?.models?.['model-a']?.maxTokens === 12_000,
    'model entry project output wins',
  )
  assert(
    merged?.models?.['base-only']?.contextWindowTokens === 64_000,
    'base-only model survives',
  )
  assert(
    merged?.models?.['project-only']?.contextWindowTokens === 1_000_000,
    'project-only model is added',
  )

  const layered = mergeConfigs(
    {
      defaultProvider: 'work',
      providers: {
        work: {
          contextWindowTokens: 200_000,
          models: {
            'model-a': {
              contextWindowTokens: 180_000,
              maxTokens: 16_000,
            },
          },
        },
      },
    },
    {
      providers: {
        work: {
          maxTokens: 24_000,
          models: {
            'model-a': {
              maxTokens: 12_000,
            },
          },
        },
      },
    },
  )
  assert(
    layered.providers?.work?.models?.['model-a']?.contextWindowTokens ===
      180_000,
    'user/project merge keeps lower model field',
  )
  assert(
    layered.providers?.work?.models?.['model-a']?.maxTokens === 12_000,
    'user/project merge applies higher model field',
  )

  const registry = normalizeProviderRegistry({
    ...layered,
    providers: {
      ...layered.providers,
      work: merged!,
    },
  })
  const work = registry.profiles.work
  assert(work?.contextWindowTokens === 200_000, 'profile keeps provider context')
  assert(work?.maxTokens === 24_000, 'profile keeps provider output')
  assert(
    work?.models?.['model-a']?.contextWindowTokens === 180_000,
    'profile keeps exact model context',
  )
  assert(
    work?.models?.['model-a']?.maxTokens === 12_000,
    'profile keeps exact model output',
  )

  const configWarnings = validateBoloConfigModelMetadata(
    {
      contextWindowTokens: 0,
      providers: {
        work: {
          kind: 'openai-responses',
          model: 'model-a',
          contextWindow: 200_000,
          context_window: 200_000,
          maxOutputTokens: 32_000,
          contextWindowTokens: 12.5,
          maxTokens: -1,
          futureProviderField: true,
          models: {
            '': {
              contextWindowTokens: 1,
            },
            'model-a': {
              contextWindowTokens: -20,
              maxTokens: 'lots',
              futureModelField: true,
            },
            broken: 'not-an-object',
          },
        },
      },
    },
    'test config',
  )
  assertIncludes(configWarnings, /test config.*contextWindowTokens.*positive integer/i, 'legacy zero warns')
  assertIncludes(configWarnings, /providers\.work\.contextWindow.*contextWindowTokens/i, 'contextWindow alias warns')
  assertIncludes(configWarnings, /providers\.work\.context_window.*contextWindowTokens/i, 'context_window alias warns')
  assertIncludes(configWarnings, /providers\.work\.maxOutputTokens.*maxTokens/i, 'max output alias warns')
  assertIncludes(configWarnings, /providers\.work\.futureProviderField.*unknown/i, 'provider unknown key warns')
  assertIncludes(configWarnings, /providers\.work\.contextWindowTokens.*positive integer/i, 'provider fraction warns')
  assertIncludes(configWarnings, /providers\.work\.maxTokens.*positive integer/i, 'provider negative warns')
  assertIncludes(configWarnings, /providers\.work\.models.*empty model id/i, 'empty model id warns')
  assertIncludes(configWarnings, /models\.model-a\.futureModelField.*unknown/i, 'model unknown key warns')
  assertIncludes(configWarnings, /models\.model-a\.contextWindowTokens.*positive integer/i, 'model context warns')
  assertIncludes(configWarnings, /models\.model-a\.maxTokens.*positive integer/i, 'model output warns')
  assertIncludes(configWarnings, /models\.broken.*object/i, 'non-object model entry warns')

  const root = path.join(process.cwd(), '.bolo-tmp', 'model-metadata-config')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })
  const configJson = path.join(root, 'config.json')
  await fs.writeFile(
    configJson,
    JSON.stringify({
      providers: {
        work: {
          kind: 'openai-responses',
          model: 'model-a',
          contextWindowTokens: -1,
          models: [],
        },
      },
    }),
    'utf8',
  )
  const loaded = await loadConfigJsonWithWarnings({ configJson } as never)
  assert(loaded.config !== undefined, 'invalid fields do not block config load')
  assertIncludes(loaded.warnings, new RegExp(configJson.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'field warning names file')
  assertIncludes(loaded.warnings, /contextWindowTokens.*positive integer/i, 'loaded invalid context warns')
  assertIncludes(loaded.warnings, /models.*object/i, 'loaded invalid models warns')

  const exact = resolveModelMetadata({
    providerId: 'work',
    model: 'model-a',
    profile: work,
    catalog: [],
  })
  assert(exact.contextWindowTokens === 180_000, 'exact model context wins')
  assert(exact.maxOutputTokens === 12_000, 'exact model output wins')
  assert(exact.sources.contextWindow === 'model', 'exact context source')
  assert(exact.sources.maxOutput === 'model', 'exact output source')
  assert(exact.usedFallback === false, 'exact metadata is not fallback')

  const mixedRegistry = normalizeProviderRegistry({
    providers: {
      mixed: {
        kind: 'openai-responses',
        model: 'model-a',
        contextWindowTokens: 200_000,
        maxTokens: 32_000,
        models: {
          'model-a': {
            contextWindowTokens: 180_000,
          },
        },
      },
    },
  })
  const mixed = resolveModelMetadata({
    providerId: 'mixed',
    model: 'model-a',
    profile: mixedRegistry.profiles.mixed,
    catalog: [],
  })
  assert(mixed.contextWindowTokens === 180_000, 'mixed exact context')
  assert(mixed.maxOutputTokens === 32_000, 'mixed provider output')
  assert(mixed.sources.contextWindow === 'model', 'mixed context source')
  assert(mixed.sources.maxOutput === 'provider', 'mixed output source')

  assert(BUILTIN_MODEL_METADATA.length > 0, 'builtin metadata catalog is not empty')
  assert(
    new Set(BUILTIN_MODEL_METADATA.map((entry) => entry.model.toLowerCase())).size ===
      BUILTIN_MODEL_METADATA.length,
    'builtin metadata model ids are unique',
  )
  assert(
    BUILTIN_MODEL_METADATA.every(
      (entry) =>
        Number.isInteger(entry.contextWindowTokens) &&
        entry.contextWindowTokens > 0 &&
        Number.isInteger(entry.maxOutputTokens) &&
        entry.maxOutputTokens > 0 &&
        entry.maxOutputTokens <= entry.contextWindowTokens,
    ),
    'builtin metadata limits are valid',
  )

  const catalog = resolveModelMetadata({
    providerId: 'openai',
    model: 'gpt-4o',
  })
  assert(catalog.contextWindowTokens === 128_000, 'catalog context')
  assert(catalog.maxOutputTokens === 16_384, 'catalog output')
  assert(catalog.sources.contextWindow === 'catalog', 'catalog context source')

  // generated 目录抽查（models.dev）：主流模型有真实限制而非 fallback
  const gpt56 = resolveModelMetadata({ providerId: 'openai', model: 'gpt-5.6-sol' })
  assert(
    gpt56.contextWindowTokens === 1_050_000 && gpt56.maxOutputTokens === 128_000,
    'generated: gpt-5.6-sol 1.05M/128K',
  )
  assert(gpt56.sources.contextWindow === 'catalog', 'generated: gpt-5.6-sol catalog source')
  const claude5 = resolveModelMetadata({ providerId: 'anthropic', model: 'claude-sonnet-5' })
  assert(
    claude5.contextWindowTokens === 1_000_000 && claude5.maxOutputTokens === 128_000,
    'generated: claude-sonnet-5 1M/128K',
  )
  const localDs = resolveModelMetadata({ providerId: 'deepseek', model: 'deepseek-v4-flash' })
  assert(
    localDs.contextWindowTokens === 1_000_000 && localDs.maxOutputTokens === 384_000,
    'local authoritative wins over generated duplicates',
  )
  assert(catalog.sources.maxOutput === 'catalog', 'catalog output source')
  assert(catalog.usedFallback === false, 'catalog is not fallback')

  const legacy = resolveModelMetadata({
    providerId: 'custom',
    model: 'unknown-model',
    legacyContextWindowTokens: 64_000,
    catalog: [],
  })
  assert(legacy.contextWindowTokens === 64_000, 'legacy context')
  assert(legacy.maxOutputTokens === 8_192, 'fallback output')
  assert(legacy.sources.contextWindow === 'legacy', 'legacy context source')
  assert(legacy.sources.maxOutput === 'fallback', 'fallback output source')
  assert(legacy.usedFallback === true, 'partial fallback is marked')
  assertIncludes(legacy.warnings, /max output.*fallback/i, 'output fallback warns')

  const snapshot: ResolvedModelMetadata = {
    providerId: 'custom',
    model: 'snapshot-model',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_000,
    sources: {
      contextWindow: 'model',
      maxOutput: 'provider',
    },
    usedFallback: false,
    warnings: [],
  }
  const resumed = resolveModelMetadata({
    providerId: 'custom',
    model: 'snapshot-model',
    snapshot,
    catalog: [],
  })
  assert(resumed.contextWindowTokens === 1_000_000, 'matching snapshot context')
  assert(resumed.maxOutputTokens === 32_000, 'matching snapshot output')
  assert(resumed.sources.contextWindow === 'snapshot', 'snapshot context source')
  assert(resumed.sources.maxOutput === 'snapshot', 'snapshot output source')

  const wrongIdentity = resolveModelMetadata({
    providerId: 'custom',
    model: 'different-model',
    snapshot,
    catalog: [],
  })
  assert(wrongIdentity.contextWindowTokens === 128_000, 'wrong snapshot identity falls back')
  assert(wrongIdentity.maxOutputTokens === 8_192, 'wrong snapshot output falls back')
  assert(wrongIdentity.sources.contextWindow === 'fallback', 'wrong snapshot context source')
  assert(wrongIdentity.sources.maxOutput === 'fallback', 'wrong snapshot output source')
  assertIncludes(wrongIdentity.warnings, /unknown model.*fallback/i, 'unknown fallback warns')

  const oversizedRegistry = normalizeProviderRegistry({
    providers: {
      bad: {
        contextWindowTokens: 32_000,
        maxTokens: 64_000,
      },
    },
  })
  const oversized = resolveModelMetadata({
    providerId: 'bad',
    model: 'unknown-model',
    profile: oversizedRegistry.profiles.bad,
    catalog: [],
  })
  assert(oversized.contextWindowTokens === 32_000, 'valid provider context remains')
  assert(oversized.maxOutputTokens === 8_192, 'oversized output is rejected')
  assert(oversized.sources.maxOutput === 'fallback', 'oversized output falls through')
  assertIncludes(oversized.warnings, /maxTokens.*64000.*context.*32000/i, 'oversized output warns')

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: CTX-1 model metadata config and resolver')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
