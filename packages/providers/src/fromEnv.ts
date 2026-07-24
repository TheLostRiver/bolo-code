/**
 * 从环境变量 / 显式 kind 创建 Provider
 *
 * BOLO_PROVIDER = mock | openai-compatible | openai | anthropic | claude
 *
 * OpenAI:
 *   BOLO_API_KEY / OPENAI_API_KEY
 *   BOLO_BASE_URL / OPENAI_BASE_URL
 *   BOLO_MODEL / OPENAI_MODEL
 *
 * Anthropic:
 *   ANTHROPIC_API_KEY / BOLO_API_KEY
 *   ANTHROPIC_BASE_URL / BOLO_BASE_URL
 *   ANTHROPIC_MODEL / BOLO_MODEL
 */

import { createMockProvider } from './mock.ts'
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './openaiCompatible.ts'
import {
  createAnthropicProvider,
  type AnthropicConfig,
} from './anthropic.ts'
import type { LlmProvider, ProviderId } from './types.ts'

export type ProviderKind = ProviderId

export type EnvProviderResult = {
  provider: LlmProvider
  kind: ProviderKind
  model?: string
  baseUrl?: string
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

function normalizeKind(raw?: string): ProviderKind | undefined {
  if (!raw) return undefined
  const k = raw.toLowerCase().trim()
  if (k === 'mock') return 'mock'
  if (k === 'openai' || k === 'openai-compatible') return 'openai-compatible'
  if (k === 'anthropic' || k === 'claude') return 'anthropic'
  return undefined
}

export type CreateProviderOptions = {
  forceMock?: boolean
  kind?: ProviderKind
  apiKey?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  maxTokens?: number
}

/**
 * 推断 kind：显式 > BOLO_PROVIDER > 有 ANTHROPIC_API_KEY 则 anthropic > 有 OPENAI key 则 openai > mock
 */
export function detectProviderKind(
  overrides?: CreateProviderOptions,
): ProviderKind {
  if (overrides?.forceMock) return 'mock'
  const fromOpt = normalizeKind(overrides?.kind)
  if (fromOpt) return fromOpt
  const fromEnv = normalizeKind(env('BOLO_PROVIDER'))
  if (fromEnv) return fromEnv
  if (env('ANTHROPIC_API_KEY')) return 'anthropic'
  if (env('OPENAI_API_KEY') || env('BOLO_API_KEY')) return 'openai-compatible'
  return 'mock'
}

export function createProviderFromEnv(
  overrides?: CreateProviderOptions & Partial<OpenAICompatibleConfig>,
): EnvProviderResult {
  const kind = detectProviderKind(overrides)

  if (kind === 'mock') {
    return { provider: createMockProvider(), kind: 'mock' }
  }

  if (kind === 'anthropic') {
    const apiKey =
      overrides?.apiKey ??
      env('ANTHROPIC_API_KEY') ??
      env('BOLO_API_KEY')
    if (!apiKey) {
      return { provider: createMockProvider(), kind: 'mock' }
    }
    const baseUrl =
      overrides?.baseUrl ??
      env('ANTHROPIC_BASE_URL') ??
      env('BOLO_BASE_URL')
    const model =
      overrides?.model ??
      env('ANTHROPIC_MODEL') ??
      env('BOLO_MODEL') ??
      'claude-sonnet-4-20250514'

    const cfg: AnthropicConfig = {
      apiKey,
      baseUrl,
      model,
      timeoutMs: overrides?.timeoutMs,
      maxTokens: overrides?.maxTokens,
    }
    return {
      provider: createAnthropicProvider(cfg),
      kind: 'anthropic',
      model,
      baseUrl: baseUrl ?? 'https://api.anthropic.com',
    }
  }

  // openai-compatible
  const apiKey =
    overrides?.apiKey ?? env('BOLO_API_KEY') ?? env('OPENAI_API_KEY')
  if (!apiKey) {
    return { provider: createMockProvider(), kind: 'mock' }
  }
  const baseUrl =
    overrides?.baseUrl ?? env('BOLO_BASE_URL') ?? env('OPENAI_BASE_URL')
  const model =
    overrides?.model ??
    env('BOLO_MODEL') ??
    env('OPENAI_MODEL') ??
    'gpt-4o-mini'

  return {
    provider: createOpenAICompatibleProvider({
      apiKey,
      baseUrl,
      model,
      timeoutMs: overrides?.timeoutMs,
      maxTokens: overrides?.maxTokens,
    }),
    kind: 'openai-compatible',
    model,
    baseUrl: baseUrl ?? 'https://api.openai.com/v1',
  }
}