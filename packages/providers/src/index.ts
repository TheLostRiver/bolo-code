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
export { createOpenAIResponsesWsProvider } from './openaiResponsesWs.ts'
export {
  createAnthropicProvider,
  toolsToAnthropic,
  toAnthropicMessages,
  buildAnthropicRequestBody,
  eventsFromAnthropicSseEvent,
  resolveAnthropicThinking,
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
  createProviderFromProfile,
  detectProviderKind,
  resolveProviderApiKey,
  type EnvProviderResult,
  type CreateProviderOptions,
  type ProviderProfileInput,
  type ProviderKind,
} from './fromEnv.ts'
export { createCompactSummarizerFromProvider } from './compactSummarizer.ts'
export {
  mapEffort,
  DEFAULT_EFFORT_BASE_MAX_TOKENS,
  type EffortLevel,
} from './effort.ts'
export {
  resolveEffortWire,
  resolveEffortDialect,
  applyBodyPatches,
  applyEffortToRequestBody,
  detectEffortDialectId,
  formatEffortStatusLine,
  formatEffortCapabilityStatus,
  listEffortChoosable,
  describeEffortCapability,
  assertEffortChoosable,
  anthropicMaxAllowed,
  isEffortLooseMode,
  buildEffortPickerItems,
  activeEffortPickerIndex,
  getBuiltinEffortDialect,
  listBuiltinEffortDialectIds,
  isCanonicalEffortLevel,
  isAcceptableEffortInput,
  CANONICAL_EFFORT_LEVELS,
  DIALECT_DEEPSEEK_CHAT,
  DIALECT_OPENAI_RESPONSES,
  DIALECT_ANTHROPIC_OUTPUT,
  DIALECT_MAX_TOKENS,
  DIALECT_OFF,
  mergeEffortRequestHeaders,
  type EffortDialect,
  type EffortWirePlan,
  type EffortResolveResult,
  type EffortCapabilityView,
  type CanonicalEffortLevel,
} from './effortDialect.ts'
export {
  parseOpenAIStreamUsage,
  parseAnthropicStreamUsage,
  mergeProviderUsage,
} from './sseUsage.ts'
export {
  explainProviderError,
  type ProviderErrorContext,
} from './providerErrors.ts'
export {
  BUILTIN_MODEL_CAPS,
  filterChoosableByModelCaps,
  matchingModelCapRules,
  mergeModelCapRules,
  modelCapMaxAllowed,
  parseModelCapRules,
  type ModelCapRule,
} from './modelCapability.ts'