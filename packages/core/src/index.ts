/**
 * Agent Runtime — Session 外壳 + compactSession
 * Agent loop 本体见 queryLoop.ts（对照 HelsincyCode query.ts）
 * 禁止：Electron / DOM / 遥测
 */

import {
  runFullCompact,
  isAutoCompactEnvDisabled,
  estimateTokens,
  shouldAutoCompact,
  type CompactSummarizer,
  type MicrocompactOptions,
  type SnipOptions,
  type UsageAnchor,
} from '../../compact/src/index.ts'
import { runHooks } from '../../hooks/src/index.ts'
import {
  createMockProvider,
  createCompactSummarizerFromProvider,
  type LlmProvider,
} from '../../providers/src/index.ts'
import {
  loadWorkspace,
  resolveModelMetadata,
  type ResolvedWorkspace,
  type ResolvedModelMetadata,
  type ProviderRegistry,
  type ProviderProfile,
} from '../../config/src/index.ts'
import { attachProviderRegistry } from './sessionProvider.ts'
import {
  normalizeUltrathinkMode,
  planUltrathinkTurn,
  resolveUltrathinkMode,
  type UltrathinkMode,
} from './ultrathink.ts'
import {
  closeMcpConnections,
  connectMcpServers,
  isMcpManagedToolName,
  mergeSessionToolsWithMcp,
  type ConnectedMcpServer,
  type ConnectMcpResult,
  type McpListChangedEvent,
} from '../../mcp/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import { formatSkillCatalog } from '../../skills/src/index.ts'
import type {
  LoadedPlugin,
  PluginCommand,
} from '../../plugins/src/index.ts'
import {
  cleanupShellOutputDir,
  createSearxngSearchTool,
  killAllBackgroundShells,
  SEARXNG_SEARCH_TOOL_NAME,
  type BoloTool,
} from '../../tools/src/index.ts'
import { createBackgroundShellStore } from '../../shared/src/index.ts'
import {
  newId,
  nowIso,
  type ChatMessage,
  type HooksConfig,
  type SessionEndReason,
  type SessionPhase,
  type SessionStartSource,
  type ToolPresentation,
} from '../../shared/src/index.ts'
import {
  composePrepareMessages,
  createAutoCompactPrepare,
  createMicrocompactPrepare,
  createSnipPrepare,
  productionDeps,
  type QueryDeps,
} from './deps.ts'
import { queryLoop, type QueryLoopEvent, type Terminal } from './queryLoop.ts'
import { getSessionTodoStore } from './sessionTodo.ts'
import {
  persistBackgroundShellManifest,
  removeBackgroundShellManifest,
  restoreBackgroundShellManifest,
} from './backgroundShellManifest.ts'
import type { AskPermissionFn } from './toolExecution.ts'
import {
  appendHookDiag,
  createHookDiagLog,
  diagEntriesFromHookRun,
} from './hookDiag.ts'
import {
  createBackgroundAgentStore,
  createDefaultTools,
  loadAgentsDir,
  restoreBackgroundAgentStoreFromDurableTasks,
  resolveAgentPolicy,
  takeBackgroundAgentResultsForPromotion,
  type ActiveAgentDefinitions,
} from './subagent.ts'
import {
  createEmptyPermissionRules,
  parsePermissionMode,
  createAutoModeState,
  stripDangerousAllowsForAuto,
  createAutoClassifyFromCompleteText,
  type PermissionMode,
  type SessionPermissionRules,
  type AutoModeState,
  type AutoClassifyFn,
} from '../../permissions/src/index.ts'
import {
  assembleSessionSystemPrompt,
  replaceSkillCatalogSection,
  type AssembleSessionSystemPromptOptions,
} from './systemPrompt.ts'
import {
  loadBoloRules,
  collectActivePathsFromMessages,
  replaceProjectRulesSection,
} from './rules.ts'
import {
  applySnapshotToSession,
  getSessionPersistMeta,
  loadSession,
  maybeAutoSaveSession,
  saveSession,
  setSessionPersistMeta,
  appendSessionFileDiff,
  appendSessionTodos,
  appendSessionSystemNote,
  appendSessionTurnState,
  hasDurableSessionPersistence,
  type SaveSessionOptions,
  type SessionScope,
  type SessionSnapshot,
} from './sessionPersist.ts'
import {
  writeTranscriptAfterCompact,
  getTranscriptWriteState,
  resolveTranscriptPathFromJson,
  loadTranscriptFile,
  fileDiffsFromTranscriptEntries,
  projectTodosFromEntries,
  projectDurableTurns,
  projectDurableControls,
  projectDurableTasks,
  projectDurableResolutions,
  projectToolPresentationsFromEntries,
} from './sessionTranscript.ts'
import {
  applyDurableTurnEvent,
  normalizeDurableTurnId,
  type DurableTurnRecord,
  type DurableTurnState,
} from './durableTurn.ts'
import type { DurableControlRecord } from './durableControl.ts'
import type { DurableTaskRecord } from './durableTask.ts'
import type { DurableResolutionRecord } from './durableResolution.ts'
import {
  defaultSessionCoordinator,
  type SessionCoordinator,
} from './sessionCoordinator.ts'
import {
  promoteSessionControls,
  releaseSessionRunner,
} from './sessionControlRuntime.ts'
import { createSessionBackgroundTaskLifecycle } from './sessionTaskRuntime.ts'
import type { SessionUsage } from './sessionUsage.ts'
import {
  cloneSessionUsage,
  promptTokensFromUsage,
  createEmptySessionUsage,
} from './sessionUsage.ts'
import { createPromptCacheSessionState } from '../../compact/src/index.ts'

export type { AskPermissionFn, Terminal }
export type {
  QueryDeps,
  PrepareMessagesFn,
  CallModelFn,
  ModelRetryInfo,
  ModelRetryOptions,
} from './deps.ts'
export {
  productionDeps,
  createCallModelFromProvider,
  createAutoCompactPrepare,
  createMicrocompactPrepare,
  createSnipPrepare,
  composePrepareMessages,
  identityPrepareMessages,
  wrapCallModelWithRetry,
  DEFAULT_MAX_MODEL_RETRIES,
  DEFAULT_MODEL_RETRY_BASE_DELAY_MS,
} from './deps.ts'
export type {
  MicrocompactOptions,
  SnipOptions,
} from '../../compact/src/index.ts'
export {
  RUNTIME_QUERY_ENTITIES,
  isRuntimeQueryEntity,
  queryRuntimeSnapshot,
  type RuntimeQueryEntity,
  type RuntimeQuery,
  type RuntimeAvailableAction,
  type RuntimeTurnListItem,
  type RuntimeControlListItem,
  type RuntimeTaskListItem,
  type RuntimeListItem,
  type RuntimeListView,
  type RuntimeInspectView,
  type RuntimeQueryView,
  type RuntimeQueryResult,
} from '../../shared/src/runtimeQuery.ts'
export {
  microcompactMessages,
  snipMessagesIfNeeded,
  cachedMicrocompactMessages,
  formatSnipBoundaryContent,
  parseSnipBoundaryId,
  newSnipId,
  createPromptCacheSessionState,
  shouldBreakPromptCache,
  touchPromptCacheSession,
  notePromptCacheAfterModelCall,
  formatPromptCacheSessionLine,
  hashStablePrefix,
  hashToolNames,
  diffToolNames,
  serializePromptCacheSessionState,
  parsePromptCacheSessionState,
  findSafeSnipCutIndex,
  TOOL_RESULT_CLEARED_MESSAGE,
  SNIP_BOUNDARY_CONTENT,
  DEFAULT_MICROCOMPACT_OPTIONS,
  DEFAULT_SNIP_OPTIONS,
  DEFAULT_PROMPT_CACHE_TTL_MS,
  isPromptTooLongError,
  truncateHeadForPtlRetry,
  groupMessagesByApiRound,
  groupMessagesByUserTurn,
  splitMessagesForCompactKeep,
  adjustCutForToolPairing,
  resolveAutoCompactTokenCount,
  DEFAULT_MAX_PTL_RETRIES,
  DEFAULT_KEEP_RECENT_USER_TURNS,
  PTL_RETRY_MARKER,
  estimateTokens,
  estimateTextTokens,
  estimateMessageTokens,
  estimateSystemSectionsTokens,
  getAutoCompactThreshold,
  getEffectiveContextWindow,
  getContextPressure,
  shouldAutoCompact,
  isAutoCompactEnvDisabled,
  isEnvTruthy,
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_BUFFER_TOKENS,
  DEFAULT_MAX_AUTOCOMPACT_FAILURES,
} from '../../compact/src/index.ts'
export {
  classifyError,
  isRetryableError,
  extractHttpStatus,
  errorMessageOf,
  type ErrorClass,
  type ClassifiedError,
} from './errorClassify.ts'
export { queryLoop } from './queryLoop.ts'
export {
  SessionCoordinator,
  defaultSessionCoordinator,
  SESSION_RUNNER_BUSY_CODE,
  SESSION_CONTROL_KINDS,
  SESSION_SAFE_BOUNDARIES,
  type SessionControlCancelResult,
  type SessionControlKind,
  type SessionControlPromotionResult,
  type SessionControlRecord,
  type SessionControlRejectCode,
  type SessionControlRequest,
  type SessionControlRequestResult,
  type SessionControlState,
  type SessionSafeBoundary,
  type SessionRunnerAcquireResult,
  type SessionRunnerLease,
  type SessionRunnerOwner,
  type SessionRunnerSnapshot,
} from './sessionCoordinator.ts'
export {
  createEmptySessionUsage,
  cloneSessionUsage,
  accumulateSessionUsage,
  mergeSessionUsage,
  computeCacheHitRate,
  formatCacheHitRatePercent,
  estimateTokensFromChars,
  estimateUsageFromCharCounts,
  estimateUsageFromTexts,
  normalizeProviderUsage,
  formatSessionUsage,
  formatUsageOneLiner,
  estimateSessionUsd,
  type SessionUsage,
  type ModelUsageBucket,
  type UsageDelta,
  type LastCallUsage,
} from './sessionUsage.ts'
export {
  estimateUsdCost,
  formatUsd,
  resolveModelCostRates,
  COST_TIER_DEFAULT,
  COST_TIER_OPUS,
  COST_TIER_HAIKU,
  COST_TIER_MINI,
  COST_TIER_FLAGSHIP_CHAT,
  COST_TIER_NANO,
  type ModelCostRates,
  type TokenUsageForCost,
} from './modelCost.ts'
// formatDurationMs：modelCost 与 subagent 同名；index 只 re-export subagent 的 formatDurationMs
export { runTools, partitionToolCalls } from './toolOrchestration.ts'
export { runToolUse } from './toolExecution.ts'
export type {
  RunToolUseContext,
  RunToolUseResult,
  ToolExecutionEvent,
  ToolUseBlock,
} from './toolExecution.ts'
export { StreamingToolExecutor } from './streamingToolExecutor.ts'
export type { PermissionMode, SessionPermissionRules } from '../../permissions/src/index.ts'
export {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  truncateToolResultOutput,
} from './toolExecution.ts'
export {
  DEFAULT_TOOL_RESULT_CHUNK_BYTES,
  MAX_TOOL_RESULT_CHUNK_BYTES,
  cleanupToolResultSession,
  readToolResultFileChunk,
  resolveToolResultFilePath,
  resolveToolResultSessionDirectory,
  writeToolResultFile,
  type ToolResultChunkReader,
  type ToolResultChunkReadRequest,
  type ToolResultChunkReadResult,
  type ToolResultReadFailureReason,
  type ToolResultSessionCleanupResult,
} from './toolResultStore.ts'
export {
  appendFileChange,
  createEmptyFileDiffLog,
  formatDiffSlash,
  recordsFromToolMeta,
  summarizeFileDiffLog,
  type FileChangeRecord,
  type FileDiffSummary,
  type FileChangeOp,
} from './fileDiffLog.ts'
export {
  buildDiffViewModelFromLog,
  buildDiffViewModelFromPreview,
  applyDiffViewKey,
  formatDiffViewScreen,
  flattenHunkLines,
  selectedFile,
  type DiffViewModel,
  type DiffViewFile,
  type DiffViewSource,
  type DiffViewKeyResult,
} from './diffViewModel.ts'
export {
  projectSessionRuntimeEventView,
  type SessionRuntimeEventView,
} from './sessionRuntimeEventView.ts'
export {
  formatFileChangeHistoryCell,
  fileChangeCellFromMeta,
  shouldExpandFileChangeCell,
  type FileChangeCellInput,
  type FileChangeCellFile,
  type FormatFileChangeCellOptions,
} from './fileChangeCell.ts'
export {
  loadBoloMd,
  getSystemPrompt,
  getSystemPromptPartition,
  getCacheStableSections,
  getCacheStablePrefix,
  getVolatileSections,
  partitionSystemPromptSections,
  buildEffectiveSystemPrompt,
  prepareModelMessages,
  assembleSessionSystemPrompt,
  replaceSkillCatalogSection,
  systemSectionsToMessages,
  boloMdCandidatePaths,
  permissionModeBehaviorLine,
  BOLO_MD_MAX_CHARS_PER_FILE,
  BOLO_MD_MAX_TOTAL_CHARS,
} from './systemPrompt.ts'
export {
  getMemoryDir,
  getProjectMemoryDir,
  getMemoryEntrypoint,
  getProjectMemoryEntrypoint,
  ensureMemoryDir,
  ensureProjectMemoryDir,
  loadMemoryEntrypoint,
  loadProjectMemoryEntrypoint,
  truncateMemoryEntrypoint,
  scanMemoryTopics,
  selectRelevantMemoryTopics,
  loadTopicBodies,
  tokenizeMemoryQuery,
  parseMemoryTopicFrontmatter,
  buildMemorySystemSection,
  buildMemoryGuidelines,
  formatMemoryStatus,
  formatMemoryTopicsList,
  isMemoryDisabled,
  getMemoryDailyLogPath,
  appendMemoryDailyLog,
  flushMemoryFromRecentMessages,
  getTeamMemoryDir,
  ensureTeamMemoryDir,
  MEMORY_ENTRYPOINT_NAME,
  MAX_MEMORY_ENTRYPOINT_LINES,
  MAX_MEMORY_ENTRYPOINT_BYTES,
  MAX_MEMORY_TOPIC_FILES,
  MAX_RELEVANT_MEMORY_TOPICS,
  MAX_RELEVANT_MEMORY_BODY_CHARS,
} from './memory.ts'

import { flushMemoryFromRecentMessages } from './memory.ts'
export type {
  SystemPromptPartition,
  GetSystemPromptOptions,
  SystemPromptEnv,
} from './systemPrompt.ts'
export {
  loadBoloRules,
  parseRuleFrontmatter,
  collectRuleCandidates,
  matchRulePathGlob,
  activePathsMatchGlobs,
  collectActivePathsFromMessages,
  extractPathTokensFromText,
  replaceProjectRulesSection,
  BOLO_RULES_MAX_CHARS_PER_FILE,
  BOLO_RULES_MAX_TOTAL_CHARS,
  type BoloRuleSource,
  type LoadBoloRulesResult,
  type LoadBoloRulesOptions,
  type RuleFrontmatter,
} from './rules.ts'
export {
  createProviderFromEnv,
  createProviderFromProfile,
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  createMockProvider,
  createCompactSummarizerFromProvider,
  explainProviderError,
} from '../../providers/src/index.ts'
export {
  loadWorkspace,
  ensureUserLayout,
  ensureProjectLayout,
  ensureAllLayouts,
  getBoloHomeDir,
  getProjectBoloDir,
  normalizeProviderRegistry,
  resolveProviderFromConfig,
  type ProviderRegistry,
  type ProviderProfile,
  type ProviderConfigJson,
} from '../../config/src/index.ts'
export {
  switchSessionProvider,
  switchSessionModel,
  listSessionProviders,
  formatSessionProvidersSlash,
  buildProviderPickerItems,
  formatProviderPickerLabel,
  activeProviderPickerIndex,
  attachProviderRegistry,
  getSessionModelMetadataView,
  type SwitchSessionProviderResult,
  type SwitchSessionModelResult,
  type SwitchableProviderSession,
} from './sessionProvider.ts'
export {
  clampEffortForSession,
  type ClampEffortResult,
  type EffortClampSession,
} from './effortClamp.ts'
export {
  suggestModelsForSession,
  getSessionModelEffortSettings,
  updateSessionModelEffort,
  type SessionModelEffortSession,
  type SessionModelEffortSettings,
  type SessionModelEffortUpdate,
  type SessionModelEffortUpdateResult,
} from './sessionModelEffortSettings.ts'
export {
  planUltrathinkTurn,
  resolveUltrathinkMode,
  normalizeUltrathinkMode,
  textHasUltrathink,
  formatUltrathinkStatus,
  ULTRATHINK_TARGET_EFFORT,
  type UltrathinkMode,
  type UltrathinkTurnPlan,
  type UltrathinkSessionLike,
  type ResolveUltrathinkModeInput,
} from './ultrathink.ts'
export {
  PERMISSION_MODES,
  PERMISSION_MODE_META,
  getNextPermissionMode,
  resolveSubagentPermissionMode,
  permissionModeRank,
  decidePermission,
  createEmptyPermissionRules,
  matchesAlwaysAllow,
  matchesAlwaysDeny,
  matchPathGlob,
  matchBashPattern,
  addAlwaysAllowToolName,
  addAlwaysAllowPathGlob,
  addAlwaysAllowBashPrefix,
  addAlwaysDenyToolName,
  addAlwaysDenyPathGlob,
  addAlwaysDenyBashPrefix,
  addAlwaysDenyPrefix,
  isAutoAllowlistedTool,
  createAutoModeState,
  stripDangerousAllowsForAuto,
  createAutoClassifyFromCompleteText,
  parseAutoClassifierResponse,
  type AutoModeState,
  type AutoClassifyFn,
  type AutoClassifyResult,
} from '../../permissions/src/index.ts'
export {
  SESSION_SNAPSHOT_VERSION,
  toSnapshot,
  parseSessionSnapshot,
  saveSession,
  loadSession,
  listWorkspaceSessions,
  listProjectSessions,
  sessionPreviewFromMessages,
  resolveSessionFilePath,
  resolveIdOrPath,
  looksLikeSessionPath,
  resolveJsonPathFromTranscript,
  sessionFileName,
  applySnapshotToSession,
  setSessionPersistMeta,
  getSessionPersistMeta,
  maybeAutoSaveSession,
  atomicWriteJson,
  loadSessionPair,
  migrateSessionToJsonl,
  setSessionTitle,
  appendSessionSystemNote,
  appendSessionFileDiff,
  appendSessionTodos,
  appendSessionTurnState,
  appendSessionControlState,
  appendSessionTaskState,
  appendSessionTaskResult,
  appendSessionResolution,
  hasDurableSessionPersistence,
  type SessionSnapshot,
  type SessionScope,
  type SessionListItem,
  type SaveSessionOptions,
  type LoadSessionOptions,
  type MigrateSessionOptions,
  type PersistableSession,
  type SessionPersistMeta,
} from './sessionPersist.ts'
export {
  requestSessionControl,
  cancelSessionControl,
  promoteSessionControls,
  takeNextSessionQueued,
  releaseSessionRunner,
  type SessionControlRuntimeSession,
  type SessionControlRuntimeRequestResult,
  type SessionControlRuntimeCancelResult,
  type SessionControlRuntimePromotionResult,
  type SessionControlTakeResult,
  type SessionRunnerReleaseResult,
} from './sessionControlRuntime.ts'
export {
  getSessionComposerActions,
  requestSessionComposerControl,
  type SessionComposerRuntime,
  type SessionComposerControlResult,
} from './composerRuntime.ts'
// AR3B：视图装配（transcript → 会话列表 / turn timeline）
export {
  loadSessionTimeline,
  loadSessionListEntries,
  type LoadTimelineResult,
  type LoadSessionListOptions,
} from './sessionViews.ts'

export {
  appendTranscriptLine,
  ensureTranscriptFile,
  recordSessionMessages,
  appendCompactBoundary,
  appendSessionTitle,
  appendSystemNote,
  appendFileDiffEntry,
  appendTurnEntry,
  appendControlEntry,
  appendTaskEntry,
  appendTaskResultEntry,
  appendResolutionEntry,
  appendToolPresentationEntry,
  dualWriteSessionTranscript,
  writeTranscriptAfterCompact,
  resolveTranscriptPathFromJson,
  resolveTranscriptFilePath,
  sessionTranscriptFileName,
  countTranscriptMessageEntries,
  rewriteTranscriptFromMessages,
  loadTranscriptFile,
  loadTranscriptMessages,
  messagesFromTranscriptEntries,
  titleFromTranscriptEntries,
  systemNotesFromTranscriptEntries,
  fileDiffsFromTranscriptEntries,
  projectTodosFromEntries,
  appendTodoEntry,
  buildTodoEntry,
  projectDurableTurns,
  projectDurableControls,
  projectDurableTasks,
  projectDurableResolutions,
  projectToolPresentationsFromEntries,
  normalizeSessionTitle,
  normalizeSystemNoteText,
  buildTitleEntry,
  buildSystemNoteEntry,
  buildFileDiffEntry,
  buildTurnEntry,
  buildControlEntry,
  buildTaskEntry,
  buildTaskResultEntry,
  buildResolutionEntry,
  buildToolPresentationEntry,
  scanTranscriptLite,
  DEFAULT_LITE_SCAN_BYTES,
  getTranscriptWriteState,
  setTranscriptWriteState,
  metaInputFromSession,
  buildMetaEntry,
  buildSessionStateEntry,
  type TranscriptEntry,
  type TranscriptMetaEntry,
  type TranscriptSessionStateEntry,
  type TranscriptMessageEntry,
  type TranscriptCompactBoundaryEntry,
  type TranscriptTitleEntry,
  type TranscriptSystemNoteEntry,
  type TranscriptFileDiffEntry,
  type TranscriptTodoEntry,
  type TranscriptTurnEntry,
  type TranscriptControlEntry,
  type TranscriptTaskEntry,
  type TranscriptTaskResultEntry,
  type TranscriptResolutionEntry,
  type TranscriptToolPresentationEntry,
  type TranscriptMetaInput,
  type TranscriptLiteScan,
} from './sessionTranscript.ts'
export {
  DURABLE_TURN_STATES,
  applyDurableTurnEvent,
  isDurableTurnState,
  normalizeDurableTurnId,
  projectDurableTurnEvents,
  type DurableTurnEvent,
  type DurableTurnRecord,
  type DurableTurnState,
} from './durableTurn.ts'
export {
  DURABLE_CONTROL_STATES,
  DURABLE_CONTROL_BOUNDARIES,
  applyDurableControlEvent,
  isDurableControlState,
  isDurableControlBoundary,
  isSessionControlKind,
  normalizeDurableControlId,
  normalizeDurableControlSessionId,
  projectDurableControlEvents,
  type DurableControlBoundary,
  type DurableControlEvent,
  type DurableControlRecord,
  type DurableControlState,
} from './durableControl.ts'
export {
  DURABLE_TASK_STATES,
  DURABLE_TASK_ISOLATIONS,
  applyDurableTaskEvent,
  isDurableTaskState,
  isDurableTaskIsolation,
  normalizeDurableTaskId,
  normalizeDurableTaskSessionId,
  projectDurableTaskEvents,
  type DurableTaskEvent,
  type DurableTaskStateEvent,
  type DurableTaskResultEvent,
  type DurableTaskRecord,
  type DurableTaskResult,
  type DurableTaskState,
  type DurableTaskIsolation,
} from './durableTask.ts'
export {
  DURABLE_RESOLUTION_ACTIONS,
  DURABLE_RESOLUTION_ENTITY_KINDS,
  applyDurableResolutionEvent,
  isDurableResolutionAction,
  isDurableResolutionEntityKind,
  normalizeDurableResolutionId,
  normalizeDurableResolutionSessionId,
  normalizeDurableResolutionEntityId,
  projectDurableResolutionEvents,
  type DurableResolutionAction,
  type DurableResolutionEntityKind,
  type DurableResolutionEvent,
  type DurableResolutionRecord,
} from './durableResolution.ts'
export {
  createSessionBackgroundTaskLifecycle,
  type SessionTaskRuntimeSession,
} from './sessionTaskRuntime.ts'

export type SessionEvent =
  | { type: 'phase'; phase: SessionPhase | string }
  | { type: 'text'; text: string }
  /** 思考链增量（流式展示；不持久化进 transcript） */
  | { type: 'reasoning'; text: string }
  /** provider 的显式思考分段结束边界。 */
  | { type: 'reasoning_end' }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | {
      type: 'tool_progress'
      id: string
      name: string
      message: string
    }
  | {
      type: 'tool_end'
      id: string
      name: string
      output: string
      ok: boolean
      presentation?: ToolPresentation
      path?: string
      added?: number
      removed?: number
      summaryLine?: string
      ansiUnified?: string
      files?: Array<{
        path: string
        op?: string
        added?: number
        removed?: number
      }>
      cellCollapsed?: string
      cellExpanded?: string
    }
  | {
      type: 'permission_request'
      id: string
      name: string
      input: unknown
      preview?: {
        added: number
        removed: number
        paths: string[]
        summaryText: string
        unifiedPreview?: string
      }
    }
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean; status?: import('../../shared/src/index.ts').HookRunStatus }
  | { type: 'permission_decision'; mode: string; behavior: string; reason: string }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | {
      type: 'mcp_list_changed'
      server: string
      kind: 'tools' | 'resources' | 'prompts'
      toolCount: number
      resourceCount: number
      promptCount: number
    }
  | {
      type: 'ptl_retry'
      attempt: number
      maxRetries: number
      droppedMessageCount: number
    }
  | {
      type: 'model_retry'
      attempt: number
      maxRetries: number
      delayMs: number
      message: string
      reason: string
      status?: number
    }
  | {
      type: 'control'
      kind: 'steer'
      controlId: string
      boundary: import('./sessionCoordinator.ts').SessionSafeBoundary
      prompt: string
    }
  | {
      type: 'background_result'
      taskId: string
      status: import('./subagent.ts').BackgroundAgentStatus
      boundary: import('./sessionCoordinator.ts').SessionSafeBoundary
    }
  | { type: 'done'; terminal?: Terminal }

export type SessionSystemPromptOptions = Omit<
  AssembleSessionSystemPromptOptions,
  'cwd'
>

export type CreateSessionOptions = {
  cwd: string
  sessionId?: string
  /**
   * DR2A：session runner ownership domain。
   * 默认使用进程级 coordinator；嵌入方/测试可显式隔离。
   */
  coordinator?: SessionCoordinator
  hooks?: HooksConfig
  provider?: LlmProvider
  deps?: QueryDeps
  /** 对照 HC PermissionMode；默认 default（请求批准） */
  permissionMode?: PermissionMode
  askPermission?: AskPermissionFn
  /** 会话 Always-allow 规则；默认空表 */
  permissionRules?: SessionPermissionRules
  /**
   * 会话 effort 档位（/effort）；可选。
   * resume 时由快照恢复。
   */
  effortLevel?: string
  /**
   * CX8 ultrathink 会话模式；可选。默认 off（或由 config/env 在 workspace 入口注入）。
   */
  ultrathinkMode?: import('./ultrathink.ts').UltrathinkMode
  /**
   * 是否在 CLI 显示思考链（/thinking）；默认 true。
   * resume 时由快照恢复；仅影响渲染，不影响 provider 解析。
   */
  showThinking?: boolean
  /**
   * 是否把本轮 reasoning 写入 assistant.reasoning_content 供 openai-compatible 回灌。
   * 默认 false（安全）；DeepSeek 等需要时可 session 打开。
   * **不**用于 Anthropic 签名 thinking 块。
   */
  persistReasoning?: boolean
  /**
   * 会话本地 token 累计种子；默认全 0。
   * resume 时由快照恢复（无遥测）。
   */
  usage?: SessionUsage
  /** tool_result 写入 transcript 的字符上限；默认 50_000 */
  maxToolResultChars?: number
  compactSummarizer?: CompactSummarizer
  /** 会话 skill 全文表；默认不进 system，仅 Skill 工具按需加载 */
  skills?: LoadedSkill[]
  /**
   * 是否组装默认 system（身份/环境/BOLO.md/skill catalog）。
   * 默认 true。smoke 可关以保持最短 mock 路径。
   */
  systemPrompt?: boolean | SessionSystemPromptOptions
  /**
   * 是否在 queryLoop 的 prepareMessages 挂 auto compact（对照参考 autoCompactIfNeeded）。
   * 需同时注入 compactSummarizer；默认 **true**（与 DEFAULT_CONFIG 一致）。
   * 环境变量 `BOLO_DISABLE_AUTO_COMPACT` / `BOLO_DISABLE_COMPACT` 可熔断 auto。
   */
  autoCompactEnabled?: boolean
  /** 模型上下文窗口估计（tokens），用于 auto 阈值；默认 128_000 */
  contextWindowTokens?: number
  /** CTX-2：active provider/model 的统一上下文与输出元数据 */
  resolvedModel?: ResolvedModelMetadata
  /** workspace 顶层旧字段，仅供后续热切 resolver fallback */
  legacyContextWindowTokens?: number
  /**
   * Microcompact（清旧 tool_result，无 LLM）。
   * 默认启用；`false` 关闭。顺序：snip → micro → auto full。
   */
  microcompact?: MicrocompactOptions | false
  /**
   * Snip（无 LLM，丢过旧前缀，保留尾部）。
   * 默认启用；`false` 关闭。在 micro / auto 之前。
   */
  snip?: SnipOptions | false
  /**
   * callModel / compact summarizer 命中 PTL 时截断重试次数。
   * 默认 3；0 = 关闭。
   */
  maxPtlRetries?: number
  /**
   * CMP-1：压缩摘要专用模型（可选）。缺省用会话 provider。
   * 必须是当前 provider 认识的模型名。
   */
  compactModel?: string
  /**
   * CMP-1：压缩摘要生成墙钟预算（毫秒，可选）。缺省不设限。
   * 超预算时压缩失败回退（保留旧历史）并 warning。
   */
  compactTimeoutMs?: number
  /** HKP-3：初始 plan 正交开关（默认 false；/plan 激活） */
  planMode?: boolean
  /** MEM-1：首轮 memory 相关性检索查询（显式传入；缺省无相关性检索） */
  memoryRelevanceQuery?: string
  /** 模型名（写入环境段；可从 workspace 传入） */
  model?: string
  /**
   * P 轨：多 provider 注册表（热切 /provider use）。
   * createSessionFromWorkspace 自动注入。
   */
  providerRegistry?: ProviderRegistry
  /** 当前 active profile id */
  providerId?: string
  /** active profile 快照 */
  providerProfile?: ProviderProfile
  /** E 轨：effort 方言（来自 profile 或显式） */
  effortDialect?: string | Record<string, unknown>
  source?: SessionStartSource
  onEvent?: (e: SessionEvent) => void
  /**
   * 预创建 prompt-cache 观测状态；默认 createPromptCacheSessionState()。
   */
  promptCacheState?: import('../../compact/src/index.ts').PromptCacheSessionState
  /**
   * 预加载的 active agent 定义（内置 + 目录）。
   * 未传时 createSession 会按 cwd 调 loadAgentsDir。
   */
  agentDefinitions?: ActiveAgentDefinitions
  /**
   * Subagent 全局策略（Spec v0）。未传则 defaultAgentPolicy() + env。
   */
  agentPolicy?: import('./subagent.ts').AgentPolicy
  /**
   * 每轮 submitPrompt 结束后自动 saveSession。
   * true = user-level workspace scope；或传 { scope, sessionsDir, filePath }。
   */
  autoSave?: boolean | {
    scope?: SessionScope
    sessionsDir?: string
    filePath?: string
  }
}

export type BoloSession = {
  id: string
  cwd: string
  phase: SessionPhase
  messages: ChatMessage[]
  /** DR2A：本 session 的唯一 runner owner。 */
  coordinator: SessionCoordinator
  /** DR0：由 transcript `turn` entries 投影；不进入模型 messages。 */
  durableTurns: DurableTurnRecord[]
  /** DR2C：由 transcript `control` entries 投影；不重建 coordinator queue。 */
  durableControls: DurableControlRecord[]
  /** DR3A：由 transcript task/task_result entries 投影；不自动重启 worker。 */
  durableTasks: DurableTaskRecord[]
  /** DR4B2：由 transcript resolution entries 投影；不删除原 lifecycle。 */
  durableResolutions: DurableResolutionRecord[]
  /** OUT-3：工具展示 side-channel；不进入 provider messages/snapshot。 */
  toolPresentations: Map<string, ToolPresentation>
  /**
   * 权威 system 段（对照 HC systemPrompt）。
   * callModel 时由 prepareModelMessages 前缀；对话历史尽量不混入 system。
   */
  systemPromptSections: string[]
  /**
   * 组装 system 时的 userConfigDir（测试/覆盖）；
   * submitPrompt path-scope 刷新 rules 时透传。
   */
  systemPromptUserConfigDir?: string
  /** HKP-3：plan 正交开关（true = 规划态，任何权限模式下强制只读） */
  planMode?: boolean
  /** 是否在 submitPrompt 时按 activePaths 重装 path-scoped rules。
   * 默认 true；createSession(systemPrompt:false) 或显式 loadRules:false 时为 false。
   */
  refreshPathScopedRules?: boolean
  hooks: HooksConfig
  provider: LlmProvider
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  /**
   * CMP-1：压缩摘要专用模型；wire summarizer 时使用。
   */
  compactModel?: string
  /**
   * CMP-1：压缩摘要生成墙钟预算（毫秒）；runSessionCompact 传给 runFullCompact。
   */
  compactTimeoutMs?: number
  /**
   * AR-T3+：AskUserQuestion 的提问句柄（CLI picker / Desktop 对话框各注入一个）。
   *
   * 与 `askPermission` 有意不同：**没有 fail-closed 的默认实现，缺省就是 undefined。**
   * 权限的默认 `deny` 是一个有意义的答复（不许），而「问题」没有对应的默认答复——
   * 编一个就等于替用户表态。工具据 undefined 返回 `unavailable`，
   * 让模型带着显式假设继续，而不是等一个永远不会来的回答。
   */
  askUserQuestion?: import('../../tools/src/index.ts').AskUserQuestionAskerRef
  /** 会话 Always-allow（/allow 与 CLI `a`） */
  permissionRules: SessionPermissionRules
  /**
   * auto 模式状态（熔断 / lastReason）；mode=auto 时使用。
   */
  autoModeState?: AutoModeState
  /**
   * auto 分类器；默认由 provider.completeText 注入（Y2）。
   */
  classifyPermission?: AutoClassifyFn
  /** tool_result 字符预算（C6） */
  maxToolResultChars: number
  compactSummarizer?: CompactSummarizer
  /** MEM-1：压缩前 flush 最近消息总结到 user memory daily log（默认 true） */
  flushMemoryOnCompact?: boolean
  /** MEM-1：上次成功 flush 的消息块指纹（会话内去重锚点） */
  memoryFlushedHash?: string
  skills: LoadedSkill[]
  model?: string
  /**
   * P 轨：命名 provider 注册表；`/provider use` 热切。
   */
  providerRegistry?: ProviderRegistry
  /** 当前 active profile id（非 LlmProvider.id 协议 kind） */
  providerId?: string
  providerProfile?: ProviderProfile
  /**
   * E 轨：effort 方言 id / 内联（/effort 预览 · 与 provider 配置对齐）。
   */
  effortDialect?: string | Record<string, unknown>
  /**
   * 会话级 effort 档位（/effort）。
   * 经 callModel → completeStream options.effort → 方言 wire（或 max_tokens fallback）。
   * `undefined` 视为 auto。
   */
  effortLevel?: string
  /**
   * Web search 意图（on|off|auto）。缺省 `auto`：hosted 两轨据此默认开
   * （搜索在用户已在对话的 provider 侧执行，无新增第三方接收方），
   * 其余轨由方言表各自判断。厂商 wire 片段不在这里，在 webSearchDialect 表。
   */
  webSearch?: import('../../providers/src/index.ts').WebSearchIntent
  /**
   * CX8 ultrathink 模式（会话覆盖；默认 off）。
   * 见 packages/core/src/ultrathink.ts · docs/PROVIDER_UX.md
   */
  ultrathinkMode?: import('./ultrathink.ts').UltrathinkMode
  /**
   * 是否在 CLI 渲染思考链（/thinking）。默认 true。
   * false 时 provider 仍解析并转发 reasoning 事件，仅打印机不渲染。
   */
  showThinking?: boolean
  /**
   * 是否把本轮 reasoning 写入 assistant.reasoning_content（openai-compatible 回灌）。
   * 默认 false。DeepSeek 等可开；**勿**用于 Anthropic 签名 thinking。
   */
  persistReasoning?: boolean
  /** 会话级 auto compact 开关（prepareMessages） */
  autoCompactEnabled: boolean
  /** CTX-2：active provider/model 的 runtime 真源 */
  resolvedModel: ResolvedModelMetadata
  /** 兼容投影；新 consumer 应优先读 resolvedModel */
  contextWindowTokens: number
  /** provider output baseline 的兼容/runtime 投影 */
  maxOutputTokens: number
  /** workspace 顶层旧字段，仅供热切解析，不进入用户展示 */
  legacyContextWindowTokens?: number
  /** PTL 截断重试上限；0 = 关 */
  maxPtlRetries: number
  /**
   * 会话内本地 token 累计（/cost）；无遥测。
   * 有 provider usage 事件则累加，否则 chars/4 估算。
   */
  usage?: SessionUsage
  /**
   * 本地 prompt-cache 布局/TTL 观测（F-C6）；非厂商账单。
   */
  promptCacheState?: import('../../compact/src/index.ts').PromptCacheSessionState
  /**
   * 会话墙钟起点（ms epoch）；/cost 显示 wall duration。
   */
  sessionStartedAtMs?: number
  /**
   * 本会话文件改动 log（Edit/Write/apply_patch）；/diff 读取。
   * 摘要可经 transcript file_diff 在 resume 后恢复（无 hunk lines）。
   */
  fileDiffLog?: import('./fileDiffLog.ts').FileChangeRecord[]
  /**
   * 用户 turn 序号；submitPrompt 成功入队 user message 前递增，写入 fileDiffLog。
   */
  diffTurn?: number
  /**
   * D6：file_diff 摘要落盘回调（createSession/submit 注入）。
   */
  onFileDiffRecord?: (
    rec: import('./fileDiffLog.ts').FileChangeRecord,
  ) => void | Promise<void>
  /**
   * H5：最近 hook 运行诊断（失败/timeout/block/updatedInput）。
   * /hooks recent 读取；无遥测。
   */
  hookDiagLog?: import('./hookDiag.ts').HookDiagLog
  /**
   * C3：queryLoop mid-turn auto compact 钩子（createSession 注入）。
   */
  tryMidTurnCompact?: () => Promise<boolean>
  /**
   * C4：compact 成功后刷新短 skill catalog 段；默认 true。
   */
  postCompactReinjection?: boolean
  /**
   * C5：最近一次成功 compact 的本地摘要（/context；无遥测）。
   */
  lastCompact?: {
    at: string
    trigger: 'manual' | 'auto'
    summaryChars: number
    messagesAfter: number
  }
  /**
   * 会话工具表（内置 + Agent + 可选 MCP）。
   * 未设置时 submitPrompt 回落 createDefaultTools()。
   */
  tools?: BoloTool[]
  /**
   * 活跃 subagent 定义（内置 + ~/.bolo/agents + .bolo/agents）。
   * Agent 工具 / spawnSubagent 按此 resolve。
   */
  agentDefinitions?: ActiveAgentDefinitions
  /**
   * Subagent 全局策略（enabled / maxConcurrent / maxSpawnDepth / defaults）。
   */
  agentPolicy?: import('./subagent.ts').AgentPolicy
  /**
   * 后台 subagent 表（Agent run_in_background）。
   * pendingAgents + backgroundAgentResults；/agents status · /bg 读取。
   */
  backgroundAgents?: import('./subagent.ts').BackgroundAgentStore
  /**
   * AR-T1：会话待办表（TodoWrite）。
   * **不进 messages** —— 因此不被 compact 改写；由 core 周期性以
   * `<todo_reminder>` 块重新注入，并经 transcript `todo` entry 落盘/resume。
   */
  todos?: import('../../shared/src/index.ts').TodoItem[]
  /**
   * AR-T1：todo 写入后的落盘回调（createSession/submit 注入）。
   * 与 onFileDiffRecord 同构；失败不得改变工具语义。
   */
  onTodoWrite?: (
    application: import('../../shared/src/index.ts').TodoWriteApplication,
  ) => void | Promise<void>
  /**
   * AR-T2：后台 shell 注册表（Bash run_in_background）。
   * 进程跨 turn 存活；endSession 与 process exit 时统一收尸，绝不越过会话。
   */
  backgroundShells?: import('../../shared/src/index.ts').BackgroundShellStore
  /** 已连接的 MCP stdio 进程；endSession 时关闭 */
  mcpConnections?: ConnectedMcpServer[]
  /**
   * M-GEN-2：MCP 配置 warnings + 连接失败项（/mcp · /doctor）。
   */
  mcpDiagnostics?: {
    configWarnings?: string[]
    failures?: Array<{
      name: string
      transport?: string
      error: string
      endpointSummary?: string
    }>
  }
  /**
   * workspace 发现的插件列表（PL1/PL2）；供 /plugins。
   * PL2：`/plugins reload` 可热刷新列表与贡献点。
   */
  plugins?: LoadedPlugin[]
  /**
   * 插件贡献的 slash 命令（PL2；contributes.commands / commands/*.md）。
   * 内置 slash 优先；未知名再查此表。
   */
  pluginCommands?: PluginCommand[]
  /**
   * 最近一次 workspace 装载的 merge 错误（插件 hooks/mcp/command 冲突等）。
   * 供 /plugins reload 文案；不写遥测。
   */
  pluginMergeErrors?: string[]
  onEvent: (e: SessionEvent) => void
}

function emit(session: BoloSession, e: SessionEvent) {
  session.onEvent(e)
  if (e.type === 'phase' && isSessionPhase(e.phase)) {
    session.phase = e.phase
  }
}

function isSessionPhase(p: string): p is SessionPhase {
  return (
    p === 'idle' ||
    p === 'starting' ||
    p === 'ready' ||
    p === 'running' ||
    p === 'awaiting_permission' ||
    p === 'compacting' ||
    p === 'stopping' ||
    p === 'ended'
  )
}

function setPhase(session: BoloSession, phase: SessionPhase) {
  emit(session, { type: 'phase', phase })
}

function recordSessionHookDiag(
  session: BoloSession,
  event: string,
  agg: {
    results: Array<{
      exitCode: number
      stderr?: string
      blocked?: boolean
      timedOut?: boolean
      aborted?: boolean
      updatedInput?: unknown
    }>
    blockReason?: string
  },
) {
  try {
    for (const e of diagEntriesFromHookRun({
      event,
      results: agg.results,
      blockReason: agg.blockReason,
    })) {
      session.hookDiagLog = appendHookDiag(session.hookDiagLog, e)
    }
  } catch {
    /* ignore */
  }
}

function mapLoopEvent(session: BoloSession, e: QueryLoopEvent) {
  if (e.type === 'phase') {
    emit(session, { type: 'phase', phase: e.phase })
    return
  }
  if (e.type === 'done') {
    emit(session, { type: 'done', terminal: e.terminal })
    return
  }
  if (e.type === 'tool_end' && e.presentation) {
    session.toolPresentations.set(
      e.id,
      structuredClone(e.presentation),
    )
  }
  emit(session, e as SessionEvent)
}

export async function createSession(opts: CreateSessionOptions): Promise<BoloSession> {
  const provider = opts.provider ?? createMockProvider()
  const permissionMode = parsePermissionMode(opts.permissionMode, 'default')
  const skills = opts.skills ?? []
  const directProfile =
    opts.contextWindowTokens !== undefined
      ? {
          ...opts.providerProfile,
          contextWindowTokens: opts.contextWindowTokens,
        }
      : opts.providerProfile
  const resolvedModel =
    opts.resolvedModel ??
    resolveModelMetadata({
      providerId:
        opts.providerId ??
        opts.providerProfile?.id ??
        String(provider.id || 'default'),
      model: opts.model ?? opts.providerProfile?.model,
      profile: directProfile,
      legacyContextWindowTokens: opts.legacyContextWindowTokens,
    })
  const contextWindowTokens =
    opts.contextWindowTokens ?? resolvedModel.contextWindowTokens
  const effectiveResolvedModel =
    contextWindowTokens === resolvedModel.contextWindowTokens
      ? resolvedModel
      : {
          ...resolvedModel,
          contextWindowTokens,
          maxOutputTokens: Math.min(
            resolvedModel.maxOutputTokens,
            contextWindowTokens,
          ),
          sources: {
            ...resolvedModel.sources,
            contextWindow: 'legacy' as const,
          },
        }

  let systemPromptSections: string[] = []
  let systemPromptUserConfigDir: string | undefined
  let refreshPathScopedRules = false
  if (opts.systemPrompt !== false) {
    const extra: SessionSystemPromptOptions =
      typeof opts.systemPrompt === 'object' && opts.systemPrompt
        ? opts.systemPrompt
        : {}
    systemPromptUserConfigDir = extra.userConfigDir
    // 默认装载 rules 且非 custom/override 时，submitPrompt 可按 activePaths 刷新 path-scope
    refreshPathScopedRules =
      extra.loadRules !== false &&
      !extra.overrideSystemPrompt &&
      !extra.customSystemPrompt
    systemPromptSections = await assembleSessionSystemPrompt({
      cwd: opts.cwd,
      permissionMode,
      // HKP-3：plan 正交开关注入 Environment（模型可见只读约束）
      planMode: opts.planMode === true,
      model: opts.model ?? extra.model,
      skills: extra.skills ?? skills,
      skillCatalog: extra.skillCatalog,
      contextWindowTokens: effectiveResolvedModel.contextWindowTokens,
      boloMd: extra.boloMd,
      loadInstructions: extra.loadInstructions,
      boloRules: extra.boloRules,
      loadRules: extra.loadRules,
      userConfigDir: extra.userConfigDir,
      activePaths: extra.activePaths,
      mcpPlaceholder: extra.mcpPlaceholder,
      overrideSystemPrompt: extra.overrideSystemPrompt,
      customSystemPrompt: extra.customSystemPrompt,
      appendSystemPrompt: extra.appendSystemPrompt,
      date: extra.date,
      platform: extra.platform,
      shellHint: extra.shellHint,
      memoryRelevanceQuery: opts.memoryRelevanceQuery,
    })
  }

  const agentDefinitions =
    opts.agentDefinitions ??
    (await loadAgentsDir({ cwd: opts.cwd })).active

  const agentPolicy =
    opts.agentPolicy ??
    resolveAgentPolicy(undefined)

  const session: BoloSession = {
    id: opts.sessionId ?? newId('sess'),
    cwd: opts.cwd,
    phase: 'idle',
    messages: [],
    coordinator: opts.coordinator ?? defaultSessionCoordinator,
    systemPromptSections,
    systemPromptUserConfigDir,
    refreshPathScopedRules,
    hooks: opts.hooks ?? {},
    provider,
    deps: opts.deps ?? productionDeps(provider),
    permissionMode,
    // smoke 可注入；default 模式下 ask 会走到这里。未注入则 deny 更安全；
    // 测试/smoke 显式传 allow。
    askPermission: opts.askPermission ?? (async () => 'deny'),
    permissionRules: opts.permissionRules ?? createEmptyPermissionRules(),
    autoModeState: createAutoModeState('deny'),
    classifyPermission: (() => {
      const p = provider
      if (p.completeText) {
        return createAutoClassifyFromCompleteText(
          (messages, o) => p.completeText!(messages, o),
          { model: opts.model },
        )
      }
      return undefined
    })(),
    maxToolResultChars: opts.maxToolResultChars ?? 50_000,
    compactSummarizer: opts.compactSummarizer,
    skills,
    model: opts.model,
    providerRegistry: opts.providerRegistry,
    providerId: opts.providerId,
    providerProfile: opts.providerProfile,
    effortDialect:
      opts.effortDialect ??
      opts.providerProfile?.effortDialect,
    effortLevel:
      typeof opts.effortLevel === 'string' && opts.effortLevel.trim()
        ? opts.effortLevel.trim()
        : undefined,
    ultrathinkMode: (() => {
      const m = normalizeUltrathinkMode(
        typeof opts.ultrathinkMode === 'string' ? opts.ultrathinkMode : undefined,
      )
      // 仅会话显式传入；config/env 在 createSessionFromWorkspace 注入
      return m
    })(),
    showThinking: opts.showThinking === false ? false : true,
    persistReasoning: opts.persistReasoning === true,
    // 默认开 auto（对照参考全局 config）；显式 false 关闭
    autoCompactEnabled: opts.autoCompactEnabled !== false,
    resolvedModel: effectiveResolvedModel,
    contextWindowTokens: effectiveResolvedModel.contextWindowTokens,
    maxOutputTokens: effectiveResolvedModel.maxOutputTokens,
    legacyContextWindowTokens:
      'legacyContextWindowTokens' in opts
        ? opts.legacyContextWindowTokens
        : opts.contextWindowTokens,
    maxPtlRetries:
      opts.maxPtlRetries === undefined
        ? 3
        : Math.max(0, opts.maxPtlRetries),
    ...(opts.planMode !== undefined
      ? { planMode: opts.planMode === true }
      : {}),
    ...(opts.compactModel !== undefined
      ? { compactModel: opts.compactModel }
      : {}),
    ...(opts.compactTimeoutMs !== undefined
      ? { compactTimeoutMs: opts.compactTimeoutMs }
      : {}),
    agentDefinitions,
    agentPolicy,
    backgroundAgents: createBackgroundAgentStore({
      maxConcurrent: agentPolicy.maxConcurrent,
    }),
    tools: createDefaultTools(agentDefinitions, { agentPolicy }),
    usage: opts.usage
      ? cloneSessionUsage(opts.usage)
      : createEmptySessionUsage(),
    promptCacheState:
      opts.promptCacheState ?? createPromptCacheSessionState(),
    sessionStartedAtMs: Date.now(),
    webSearch: 'auto',
    todos: [],
    backgroundShells: createBackgroundShellStore(),
    fileDiffLog: [],
    diffTurn: 0,
    durableTurns: [],
    durableControls: [],
    durableTasks: [],
    durableResolutions: [],
    toolPresentations: new Map(),
    hookDiagLog: createHookDiagLog(),
    postCompactReinjection: true,
    onEvent: opts.onEvent ?? (() => {}),
  }

  if (session.backgroundAgents) {
    session.backgroundAgents.durableLifecycle =
      createSessionBackgroundTaskLifecycle(session)
  }

  session.tryMidTurnCompact = async () => {
    // C3：仅 auto 开 + 有 summarizer 时尝试；阈值/熔断由 shouldAutoCompact 判断
    if (!session.autoCompactEnabled || !session.compactSummarizer) {
      return false
    }
    if (isAutoCompactEnvDisabled()) return false
    const estimate = estimateTokens(session.messages)
    // AR2A0a：优先混合锚；无锚回退 C2 usage / estimate
    const anchor = getSessionUsageAnchor(session)
    const usage = anchor
      ? undefined
      : (session.usage?.lastCall?.inputTokens ??
        (session.usage && session.usage.inputTokens > 0
          ? session.usage.inputTokens
          : undefined))
    if (
      !shouldAutoCompact({
        tokenCount: estimate,
        usageInputTokens: usage,
        ...(anchor ? { anchor, messages: session.messages, pad: true } : {}),
        contextWindowTokens: session.resolvedModel.contextWindowTokens,
        enabled: true,
        consecutiveFailures: 0,
        querySource: 'repl_main_thread',
      })
    ) {
      return false
    }
    const r = await compactSession(session, { trigger: 'auto' })
    return r.ok === true
  }

  session.onFileDiffRecord = async (rec) => {
    try {
      await appendSessionFileDiff(session, rec)
    } catch {
      /* 落盘失败不拖垮 */
    }
  }

  session.onTodoWrite = async (application) => {
    try {
      await appendSessionTodos(session, application.stored)
    } catch {
      /* 落盘失败不拖垮；表仍在内存里有效 */
    }
  }

  // 对照参考 query：snip → microcompact → autocompact → callModel
  const microOpts: MicrocompactOptions | undefined =
    opts.microcompact === false
      ? { enabled: false }
      : opts.microcompact === undefined
        ? undefined
        : opts.microcompact
  const snipOpts: SnipOptions | false | undefined =
    opts.snip === false
      ? false
      : opts.snip === undefined
        ? undefined
        : opts.snip

  if (session.autoCompactEnabled && session.compactSummarizer) {
    wireSessionPrepareMessages(session, {
      microcompact: microOpts,
      snip: snipOpts,
    })
  } else if (opts.deps) {
    // 自定义 deps：在其 prepare 前挂 snip → micro（便宜、幂等）
    const snipPrepare = createSnipPrepare(snipOpts)
    const microPrepare = createMicrocompactPrepare(microOpts)
    session.deps = {
      ...session.deps,
      prepareMessages: composePrepareMessages(
        snipPrepare,
        microPrepare,
        opts.deps.prepareMessages,
      ),
    }
  } else if (
    opts.microcompact === false ||
    opts.microcompact !== undefined ||
    opts.snip === false ||
    opts.snip !== undefined
  ) {
    // 覆盖 productionDeps 默认 snip/micro 配置
    session.deps = {
      ...session.deps,
      prepareMessages: composePrepareMessages(
        createSnipPrepare(snipOpts),
        createMicrocompactPrepare(microOpts),
      ),
    }
  } else if (session.autoCompactEnabled && !session.compactSummarizer) {
    // 默认 auto 开但无 summarizer：仍 snip → micro（productionDeps 默认）
  }
  // 否则：productionDeps 已默认 snip → micro

  if (opts.autoSave) {
    const as =
      opts.autoSave === true
        ? { scope: 'workspace' as SessionScope }
        : opts.autoSave
    setSessionPersistMeta(session, {
      autoSave: true,
      scope: as.scope ?? 'workspace',
      sessionsDir: as.sessionsDir,
      filePath: as.filePath,
    })
  }

  setPhase(session, 'starting')
  const start = await runHooks(
    'SessionStart',
    {
      hook_event_name: 'SessionStart',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      source: opts.source ?? 'startup',
    },
    session.hooks,
  )
  for (const r of start.results) {
    emit(session, { type: 'hook', event: 'SessionStart', exitCode: r.exitCode })
  }
  recordSessionHookDiag(session, 'SessionStart', start)
  // SessionStart 注入作为额外 system 段（不混进对话 user/assistant）
  if (start.injectText?.trim()) {
    session.systemPromptSections = [
      ...session.systemPromptSections,
      start.injectText.trim(),
    ]
  }
  setPhase(session, 'ready')
  return session
}

export type CreateSessionFromWorkspaceOptions = {
  cwd: string
  /** Create user-level state before loading; project `.bolo` stays read-only. */
  materializeUserState?: boolean
  askPermission?: AskPermissionFn
  onEvent?: (e: SessionEvent) => void
  source?: SessionStartSource
  wireCompactSummarizer?: boolean
  /**
   * 是否把 skill catalog 并入 system（默认 true）。
   * skills 全文表始终挂 session.skills 供 Skill 工具使用。
   */
  injectSkills?: boolean
  /** 是否组装 system（默认 true） */
  systemPrompt?: boolean
  /** 覆盖 workspace.config.autoCompactEnabled */
  autoCompactEnabled?: boolean
  /** 覆盖 workspace.config.contextWindowTokens */
  contextWindowTokens?: number
  /** 覆盖 workspace.config.microcompactEnabled；或传入完整 MicrocompactOptions */
  microcompact?: MicrocompactOptions | false
  /** 覆盖 workspace.config.maxPtlRetries */
  maxPtlRetries?: number
  /** CMP-1：覆盖 workspace.config.compactModel */
  compactModel?: string
  /** CMP-1：覆盖 workspace.config.compactTimeoutMs */
  compactTimeoutMs?: number
  /**
   * CX8：覆盖 ultrathink 模式（session > env > config）。
   */
  ultrathinkMode?: UltrathinkMode | string
  /**
   * 是否连接 workspace.mcpServers（stdio listTools → 注册 mcp__*）。
   * 默认 true；失败只 warn，不炸会话。
   */
  connectMcp?: boolean
  /** MCP 单请求超时（ms） */
  mcpTimeoutMs?: number
}

type WorkspaceSessionMode = 'create' | 'resume'

function resolveWorkspaceUltrathinkMode(
  workspace: ResolvedWorkspace,
  explicit?: UltrathinkMode | string,
): UltrathinkMode | undefined {
  if (explicit != null) {
    return normalizeUltrathinkMode(String(explicit)) ?? undefined
  }
  const mode = resolveUltrathinkMode({
    configMode:
      typeof workspace.config.ultrathink === 'string'
        ? workspace.config.ultrathink
        : undefined,
  })
  return mode === 'off' ? undefined : mode
}

/**
 * new/resume 共用的 workspace → createSession 契约。
 * resume 的 runtime model metadata 先来自当前 workspace，再原子重放快照身份；
 * messages、权限与其它会话态仍由快照恢复。
 */
function buildWorkspaceSessionOptions(
  workspace: ResolvedWorkspace,
  opts: CreateSessionFromWorkspaceOptions,
  mode: WorkspaceSessionMode,
): CreateSessionOptions {
  const injectSkills = opts.injectSkills !== false
  const autoCompactEnabled =
    opts.autoCompactEnabled ??
    (mode === 'create'
      ? workspace.config.autoCompactEnabled !== false
      : undefined)
  const contextWindowTokens =
    opts.contextWindowTokens ?? workspace.resolvedModel.contextWindowTokens
  const maxPtlRetries =
    opts.maxPtlRetries ??
    (mode === 'create' ? workspace.config.maxPtlRetries : undefined)
  const compactModel =
    opts.compactModel ?? workspace.config.compactModel
  const compactTimeoutMs =
    opts.compactTimeoutMs ?? workspace.config.compactTimeoutMs

  return {
    cwd: opts.cwd,
    provider: workspace.provider,
    hooks: workspace.hooks,
    permissionMode: workspace.permissionMode,
    askPermission: opts.askPermission,
    compactSummarizer:
      opts.wireCompactSummarizer === false
        ? undefined
        : createCompactSummarizerFromProvider(
            workspace.provider,
            compactModel !== undefined && compactModel.trim()
              ? { model: compactModel.trim() }
              : undefined,
          ),
    skills: workspace.skills,
    ...(workspace.providerModel
      ? { model: workspace.providerModel }
      : {}),
    providerRegistry: workspace.providerRegistry,
    providerId: workspace.providerId,
    providerProfile: workspace.providerProfile,
    resolvedModel: workspace.resolvedModel,
    legacyContextWindowTokens: workspace.legacyContextWindowTokens,
    effortDialect: workspace.providerProfile?.effortDialect,
    ultrathinkMode: resolveWorkspaceUltrathinkMode(
      workspace,
      opts.ultrathinkMode,
    ),
    source: opts.source,
    onEvent: opts.onEvent,
    agentPolicy: resolveAgentPolicy(workspace.config.agents),
    ...(autoCompactEnabled !== undefined ? { autoCompactEnabled } : {}),
    ...(compactModel !== undefined ? { compactModel } : {}),
    ...(compactTimeoutMs !== undefined ? { compactTimeoutMs } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    microcompact:
      opts.microcompact !== undefined
        ? opts.microcompact
        : workspace.config.microcompactEnabled === false
          ? false
          : undefined,
    ...(maxPtlRetries !== undefined ? { maxPtlRetries } : {}),
    systemPrompt:
      opts.systemPrompt === false
        ? false
        : {
            skills: injectSkills ? workspace.skills : [],
            ...(workspace.providerModel
              ? { model: workspace.providerModel }
              : {}),
            permissionMode: workspace.permissionMode,
          },
  }
}

async function attachWorkspaceRuntime(
  session: BoloSession,
  workspace: ResolvedWorkspace,
  opts: Pick<
    CreateSessionFromWorkspaceOptions,
    'connectMcp' | 'mcpTimeoutMs'
  >,
): Promise<ConnectMcpResult | undefined> {
  session.skills = workspace.skills
  session.hooks = workspace.hooks
  session.plugins = workspace.plugins
  session.pluginCommands = workspace.pluginMerge?.commands ?? []
  session.pluginMergeErrors = workspace.pluginMerge?.errors?.length
    ? [...workspace.pluginMerge.errors]
    : undefined
  if (workspace.providerRegistry && !session.providerRegistry) {
    attachProviderRegistry(
      session,
      workspace.providerRegistry,
      session.providerId ?? workspace.providerId,
    )
  }

  for (const warning of workspace.configWarnings ?? []) {
    emit(session, { type: 'warning', message: warning })
  }
  attachWorkspaceSearchTool(session, workspace)

  let mcp: ConnectMcpResult | undefined
  if (workspace.mcpConfigWarnings?.length) {
    for (const warning of workspace.mcpConfigWarnings) {
      emit(session, { type: 'warning', message: warning })
      // eslint-disable-next-line no-console
      console.warn(`[bolo mcp] ${warning}`)
    }
    session.mcpDiagnostics = {
      configWarnings: [...workspace.mcpConfigWarnings],
    }
  }
  if (opts.connectMcp !== false && workspace.mcpServers.length > 0) {
    mcp = await connectMcpServers({
      servers: workspace.mcpServers,
      cwd: session.cwd,
      timeoutMs: opts.mcpTimeoutMs,
      onListChanged: async (event: McpListChangedEvent) => {
        if (session.mcpConnections?.length) {
          session.tools = mergeSessionToolsWithMcp(
            session.tools,
            session.mcpConnections,
          )
        }
        emit(session, {
          type: 'mcp_list_changed',
          server: event.server,
          kind: event.kind,
          toolCount: event.tools.length,
          resourceCount: event.resources.length,
          promptCount: event.prompts.length,
        })
      },
    })
    for (const warning of mcp.warnings) {
      emit(session, { type: 'warning', message: warning })
      // eslint-disable-next-line no-console
      console.warn(`[bolo mcp] ${warning}`)
    }
    session.mcpDiagnostics = {
      ...(session.mcpDiagnostics?.configWarnings?.length
        ? { configWarnings: session.mcpDiagnostics.configWarnings }
        : workspace.mcpConfigWarnings?.length
          ? { configWarnings: [...workspace.mcpConfigWarnings] }
          : {}),
      ...(mcp.failures?.length ? { failures: [...mcp.failures] } : {}),
    }
    if (mcp.servers.length > 0) {
      session.mcpConnections = mcp.servers
    }
    if (mcp.tools.length > 0) {
      session.tools = [
        ...(session.tools ??
          createDefaultTools(session.agentDefinitions, {
            agentPolicy: session.agentPolicy,
          })),
        ...mcp.tools,
      ]
    }
  }
  return mcp
}

function attachWorkspaceSearchTool(
  session: BoloSession,
  workspace: ResolvedWorkspace,
): void {
  const baseTools = (
    session.tools ??
    createDefaultTools(session.agentDefinitions, {
      agentPolicy: session.agentPolicy,
    })
  ).filter((tool) => tool.name !== SEARXNG_SEARCH_TOOL_NAME)
  session.tools = workspace.searxngSearch
    ? [
        ...baseTools,
        createSearxngSearchTool(workspace.searxngSearch, {
          isEnabled: () => session.webSearch !== 'off',
        }),
      ]
    : baseTools
}

/**
 * 从 ~/.bolo + 项目 .bolo 装配 Session
 * system 由 assembleSessionSystemPrompt 统一组装（含 BOLO.md + skill catalog）
 * 可选连接 MCP stdio（失败 warn 不炸会话）
 */
export async function createSessionFromWorkspace(
  opts: CreateSessionFromWorkspaceOptions,
): Promise<{
  session: BoloSession
  workspace: ResolvedWorkspace
  mcp?: ConnectMcpResult
}> {
  const workspace = await loadWorkspace({
    cwd: opts.cwd,
    materializeUserState: opts.materializeUserState,
  })

  const session = await createSession(
    buildWorkspaceSessionOptions(workspace, opts, 'create'),
  )
  const mcp = await attachWorkspaceRuntime(session, workspace, opts)

  return { session, workspace, mcp }
}

export type ReloadSessionPluginsOptions = {
  /** 默认 true：关掉旧 MCP 再按新 workspace 连接 */
  reconnectMcp?: boolean
  mcpTimeoutMs?: number
  /** 默认 true：刷新 skill catalog 段（不重建整个 system） */
  refreshSkillCatalog?: boolean
}

export type ReloadSessionPluginsResult = {
  pluginCount: number
  skillCount: number
  commandCount: number
  hookEventCount: number
  mcpServerCount: number
  mcpConnectedCount: number
  errors: string[]
  warnings: string[]
}

/**
 * PL2：会话内热加载插件贡献（对照 HC `/reload-plugins` + refreshActivePlugins 语义）。
 * - 重扫 user/project plugins + 合并 skills/hooks/mcp/commands
 * - 刷新 session.skills / hooks / plugins / pluginCommands
 * - 可选重连 MCP（默认开）：先 close 再 connect 新表
 * - 不重建 cache-stable system 前缀；仅替换 skill catalog 段
 * - 无市场、无遥测
 */
export async function reloadSessionPlugins(
  session: BoloSession,
  opts?: ReloadSessionPluginsOptions,
): Promise<ReloadSessionPluginsResult> {
  const reconnectMcp = opts?.reconnectMcp !== false
  const refreshCatalog = opts?.refreshSkillCatalog !== false
  const warnings: string[] = []

  const workspace = await loadWorkspace({
    cwd: session.cwd,
    materializeUserState: false,
  })
  for (const warning of workspace.configWarnings ?? []) {
    warnings.push(warning)
    emit(session, { type: 'warning', message: warning })
  }
  attachWorkspaceSearchTool(session, workspace)

  session.plugins = workspace.plugins
  session.skills = workspace.skills
  session.hooks = workspace.hooks
  session.pluginCommands = workspace.pluginMerge?.commands ?? []
  const errors = workspace.pluginMerge?.errors ?? []
  session.pluginMergeErrors = errors.length ? [...errors] : undefined

  if (refreshCatalog) {
    const catalog = formatSkillCatalog(workspace.skills, {
      contextWindowTokens: session.resolvedModel.contextWindowTokens,
    })
    session.systemPromptSections = replaceSkillCatalogSection(
      session.systemPromptSections,
      catalog || undefined,
    )
  }

  let mcpConnectedCount = 0
  if (reconnectMcp) {
    await closeSessionMcp(session)
    // 去掉旧 mcp 工具，保留内置（与 mergeSessionToolsWithMcp 同源）
    session.tools = (
      session.tools ??
      createDefaultTools(session.agentDefinitions, {
        agentPolicy: session.agentPolicy,
      })
    ).filter((t) => !isMcpManagedToolName(t.name))

    if (workspace.mcpServers.length > 0) {
      const mcp = await connectMcpServers({
        servers: workspace.mcpServers,
        cwd: session.cwd,
        timeoutMs: opts?.mcpTimeoutMs,
        onListChanged: async (event: McpListChangedEvent) => {
          if (session.mcpConnections?.length) {
            session.tools = mergeSessionToolsWithMcp(
              session.tools,
              session.mcpConnections,
            )
          }
          emit(session, {
            type: 'mcp_list_changed',
            server: event.server,
            kind: event.kind,
            toolCount: event.tools.length,
            resourceCount: event.resources.length,
            promptCount: event.prompts.length,
          })
        },
      })
      for (const w of mcp.warnings) {
        warnings.push(w)
        emit(session, { type: 'warning', message: w })
      }
      session.mcpDiagnostics = {
        ...(workspace.mcpConfigWarnings?.length
          ? { configWarnings: [...workspace.mcpConfigWarnings] }
          : {}),
        ...(mcp.failures?.length ? { failures: [...mcp.failures] } : {}),
      }
      if (mcp.servers.length > 0) {
        session.mcpConnections = mcp.servers
        mcpConnectedCount = mcp.servers.length
      }
      if (mcp.tools.length > 0) {
        session.tools = [
          ...(session.tools ??
            createDefaultTools(session.agentDefinitions, {
              agentPolicy: session.agentPolicy,
            })),
          ...mcp.tools,
        ]
      }
    }
  } else {
    mcpConnectedCount = session.mcpConnections?.length ?? 0
  }

  // hooks 事件数（配置侧，非运行时 handler 数）
  let hookEventCount = 0
  for (const groups of Object.values(workspace.hooks)) {
    if (Array.isArray(groups) && groups.length) hookEventCount += 1
  }

  return {
    pluginCount: workspace.plugins.length,
    skillCount: workspace.skills.length,
    commandCount: session.pluginCommands?.length ?? 0,
    hookEventCount,
    mcpServerCount: workspace.mcpServers.length,
    mcpConnectedCount,
    errors: [...errors],
    warnings,
  }
}

/** 关闭 MCP 子进程（会话结束时调用） */
export async function closeSessionMcp(session: BoloSession): Promise<void> {
  if (!session.mcpConnections?.length) return
  await closeMcpConnections(session.mcpConnections)
  session.mcpConnections = []
}

function resolveSessionTranscriptPath(session: BoloSession): string | undefined {
  try {
    const tw = getTranscriptWriteState(session)
    if (tw?.filePath?.trim()) return tw.filePath.trim()
  } catch {
    /* ignore */
  }
  try {
    const meta = getSessionPersistMeta(session)
    if (meta?.filePath?.trim()) return meta.filePath.trim()
  } catch {
    /* ignore */
  }
  return undefined
}

export type EndSessionOptions = {
  reason?: SessionEndReason | string
  signal?: AbortSignal
  /** 覆盖 SessionEnd 默认超时（秒） */
  timeoutSec?: number
  /** 结束后是否 close MCP（默认 true） */
  closeMcp?: boolean
}

/**
 * 仅跑 SessionEnd hooks（不改 phase、不关 MCP）。
 * 用于 /clear：结束「当前对话段」但仍继续同一 session id。
 */
export async function runSessionEndHooks(
  session: BoloSession,
  options?: Omit<EndSessionOptions, 'closeMcp'>,
): Promise<void> {
  const reason = options?.reason ?? 'other'
  try {
    const tp = resolveSessionTranscriptPath(session)
    const end = await runHooks(
      'SessionEnd',
      {
        hook_event_name: 'SessionEnd',
        session_id: session.id,
        cwd: session.cwd,
        timestamp: nowIso(),
        reason,
        ...(tp ? { transcript_path: tp } : {}),
      },
      session.hooks,
      {
        signal: options?.signal,
        defaultTimeoutSec: options?.timeoutSec,
      },
    )
    for (const r of end.results) {
      emit(session, {
        type: 'hook',
        event: 'SessionEnd',
        exitCode: r.exitCode,
      })
      if (r.exitCode !== 0 && r.stderr?.trim()) {
        emit(session, {
          type: 'error',
          message: `SessionEnd hook: ${r.stderr.trim().slice(0, 500)}`,
        })
      }
    }
    recordSessionHookDiag(session, 'SessionEnd', end)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit(session, {
      type: 'error',
      message: `SessionEnd hooks failed: ${message}`,
    })
  }
}

/**
 * H0：SessionEnd hooks → phase ended → 可选关 MCP。
 * 对照 HC executeSessionEndHooks / Codex run_session_end：
 * hook 失败不阻止 teardown；短超时。
 */
export async function endSession(
  session: BoloSession,
  options?: EndSessionOptions,
): Promise<void> {
  if (session.phase === 'ended') return

  setPhase(session, 'stopping')
  await runSessionEndHooks(session, options)

  // AR-T2：后台进程绝不能活过启动它的会话（防僵尸）。
  if (session.backgroundShells) {
    try {
      await killAllBackgroundShells(session.backgroundShells)
      await cleanupShellOutputDir(session.cwd, session.id)
      // ROB-3：正常结束 = 无遗留；清掉 manifest，resume 不再提醒
      await removeBackgroundShellManifest(session)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit(session, {
        type: 'error',
        message: `kill background shells on endSession: ${message}`,
      })
    }
  }

  if (options?.closeMcp !== false) {
    try {
      await closeSessionMcp(session)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit(session, {
        type: 'error',
        message: `close MCP on endSession: ${message}`,
      })
    }
  }

  setPhase(session, 'ended')
}

/**
 * 按当前 messages + 本轮输入刷新 path-scoped rules 段。
 * 仅替换 `# Project rules`（volatile）；cache-stable 前缀不动。
 * 对照 HC：触达文件时再装载 conditional paths 规则（Bolo 合入 system 段）。
 */
export async function refreshSessionPathScopedRules(
  session: BoloSession,
  opts?: { extraText?: string; activePaths?: string[] },
): Promise<string[]> {
  if (session.refreshPathScopedRules === false) {
    return session.systemPromptSections
  }
  const activePaths =
    opts?.activePaths ??
    collectActivePathsFromMessages(session.messages, opts?.extraText)
  const loaded = await loadBoloRules({
    cwd: session.cwd,
    userConfigDir: session.systemPromptUserConfigDir,
    activePaths,
  })
  session.systemPromptSections = replaceProjectRulesSection(
    session.systemPromptSections,
    loaded.text,
  )
  return session.systemPromptSections
}

/**
 * UserPromptSubmit → queryLoop（对照：用户输入处理后进入 query）
 */
function applySessionTurnState(
  session: BoloSession,
  opts: {
    turnId: string
    state: DurableTurnState
    timestamp?: string
    prompt?: string
    querySource?: string
    terminalReason?: string
    detail?: string
  },
): void {
  session.durableTurns = applyDurableTurnEvent(session.durableTurns, {
    turnId: opts.turnId,
    state: opts.state,
    timestamp: opts.timestamp ?? nowIso(),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    ...(opts.querySource ? { querySource: opts.querySource } : {}),
    ...(opts.terminalReason
      ? { terminalReason: opts.terminalReason }
      : {}),
    ...(opts.detail ? { detail: opts.detail } : {}),
  })
}

async function persistSessionTurnState(
  session: BoloSession,
  opts: {
    turnId: string
    state: DurableTurnState
    prompt?: string
    querySource?: string
    terminalReason?: string
    detail?: string
  },
): Promise<void> {
  const entry = await appendSessionTurnState(session, opts)
  applySessionTurnState(session, {
    ...opts,
    timestamp: entry?.timestamp,
  })
}

function durableStateForTerminal(terminal: Terminal): DurableTurnState {
  if (terminal.reason === 'completed') return 'completed'
  if (terminal.reason === 'aborted') return 'aborted'
  return 'error'
}

function linkAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const listeners: Array<{
    signal: AbortSignal
    listener: () => void
  }> = []
  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason)
    }
  }
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      forward(signal)
      break
    }
    const listener = () => forward(signal)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push({ signal, listener })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const row of listeners) {
        row.signal.removeEventListener('abort', row.listener)
      }
    },
  }
}

export type SubmitPromptOptions = {
  maxTurns?: number
  querySource?: string
  signal?: AbortSignal
  /** DR0：调用方提供幂等键；省略时本地生成。 */
  turnId?: string
}

export async function submitPrompt(
  session: BoloSession,
  prompt: string,
  options?: SubmitPromptOptions,
): Promise<Terminal> {
  let turnId: string
  try {
    turnId = normalizeDurableTurnId(options?.turnId ?? newId('turn'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const terminal: Terminal = { reason: 'error', detail }
    emit(session, { type: 'error', message: detail })
    emit(session, { type: 'done', terminal })
    return terminal
  }
  const existing = session.durableTurns.find((turn) => turn.turnId === turnId)
  const promotedQueueAdmission =
    existing?.state === 'admitted' &&
    existing.prompt === prompt &&
    session.coordinator
      .snapshot(session.id)
      .controls.some(
        (control) =>
          control.kind === 'queue' &&
          control.state === 'promoted' &&
          control.turnId === turnId &&
          control.prompt === prompt,
      )
  if (existing && !promotedQueueAdmission) {
    const detail = `duplicate turnId "${turnId}" (state=${existing.state})`
    const terminal: Terminal = { reason: 'error', detail }
    emit(session, { type: 'error', message: detail })
    emit(session, { type: 'done', terminal })
    return terminal
  }

  const querySource = options?.querySource ?? 'repl_main_thread'
  const runner = session.coordinator.tryAcquire({
    sessionId: session.id,
    turnId,
    querySource,
  })
  if (!runner.ok) {
    const detail =
      `session runner busy for "${session.id}" ` +
      `(active turnId="${runner.active.turnId}")`
    const terminal: Terminal = { reason: 'error', detail }
    emit(session, { type: 'error', message: detail })
    emit(session, { type: 'done', terminal })
    return terminal
  }

  const linkedAbort = linkAbortSignals([options?.signal, runner.lease.signal])
  const ownedOptions: SubmitPromptOptions = {
    ...options,
    signal: linkedAbort.signal,
  }
  return runOwnedPrompt(
    session,
    prompt,
    ownedOptions,
    turnId,
    querySource,
  ).finally(async () => {
    linkedAbort.dispose()
    const released = await releaseSessionRunner(session, runner.lease)
    if (released.persistenceWarning) {
      emit(session, {
        type: 'error',
        message: released.persistenceWarning,
      })
    }
  })
}

async function runOwnedPrompt(
  session: BoloSession,
  prompt: string,
  options: SubmitPromptOptions | undefined,
  turnId: string,
  querySource: string,
): Promise<Terminal> {
  setPhase(session, 'running')

  const submit = await runHooks(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      prompt,
    },
    session.hooks,
    { signal: options?.signal },
  )
  for (const r of submit.results) {
    emit(session, {
      type: 'hook',
      event: 'UserPromptSubmit',
      exitCode: r.exitCode,
      blocked: r.blocked,
    })
  }
  recordSessionHookDiag(session, 'UserPromptSubmit', submit)
  if (submit.blocked) {
    emit(session, { type: 'error', message: submit.blockReason })
    setPhase(session, 'ready')
    const terminal: Terminal = {
      reason: 'user_prompt_blocked',
      detail: submit.blockReason,
    }
    emit(session, { type: 'done', terminal })
    return terminal
  }

  let userContent = prompt
  if (submit.injectText) userContent = `${prompt}\n\n${submit.injectText}`

  try {
    await persistSessionTurnState(session, {
      turnId,
      state: 'admitted',
      prompt: userContent,
      querySource,
    })
    await persistSessionTurnState(session, {
      turnId,
      state: 'running',
    })
  } catch (error) {
    const detail = `durable turn admission failed: ${
      error instanceof Error ? error.message : String(error)
    }`
    if (session.durableTurns.some((turn) => turn.turnId === turnId)) {
      try {
        await persistSessionTurnState(session, {
          turnId,
          state: 'error',
          terminalReason: 'error',
          detail,
        })
      } catch {
        applySessionTurnState(session, {
          turnId,
          state: 'error',
          terminalReason: 'error',
          detail,
        })
      }
    }
    emit(session, { type: 'error', message: detail })
    setPhase(session, 'ready')
    const terminal: Terminal = { reason: 'error', detail }
    emit(session, { type: 'done', terminal })
    return terminal
  }

  // CX8：ultrathink 本轮 plan（不写 session.effortLevel；无遥测）
  const ultraPlan = planUltrathinkTurn(session, userContent)
  if (ultraPlan.notice) {
    emit(session, { type: 'warning', message: ultraPlan.notice })
  }
  const turnEffort =
    ultraPlan.boosted && ultraPlan.effectiveEffort
      ? ultraPlan.effectiveEffort
      : session.effortLevel

  // D2：用户 turn 边界 — fileDiffLog 打 turn 号
  session.diffTurn = (session.diffTurn ?? 0) + 1
  if (!session.fileDiffLog) session.fileDiffLog = []
  session.messages.push({ role: 'user', content: userContent })

  let terminal: Terminal
  try {
    // path-scope：发模型前按对话中的 active paths 刷新 rules 段
    await refreshSessionPathScopedRules(session, { extraText: userContent })

    terminal = await queryLoop({
      sessionId: session.id,
      turnId,
      cwd: session.cwd,
      hooks: session.hooks,
      messages: session.messages,
      systemPromptSections: session.systemPromptSections,
      deps: session.deps,
      permissionMode: session.permissionMode,
      planMode: session.planMode === true,
      askPermission: session.askPermission,
      permissionRules: session.permissionRules,
      classifyPermission: session.classifyPermission,
      autoModeState: session.autoModeState,
      sessionRef: session,
      onAutoClassifyAudit: async (note) => {
        try {
          await appendSessionSystemNote(session, note.text, { kind: note.kind })
        } catch {
          // 审计落盘失败不阻断主路径
        }
      },
      maxToolResultChars: session.maxToolResultChars,
      skills: session.skills,
      tools:
        session.tools ??
        createDefaultTools(session.agentDefinitions, {
          agentPolicy: session.agentPolicy,
        }),
      agentDefinitions: session.agentDefinitions,
      backgroundStore: session.backgroundAgents,
      todoStore: getSessionTodoStore(session),
      backgroundShellStore: session.backgroundShells,
      // AR-T3a + HKP-3：plan 正交开关 + ExitPlanMode 就地切换。
      // 用 live getter/setter 直写 session，与 todoStore 同一手法。
      planModeStore: {
        get permissionMode(): string {
          return session.permissionMode
        },
        set permissionMode(next: string) {
          session.permissionMode = next as typeof session.permissionMode
        },
        get planMode(): boolean {
          return session.planMode === true
        },
        set planMode(next: boolean) {
          session.planMode = next
        },
      },
      // AR-T3+：AskUserQuestion 的提问句柄。CLI / Desktop 各注入自己的实现；
      // 未注入时保持 undefined —— 工具会据此返回 `unavailable` 并让模型
      // 带着假设继续跑，而不是等一个永远不会来的回答。
      askUserQuestion: session.askUserQuestion,
      takeBackgroundResults: () =>
        session.backgroundAgents
          ? takeBackgroundAgentResultsForPromotion(
              session.backgroundAgents,
            )
          : [],
      agentPolicy: session.agentPolicy,
      spawnDepth: 0,
      maxTurns: options?.maxTurns ?? 8,
      querySource,
      maxPtlRetries: session.maxPtlRetries,
      usage: session.usage,
      model: session.model,
      effortLevel: turnEffort,
      webSearch: session.webSearch,
      promptCacheState: session.promptCacheState,
      persistReasoning: session.persistReasoning === true,
      midTurnAutoCompact: true,
      tryMidTurnCompact: session.tryMidTurnCompact,
      signal: options?.signal,
      onSafeBoundary: async (boundary) => {
        const promoted = await promoteSessionControls(session, {
          turnId,
          boundary,
        })
        if (!promoted.ok) {
          emit(session, {
            type: 'error',
            message: `safe boundary "${boundary}" rejected: ${promoted.detail}`,
          })
          return []
        }
        if (promoted.persistenceWarning) {
          emit(session, {
            type: 'error',
            message: promoted.persistenceWarning,
          })
        }
        return promoted.controls
      },
      onEvent: (e) => mapLoopEvent(session, e),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    terminal = { reason: 'error', detail }
    emit(session, { type: 'error', message: detail })
    emit(session, { type: 'done', terminal })
  }

  if (session.phase !== 'ready') setPhase(session, 'ready')
  const durable = hasDurableSessionPersistence(session)
  let messagesSaved = !durable
  if (durable) {
    try {
      messagesSaved = await maybeAutoSaveSession(session, {
        throwOnError: true,
      })
    } catch {
      messagesSaved = false
    }
    // ROB-3：会话保存点顺带落盘后台任务 manifest（崩溃后 resume 可提醒）
    if (messagesSaved) {
      await persistBackgroundShellManifest(session).catch(() => {})
    }
  }
  const turnTerminal = {
    turnId,
    state: durableStateForTerminal(terminal),
    terminalReason: terminal.reason,
    ...(terminal.detail ? { detail: terminal.detail } : {}),
  }
  if (messagesSaved) {
    try {
      await persistSessionTurnState(session, turnTerminal)
    } catch (error) {
      applySessionTurnState(session, turnTerminal)
      emit(session, {
        type: 'error',
        message: `durable turn terminal write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  } else {
    // 磁盘保持 running，resume 将其识别为 interrupted；本进程仍知道真实终态。
    applySessionTurnState(session, turnTerminal)
  }
  return terminal
}

export type ResumeSessionOptions = {
  /** session id 或 .json 路径 */
  idOrPath: string
  /** load 时解析 project scope 用的 cwd；默认 process.cwd() 或快照内 cwd */
  cwd?: string
  scope?: SessionScope
  sessionsDir?: string
  filePath?: string
  /**
   * true（默认）：按 cwd/mode 重建 systemPromptSections；
   * false：使用快照中的 system 段。
   */
  reassembleSystem?: boolean
  /** 覆盖 createSession 的其余选项（provider / hooks / skills…） */
  create?: Omit<CreateSessionOptions, 'cwd' | 'sessionId' | 'source' | 'permissionMode'>
  /** 恢复后是否 autoSave（默认 false） */
  autoSave?: CreateSessionOptions['autoSave']
  onEvent?: (e: SessionEvent) => void
  askPermission?: AskPermissionFn
  provider?: LlmProvider
  hooks?: HooksConfig
  skills?: LoadedSkill[]
  systemPrompt?: boolean | SessionSystemPromptOptions
  source?: SessionStartSource
}

/**
 * 加载会话：经 loadSession（J-C+：同 id 有 jsonl 时 messages 优先 jsonl）。
 */
async function loadSessionOrTranscript(
  idOrPath: string,
  options?: {
    scope?: SessionScope
    cwd?: string
    sessionsDir?: string
    filePath?: string
  },
): Promise<{
  path: string
  snapshot: SessionSnapshot
  recovered?: import('./sessionPersist.ts').SessionRecoveryNote
}> {
  return loadSession(idOrPath, options)
}

/**
 * 从磁盘快照恢复会话（SessionStart source 默认 resume）。
 * J-C+：同 id 同时有 `.json` 与 `.jsonl` 时 messages 优先 jsonl，meta 可从 json 补。
 */
export async function resumeSession(
  opts: ResumeSessionOptions,
): Promise<{
  session: BoloSession
  snapshot: SessionSnapshot
  path: string
  /** 快照损坏但从 transcript 救回时填；CLI 应当告知用户 */
  recovered?: import('./sessionPersist.ts').SessionRecoveryNote
}> {
  const { path: filePath, snapshot, recovered } = await loadSessionOrTranscript(
    opts.idOrPath,
    {
      scope: opts.scope,
      cwd: opts.cwd,
      sessionsDir: opts.sessionsDir,
      filePath: opts.filePath,
    },
  )

  const cwd = opts.cwd ?? snapshot.cwd
  const reassemble = opts.reassembleSystem !== false

  const session = await createSession({
    ...opts.create,
    cwd,
    sessionId: snapshot.id,
    permissionMode: snapshot.permissionMode,
    // HKP-3：plan 正交开关随快照恢复（旧快照缺省为关闭）
    ...(snapshot.planMode === true ? { planMode: true } : {}),
    model: opts.create?.model ?? snapshot.model,
    autoCompactEnabled:
      opts.create?.autoCompactEnabled ?? snapshot.autoCompactEnabled,
    contextWindowTokens:
      opts.create?.contextWindowTokens ?? snapshot.contextWindowTokens,
    maxPtlRetries: opts.create?.maxPtlRetries ?? snapshot.maxPtlRetries,
    permissionRules:
      opts.create?.permissionRules ?? snapshot.permissionRules,
    effortLevel: opts.create?.effortLevel ?? snapshot.effortLevel,
    // CX6：快照 providerId；create 显式优先
    providerId: opts.create?.providerId ?? snapshot.providerId,
    providerRegistry: opts.create?.providerRegistry,
    providerProfile: opts.create?.providerProfile,
    effortDialect: opts.create?.effortDialect,
    showThinking:
      opts.create?.showThinking ??
      (snapshot.showThinking === false ? false : true),
    persistReasoning:
      opts.create?.persistReasoning ??
      snapshot.persistReasoning === true,
    usage: opts.create?.usage ?? snapshot.usage,
    promptCacheState:
      opts.create?.promptCacheState ?? snapshot.promptCacheState,
    provider: opts.provider ?? opts.create?.provider,
    hooks: opts.hooks ?? opts.create?.hooks,
    skills: opts.skills ?? opts.create?.skills,
    askPermission: opts.askPermission ?? opts.create?.askPermission,
    onEvent: opts.onEvent ?? opts.create?.onEvent,
    systemPrompt: reassemble
      ? (opts.systemPrompt ?? opts.create?.systemPrompt ?? true)
      : false,
    source: opts.source ?? 'resume',
    autoSave: opts.autoSave ?? opts.create?.autoSave,
  })

  // 恢复期的 provider/effort 警告也属于原会话；必须在任何快照应用或
  // runtime 重绑定前继承原持久化身份，避免按 create 默认路径写出副本。
  setSessionPersistMeta(session, {
    createdAt: snapshot.createdAt,
    filePath,
    scope: opts.scope ?? 'workspace',
  })

  const registryBacked =
    Boolean(session.providerRegistry) &&
    Object.keys(session.providerRegistry?.profiles ?? {}).length > 0
  applySnapshotToSession(session, snapshot, {
    restoreSystemSections: !reassemble,
    restoreModelRuntime: !registryBacked,
  })

  // ROB-3：resume 投影遗留后台任务（running → interrupted），/bg 展示提醒
  await restoreBackgroundShellManifest(session, filePath).catch(() => {})

  // CX6：若有 registry + 快照 providerId，尝试热切到该后端（缺 key 则保留 create 默认并警告）
  const resumePid =
    snapshot.resolvedModel?.providerId.trim() ??
    snapshot.providerId?.trim()
  if (resumePid && registryBacked) {
    const { switchSessionProvider } = await import('./sessionProvider.ts')
    const sw = switchSessionProvider(session, resumePid, {
      model: snapshot.resolvedModel?.model ?? snapshot.model,
      snapshot: snapshot.resolvedModel,
    })
    if (!sw.ok) {
      try {
        const { appendSessionSystemNote } = await import('./sessionPersist.ts')
        await appendSessionSystemNote(
          session,
          `resume: provider "${resumePid}" unavailable — ${sw.reason}`,
          { kind: 'resume_provider', filePath },
        )
      } catch {
        /* best-effort */
      }
      emit(session, {
        type: 'error',
        message: `resume: provider "${resumePid}" unavailable (${sw.reason}); using default backend`,
      })
    }
  } else if (!registryBacked && resumePid && !session.providerId) {
    session.providerId = resumePid
  } else if (registryBacked && snapshot.model) {
    const { switchSessionModel } = await import('./sessionProvider.ts')
    const sw = switchSessionModel(session, snapshot.model)
    if (!sw.ok) {
      emit(session, {
        type: 'error',
        message: `resume: model "${snapshot.model}" unavailable (${sw.reason}); using current model`,
      })
    }
  }

  // CX6：effort 与当前后端求交
  {
    const { clampEffortForSession } = await import('./effortClamp.ts')
    const clamp = clampEffortForSession(session)
    if (clamp.warning) {
      try {
        const { appendSessionSystemNote } = await import('./sessionPersist.ts')
        await appendSessionSystemNote(session, clamp.warning, {
          kind: 'effort_clamp',
          filePath,
        })
      } catch {
        /* ignore */
      }
    }
  }

  // D6/DR1/DR2C/DR3A：恢复 file_diff 与 durable lifecycle 诊断投影。
  try {
    const tp = resolveTranscriptPathFromJson(filePath)
    const { entries } = await loadTranscriptFile(tp)
    session.durableTurns = projectDurableTurns(entries)
    session.durableControls = projectDurableControls(entries)
    session.durableTasks = projectDurableTasks(entries)
    session.durableResolutions = projectDurableResolutions(entries)
    session.toolPresentations =
      projectToolPresentationsFromEntries(entries)
    if (session.backgroundAgents) {
      restoreBackgroundAgentStoreFromDurableTasks(
        session.backgroundAgents,
        session.durableTasks,
      )
    }
    // AR-T1：待办表随 resume 恢复。表不在 messages 里，只能从 transcript 快照取。
    session.todos = projectTodosFromEntries(entries)
    const diffs = fileDiffsFromTranscriptEntries(entries)
    if (diffs.length) {
      session.fileDiffLog = diffs.map((d) => ({
        at: d.at,
        tool: d.tool,
        path: d.path,
        kind: d.kind as import('./fileDiffLog.ts').FileChangeRecord['kind'],
        added: d.added,
        removed: d.removed,
        ...(d.op
          ? { op: d.op as import('./fileDiffLog.ts').FileChangeOp }
          : {}),
        ...(d.turn != null ? { turn: d.turn } : {}),
      }))
      const turns = diffs
        .map((d) => d.turn ?? 0)
        .filter((t) => t > 0)
      if (turns.length) session.diffTurn = Math.max(...turns)
    }
  } catch {
    /* 无 transcript 或旧格式 */
  }

  // 重建 system 失败或为空时回退快照
  if (reassemble && session.systemPromptSections.length === 0) {
    session.systemPromptSections = [...snapshot.systemPromptSections]
  }

  return {
    session,
    snapshot,
    path: filePath,
    ...(recovered ? { recovered } : {}),
  }
}

export type ResumeSessionFromWorkspaceOptions = ResumeSessionOptions & {
  materializeUserState?: boolean
  wireCompactSummarizer?: boolean
  injectSkills?: boolean
  autoCompactEnabled?: boolean
  contextWindowTokens?: number
  microcompact?: MicrocompactOptions | false
  maxPtlRetries?: number
  ultrathinkMode?: UltrathinkMode | string
  connectMcp?: boolean
  mcpTimeoutMs?: number
}

/**
 * 从当前 workspace 恢复会话。
 * 与 createSessionFromWorkspace 共用 provider/hooks/skills/plugins/agent/MCP 装配，
 * 快照仍负责 messages、model、权限规则及其它会话态。
 */
export async function resumeSessionFromWorkspace(
  opts: ResumeSessionFromWorkspaceOptions,
): Promise<{
  session: BoloSession
  snapshot: SessionSnapshot
  path: string
  workspace: ResolvedWorkspace
  mcp?: ConnectMcpResult
  /** 快照损坏但从 transcript 救回时填；CLI 应当告知用户 */
  recovered?: import('./sessionPersist.ts').SessionRecoveryNote
}> {
  let workspaceCwd = opts.cwd
  if (!workspaceCwd) {
    const preloaded = await loadSessionOrTranscript(opts.idOrPath, {
      scope: opts.scope,
      sessionsDir: opts.sessionsDir,
      filePath: opts.filePath,
    })
    workspaceCwd = preloaded.snapshot.cwd
  }
  const workspace = await loadWorkspace({
    cwd: workspaceCwd,
    materializeUserState: opts.materializeUserState,
  })
  const workspaceOptions: CreateSessionFromWorkspaceOptions = {
    cwd: workspaceCwd,
    materializeUserState: opts.materializeUserState,
    askPermission: opts.askPermission,
    onEvent: opts.onEvent,
    source: opts.source,
    wireCompactSummarizer: opts.wireCompactSummarizer,
    injectSkills: opts.injectSkills,
    systemPrompt: opts.systemPrompt === false ? false : true,
    autoCompactEnabled: opts.autoCompactEnabled,
    contextWindowTokens: opts.contextWindowTokens,
    microcompact: opts.microcompact,
    maxPtlRetries: opts.maxPtlRetries,
    ultrathinkMode: opts.ultrathinkMode,
    connectMcp: opts.connectMcp,
    mcpTimeoutMs: opts.mcpTimeoutMs,
  }
  const built = buildWorkspaceSessionOptions(
    workspace,
    workspaceOptions,
    'resume',
  )
  const {
    cwd: _workspaceCwd,
    source: _workspaceSource,
    permissionMode: _workspacePermissionMode,
    ...workspaceCreate
  } = built

  const resumed = await resumeSession({
    ...opts,
    cwd: workspaceCwd,
    provider: opts.provider ?? workspace.provider,
    hooks: opts.hooks ?? workspace.hooks,
    skills: opts.skills ?? workspace.skills,
    askPermission: opts.askPermission ?? workspaceCreate.askPermission,
    onEvent: opts.onEvent ?? workspaceCreate.onEvent,
    systemPrompt: opts.systemPrompt ?? workspaceCreate.systemPrompt,
    source: opts.source ?? 'resume',
    create: {
      ...workspaceCreate,
      ...opts.create,
    },
  })
  const mcp = await attachWorkspaceRuntime(
    resumed.session,
    workspace,
    workspaceOptions,
  )
  return { ...resumed, workspace, mcp }
}

/** 显式保存当前会话（同 saveSession，便于从 core 入口发现） */
export async function persistSession(
  session: BoloSession,
  options?: SaveSessionOptions,
): Promise<{ path: string; snapshot: SessionSnapshot }> {
  return saveSession(session, options)
}

/**
 * AR2A0a：从 session.usage.lastCall 构造 usage 锚。
 * 仅当最近一次 call 是 provider 真实 usage（非估算）且记录了消息数快照时返回；
 * 否则 undefined → 调用方回退 usageInputTokens / estimate 路径。
 */
export function getSessionUsageAnchor(
  session: Pick<BoloSession, 'usage'>,
): UsageAnchor | undefined {
  const last = session.usage?.lastCall
  if (!last || last.estimated) return undefined
  if (!(last.inputTokens > 0)) return undefined
  if (
    last.messageCountAtCall == null ||
    !Number.isFinite(last.messageCountAtCall) ||
    last.messageCountAtCall <= 0
  ) {
    return undefined
  }
  const anchor: UsageAnchor = {
    // C1：Anthropic 的 input_tokens 不含缓存部分。缓存越有效这个数越小，
    // 直接拿来当锚会让 auto-compact 几乎不触发，一路涨到硬性 PTL。
    // OpenAI 的 prompt_tokens 已含缓存，加回来就会重复计数。
    anchorInputTokens: promptTokensFromUsage(last),
    anchoredMessageCount: last.messageCountAtCall,
  }
  if (last.messagePrefixFingerprint) {
    anchor.fingerprint = last.messagePrefixFingerprint
  }
  return anchor
}

/**
 * 按 session.autoCompactEnabled + summarizer 重挂 prepare 链。
 * 供 createSession / 运行时 `/autocompact` 共用。
 * 顺序：snip → micro → auto full。
 */
export function wireSessionPrepareMessages(
  session: BoloSession,
  opts?: {
    microcompact?: MicrocompactOptions | false
    snip?: SnipOptions | false
  },
): void {
  const microOpts: MicrocompactOptions | undefined =
    opts?.microcompact === false
      ? { enabled: false }
      : opts?.microcompact === undefined
        ? undefined
        : opts.microcompact
  const snipOpts: SnipOptions | false | undefined =
    opts?.snip === false
      ? false
      : opts?.snip === undefined
        ? undefined
        : opts.snip
  const snipPrepare = createSnipPrepare(snipOpts)
  const microPrepare = createMicrocompactPrepare(microOpts)

  if (session.autoCompactEnabled && session.compactSummarizer) {
    session.deps = {
      ...session.deps,
      prepareMessages: composePrepareMessages(
        snipPrepare,
        microPrepare,
        createAutoCompactPrepare({
          enabled: true,
          getContextWindowTokens: () =>
            session.resolvedModel.contextWindowTokens,
          // AR2A0a：有锚走混合计数；无锚（旧会话/估算 usage）回退 C2 usage 路径
          getUsageAnchor: () => getSessionUsageAnchor(session),
          // C3：只在估算分支生效；anchor/usage 走服务端真实计数，本就含 system
          getSystemPromptSections: () => session.systemPromptSections,
          getUsageInputTokens: () => {
            const u = session.usage
            if (!u) return undefined
            // 优先 lastCall.input；否则会话累计 input
            const last = u.lastCall?.inputTokens
            if (last != null && last > 0) return last
            if (u.inputTokens > 0) return u.inputTokens
            return undefined
          },
          runAutoCompact: async () => {
            const r = await compactSession(session, { trigger: 'auto' })
            return r.ok ? session.messages : null
          },
        }),
      ),
    }
    return
  }

  session.deps = {
    ...session.deps,
    prepareMessages: composePrepareMessages(snipPrepare, microPrepare),
  }
}

/**
 * 运行时开关 auto compact，并重挂 prepare（不改 system 前缀）。
 * 返回生效后的状态；环境熔断时仍可「会话 on」但 shouldAutoCompact 为 false。
 */
export function setSessionAutoCompact(
  session: BoloSession,
  enabled: boolean,
  opts?: {
    microcompact?: MicrocompactOptions | false
    snip?: SnipOptions | false
  },
): { autoCompactEnabled: boolean; envDisabled: boolean } {
  session.autoCompactEnabled = enabled === true
  wireSessionPrepareMessages(session, opts)
  return {
    autoCompactEnabled: session.autoCompactEnabled,
    envDisabled: isAutoCompactEnvDisabled(),
  }
}

export type CompactSessionOptions = {
  trigger?: 'manual' | 'auto'
  customInstructions?: string
  /** C1：按 user 轮次保留；不传则 runFullCompact 智能默认 */
  keepRecentUserTurns?: number
  keepMaxTokens?: number
  /** @deprecated 用 keepRecentUserTurns */
  keepRecentMessageCount?: number
}

/**
 * Full compact — docs/COMPACTION.md；无 summarizer 则失败且不改 messages
 */
export async function compactSession(
  session: BoloSession,
  options: CompactSessionOptions | 'manual' | 'auto' = 'manual',
): Promise<{ ok: boolean; reason?: string }> {
  const opts: CompactSessionOptions =
    typeof options === 'string' ? { trigger: options } : options
  const trigger = opts.trigger ?? 'manual'

  if (!session.compactSummarizer) {
    emit(session, {
      type: 'error',
      message:
        'compact refused: inject CompactSummarizer (see docs/COMPACTION.md); will not truncate messages',
    })
    return { ok: false, reason: 'no CompactSummarizer' }
  }

  const snapshot = session.messages.slice()
  setPhase(session, 'compacting')

  const pre = await runHooks(
    'PreCompact',
    {
      hook_event_name: 'PreCompact',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      trigger,
    },
    session.hooks,
  )
  for (const r of pre.results) {
    emit(session, {
      type: 'hook',
      event: 'PreCompact',
      exitCode: r.exitCode,
      blocked: r.blocked,
    })
  }
  recordSessionHookDiag(session, 'PreCompact', pre)
  if (pre.blocked) {
    session.messages.length = 0
    session.messages.push(...snapshot)
    setPhase(session, 'ready')
    return { ok: false, reason: pre.blockReason || 'PreCompact blocked' }
  }

  const outcome = await runFullCompact({
    messages: session.messages,
    trigger,
    customInstructions: opts.customInstructions,
    maxPtlRetries: session.maxPtlRetries,
    hookInstructions: pre.injectText || undefined,
    summarize: session.compactSummarizer,
    ...(session.compactTimeoutMs !== undefined
      ? { summarizeTimeoutMs: session.compactTimeoutMs }
      : {}),
    ...(opts.keepRecentUserTurns != null
      ? { keepRecentUserTurns: opts.keepRecentUserTurns }
      : {}),
    ...(opts.keepMaxTokens != null ? { keepMaxTokens: opts.keepMaxTokens } : {}),
    ...(opts.keepRecentMessageCount != null
      ? { keepRecentMessageCount: opts.keepRecentMessageCount }
      : {}),
    suppressFollowUpQuestions: trigger === 'auto',
  })

  if (!outcome.ok) {
    // 失败：恢复快照且保持同一数组引用（queryLoop 持有 params.messages）
    session.messages.length = 0
    session.messages.push(...snapshot)
    emit(session, { type: 'error', message: outcome.reason })
    setPhase(session, 'ready')
    return { ok: false, reason: outcome.reason }
  }

  // 就地替换，避免 session.messages 与 queryLoop 引用脱节
  session.messages.length = 0
  session.messages.push(...outcome.apiMessages)

  // 旁路 jsonl：rewrite 并写入 compact_boundary（不改 JSON 快照）。
  //
  // **必须排在 PostCompact hook 与再注入之前。** 写盘失败要能干净回退，
  // 而 hook 一旦跑过就收不回来了。
  //
  // 失败即完整回退（与摘要失败同待遇）。此前这里只 emit error 然后
  // `return { ok: true }`，后果是内存与磁盘分叉：内存是压缩后的短链，
  // 磁盘还是压缩前的长历史且无 boundary。resume 会加载那份旧历史 ——
  // 这次压缩等于没发生，上下文压力原样存在，于是立刻再次触发 auto compact，
  // 转圈，而调用方全程拿到的是 ok:true。
  try {
    const meta = getSessionPersistMeta(session)
    await writeTranscriptAfterCompact(session, {
      summary: outcome.result.summaryText,
      filePath: meta?.filePath,
      sessionsDir: meta?.sessionsDir,
      createdAt: meta?.createdAt,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    session.messages.length = 0
    session.messages.push(...snapshot)
    const reason = `compact transcript write failed, compaction rolled back: ${message}`
    emit(session, { type: 'error', message: reason })
    setPhase(session, 'ready')
    return { ok: false, reason }
  }

  // MEM-1：压缩前 flush 最近消息总结到 user memory daily log（fail-open）。
  // 用压缩前的 snapshot 总结——压缩后这些消息已被摘要替换，正文不再可得。
  if (session.flushMemoryOnCompact !== false) {
    try {
      const flushed = await flushMemoryFromRecentMessages({
        messages: snapshot,
        summarize: session.compactSummarizer,
        alreadyFlushedHash: session.memoryFlushedHash,
      })
      session.memoryFlushedHash = flushed.newHash
      if (flushed.appendedLine) {
        emit(session, {
          type: 'warning',
          message: 'memory: flushed compact summary to daily log',
        })
      }
    } catch {
      /* 记忆 flush 失败不拖垮 compact */
    }
  }

  // full compact 只改对话 messages；systemPromptSections 稳定前缀不动
  // boundary 为 apiMessages[0] system「Conversation compacted」

  // C4：短 skill catalog 再注入（可关；不灌全文）
  if (session.postCompactReinjection !== false && session.skills?.length) {
    try {
      const catalog = formatSkillCatalog(session.skills, {
        contextWindowTokens: session.resolvedModel.contextWindowTokens,
      })
      session.systemPromptSections = replaceSkillCatalogSection(
        session.systemPromptSections,
        catalog || undefined,
      )
    } catch {
      /* 再注入失败不拖垮 compact */
    }
  }

  session.lastCompact = {
    at: nowIso(),
    trigger,
    summaryChars: outcome.result.summaryText?.length ?? 0,
    messagesAfter: session.messages.length,
  }

  const post = await runHooks(
    'PostCompact',
    {
      hook_event_name: 'PostCompact',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      trigger,
      summary: outcome.result.summaryText,
    },
    session.hooks,
  )
  for (const r of post.results) {
    emit(session, { type: 'hook', event: 'PostCompact', exitCode: r.exitCode })
  }
  recordSessionHookDiag(session, 'PostCompact', post)

  setPhase(session, 'ready')
  return { ok: true }
}

export {
  AGENT_TOOL_NAME,
  EXPLORE_AGENT,
  GENERAL_AGENT,
  PLAN_AGENT,
  FORK_AGENT,
  createAgentTool,
  createDefaultTools,
  createBackgroundAgentStore,
  formatBackgroundAgentsStatus,
  markBackgroundAgentRunning,
  markBackgroundAgentFinished,
  enqueueBackgroundAgent,
  pumpBackgroundAgentQueue,
  cancelQueuedBackgroundAgent,
  queueBackgroundAgentResultForPromotion,
  takeBackgroundAgentResultsForPromotion,
  restoreBackgroundAgentStoreFromDurableTasks,
  canStartBackgroundAgent,
  countRunningBackgroundAgents,
  getDefaultMaxBackgroundAgents,
  getBackgroundOverflowPolicy,
  getAgentDefinition,
  listBuiltinAgents,
  listActiveAgents,
  loadAgentsDir,
  mergeAgentDefinitions,
  builtinAgentMap,
  resolveAgentTools,
  resolveSubagentTranscriptPath,
  runSubagent,
  spawnSubagent,
  spawnSubagentStub,
  isForkAgentRequest,
  agentDefinitionFromMarkdown,
  parseAgentFrontmatter,
  parseToolsField,
  countToolUses,
  formatDurationMs,
  finalizeSubagentStats,
  formatSubagentToolOutput,
  buildAgentToolDescription,
  defaultAgentPolicy,
  resolveAgentPolicy,
  resolveSubagentModel,
  resolveSubagentEffort,
  canExposeAgentTool,
  clampSpawnDepth,
  applySandboxToolFilter,
  type AgentDefinition,
  type AgentDefinitionSource,
  type ActiveAgentDefinitions,
  type AgentPolicy,
  type BackgroundAgentEntry,
  type BackgroundAgentStatus,
  type BackgroundAgentStore,
  type BackgroundTaskAdmission,
  type BackgroundTaskCompletion,
  type DurableBackgroundTaskLifecycle,
  type CancelQueuedBackgroundAgentResult,
  type LoadAgentsDirOptions,
  type LoadAgentsDirResult,
  type ResolveAgentToolsResult,
  type RunSubagentParams,
  type RunSubagentResult,
  type SubagentParentContext,
} from './subagent.ts'

/**
 * 切换权限模式（对照 HC cyclePermissionMode 的 session 侧）
 * 进入 auto 时剥离危险 always-allow（Y3.1）；熔断 demote 时退回 default。
 */
export function setPermissionMode(session: BoloSession, mode: PermissionMode) {
  const prev = session.permissionMode
  // HKP-3：plan 是正交开关——切换到 'plan' 只激活规划态，不覆盖原模式；
  // 从其它模式切换时同步关闭规划态
  if (mode === 'plan') {
    session.planMode = true
  } else {
    session.planMode = false
    session.permissionMode = mode
  }
  if (mode === 'auto' && prev !== 'auto') {
    const removed = stripDangerousAllowsForAuto(session.permissionRules)
    if (!session.autoModeState) {
      session.autoModeState = createAutoModeState('deny')
    } else {
      // 进 auto 重置熔断，给分类器新机会
      session.autoModeState.circuitBroken = false
      session.autoModeState.consecutiveFailures = 0
      session.autoModeState.demoteToDefault = false
    }
    if (removed.length) {
      session.autoModeState.lastReason = `stripped dangerous allows: ${removed.join(', ')}`
    }
    // 确保有分类器
    if (!session.classifyPermission && session.provider.completeText) {
      const p = session.provider
      session.classifyPermission = createAutoClassifyFromCompleteText(
        (messages, o) => p.completeText!(messages, o),
        { model: session.model },
      )
    }
  }
  emit(session, {
    type: 'phase',
    phase: session.phase,
  })
}

/**
 * 若 auto 熔断要求 demote：退回 default 并返回说明（供 toolExecution / slash）。
 */
export function maybeDemoteAutoMode(session: {
  permissionMode: PermissionMode
  autoModeState?: AutoModeState
}): string | undefined {
  const st = session.autoModeState
  if (
    session.permissionMode === 'auto' &&
    st?.circuitBroken &&
    st.demoteToDefault
  ) {
    session.permissionMode = 'default'
    st.demoteToDefault = false
    const reason = st.lastReason ?? 'auto circuit open'
    st.lastReason = `demoted to default: ${reason}`
    return st.lastReason
  }
  return undefined
}

// ── slash 总线（parse / dispatch / submitUserInput）──
export {
  parseSlashLine,
  dispatchSlashCommand,
  submitUserInput,
  getSlashCommand,
  previewSlashCommandDisplay,
  isSlashDisplayPolicy,
  normalizeSlashDisplayPolicy,
  resolveSlashCommandDisplay,
  invokeSkillBySlash,
  SLASH_COMMANDS,
  getSlashCommandCandidates,
  filterSlashCommandCandidates,
  EFFORT_LEVELS,
  isEffortLevel,
  approxTokensFromChars,
  buildContextUsageViewModel,
  formatContextUsagePlain,
  formatContextUsageDetails,
  sectionLabel,
  editDistance,
  suggestSlashCommands,
  SLASH_GROUP_LABELS,
  SLASH_GROUP_ORDER,
  type ParseSlashResult,
  type SlashDispatchResult,
  type ResolvedSlashDispatchResult,
  type SlashDisplayPolicy,
  type SlashDisplayTone,
  type SlashOverlayItem,
  type SlashOverlayViewModel,
  type PreviewSlashCommandDisplay,
  type SubmitUserInputResult,
  type SlashCommandDef,
  type SlashCommandCandidate,
  type SlashCommandCandidateSession,
  type SlashCommandCandidateSource,
  type SlashCommandGroup,
  type EffortLevel,
  type ContextUsageCategory,
  type ContextUsageSection,
  type ContextUsageSource,
  type ContextUsageViewModel,
} from './slash.ts'

export {
  createHookDiagLog,
  appendHookDiag,
  formatHookDiagRecent,
  diagEntriesFromHookRun,
  type HookDiagEntry,
  type HookDiagLog,
} from './hookDiag.ts'

export {
  buildRuntimeSnapshot,
  type BuildRuntimeSnapshotOptions,
  type RuntimeSnapshotSource,
} from './runtimeSnapshot.ts'

export {
  executeRuntimeCommand,
  type RuntimeCommandSession,
} from './runtimeCommand.ts'

export {
  createSessionRuntimeTransport,
  type RuntimeSessionResolver,
} from './runtimeTransport.ts'

export {
  canReplaceActiveSession,
  createActiveSessionManager,
  scopeSessionRequestId,
  type ActiveSessionHandle,
  type ActiveSessionManager,
  type ActiveSessionManagerDeps,
  type SessionDisposeReason,
  type SessionSelectionFailure,
  type SessionSelectionFailureCode,
  type SessionSelectionResult,
  type SessionSelectionSuccess,
} from './sessionSelection.ts'

export {
  renderRuntimeText,
  type RuntimeTextRenderOptions,
  type RuntimeTextPage,
} from './runtimeTextView.ts'

export {
  getSessionTodoStore,
  computeTodoReminderAnchors,
  buildTodoReminderMessage,
  type TodoSessionRef,
  type TodoReminderAnchors,
} from './sessionTodo.ts'

export {
  formatTodoCell,
  type FormatTodoCellOptions,
} from './todoCell.ts'
