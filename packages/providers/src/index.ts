/**
 * LLM Provider 适配层
 * - mock
 * - openai-compatible（Chat Completions）
 * - anthropic（Messages API，对照 HelsincyCode 事件）
 */

export type {
  ProviderId,
  ProviderStreamEvent,
  ProviderUsage,
  CompleteStreamOptions,
  LlmProvider,
} from './types.ts'

export { createMockProvider } from './mock.ts'
export {
  createOpenAICompatibleProvider,
  toolsToOpenAI,
  toOpenAIMessages,
  type OpenAICompatibleConfig,
} from './openaiCompatible.ts'
export {
  createAnthropicProvider,
  toolsToAnthropic,
  toAnthropicMessages,
  type AnthropicConfig,
} from './anthropic.ts'
export {
  createProviderFromEnv,
  detectProviderKind,
  type EnvProviderResult,
  type CreateProviderOptions,
  type ProviderKind,
} from './fromEnv.ts'
export { createCompactSummarizerFromProvider } from './compactSummarizer.ts'