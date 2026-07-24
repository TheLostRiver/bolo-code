/**
 * LLM Provider 适配层
 * - mock
 * - openai-compatible（Chat Completions）
 * - openai-responses（Responses API 原生直连）
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
  buildOpenAICompatibleRequestBody,
  resolveOpenAIPromptCacheKey,
  eventsFromOpenAIChatDelta,
  type OpenAICompatibleConfig,
} from './openaiCompatible.ts'
export {
  createOpenAIResponsesProvider,
  toResponsesPayload,
  toolsToResponses,
  buildResponsesRequest,
  processResponsesSseJson,
  extractResponsesReasoningText,
  parseResponsesUsage,
  type OpenAIResponsesConfig,
} from './openaiResponses.ts'
export {
  createAnthropicProvider,
  toolsToAnthropic,
  toAnthropicMessages,
  buildAnthropicRequestBody,
  eventsFromAnthropicSseEvent,
  type AnthropicConfig,
} from './anthropic.ts'
export {
  getCacheControl,
  partitionSystemForCache,
  buildAnthropicSystemBlocks,
  withToolsCacheBreakpoint,
  addMessageCacheBreakpoint,
  derivePromptCacheKey,
  isPromptCachingEnabled,
  type AnthropicCacheControl,
  type AnthropicSystemTextBlock,
} from './promptCache.ts'
export {
  createProviderFromEnv,
  detectProviderKind,
  type EnvProviderResult,
  type CreateProviderOptions,
  type ProviderKind,
} from './fromEnv.ts'
export { createCompactSummarizerFromProvider } from './compactSummarizer.ts'
export {
  mapEffort,
  DEFAULT_EFFORT_BASE_MAX_TOKENS,
  type EffortLevel,
} from './effort.ts'
export {
  parseOpenAIStreamUsage,
  parseAnthropicStreamUsage,
  mergeProviderUsage,
} from './sseUsage.ts'