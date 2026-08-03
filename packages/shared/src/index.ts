/** 共享契约 — 类型真源 */

export const HOOK_EVENTS = [
  'PermissionDenied',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostCompact',
  'PreCompact',
  'PreToolUse',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
  'Stop',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export const HOOK_EVENTS_WITHOUT_MATCHER = [
  'UserPromptSubmit',
  'Stop',
] as const satisfies readonly HookEvent[]

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
/** SessionEnd matcher；对齐 HC/Codex 常用 reason */
export type SessionEndReason =
  | 'clear'
  | 'logout'
  | 'prompt_input_exit'
  | 'other'
export type CompactTrigger = 'manual' | 'auto'
export type PermissionDecision = 'allow' | 'deny' | 'ask'

export type HookCommand = {
  type: 'command'
  command: string
  timeout?: number
  async?: boolean
}

export type HookMatcherGroup = {
  /** UserPromptSubmit / Stop 忽略此字段 */
  matcher?: string
  hooks: HookCommand[]
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>

export type HookBaseInput = {
  hook_event_name: HookEvent
  session_id: string
  cwd: string
  timestamp: string
}

export type PermissionRequestInput = HookBaseInput & {
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

/** HKP-1：工具权限被拒绝时触发；纯观察，不参与决策。 */
export type PermissionDeniedInput = HookBaseInput & {
  hook_event_name: 'PermissionDenied'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  /** 拒绝原因（权限模式/规则/用户选择等） */
  reason?: string
}

/** HKP-1：工具执行失败（isError/抛错）时触发；观察 + exit 2 反馈。 */
export type PostToolUseFailureInput = HookBaseInput & {
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  tool_response: unknown
  /** 失败原因/错误消息 */
  error: string
}

export type PreToolUseInput = HookBaseInput & {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

export type PostToolUseInput = HookBaseInput & {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: unknown
  tool_response: unknown
  tool_use_id: string
}

export type SessionStartInput = HookBaseInput & {
  hook_event_name: 'SessionStart'
  source: SessionStartSource
}

export type SessionEndInput = HookBaseInput & {
  hook_event_name: 'SessionEnd'
  reason: SessionEndReason | string
  transcript_path?: string
}

export type UserPromptSubmitInput = HookBaseInput & {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

export type StopInput = HookBaseInput & {
  hook_event_name: 'Stop'
}

export type CompactHookInput = HookBaseInput & {
  hook_event_name: 'PreCompact' | 'PostCompact'
  trigger: CompactTrigger
  summary?: string
}

export type SubagentLifecycleInput = HookBaseInput & {
  hook_event_name: 'SubagentStart' | 'SubagentStop'
  agent_id: string
  agent_type: string
  agent_transcript_path?: string
  description?: string
  total_duration_ms?: number
  total_tool_use_count?: number
  total_tokens?: number
}

export type AnyHookInput =
  | PermissionRequestInput
  | PermissionDeniedInput
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | SessionStartInput
  | SessionEndInput
  | UserPromptSubmitInput
  | StopInput
  | CompactHookInput
  | SubagentLifecycleInput
  | HookBaseInput

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ChatMessage = {
  role: ChatRole
  content: string
  tool_call_id?: string
  name?: string
  /** assistant 发起的 tool 调用（OpenAI 回灌需要） */
  tool_calls?: Array<{
    id: string
    name: string
    arguments: string
  }>
  /**
   * 可选思考链（DeepSeek 等 openai-compatible 回灌用）。
   * 仅当显式开启 persist 时写入；默认不落盘、不进 transcript。
   */
  reasoning_content?: string
}

export type SessionPhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'running'
  | 'awaiting_permission'
  | 'compacting'
  | 'stopping'
  | 'ended'

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export {
  DEFAULT_TOOL_PREVIEW_MAX_CHARS,
  classifyToolPresentation,
  createToolPresentation,
  isToolPresentation,
  type CreateToolPresentationInput,
  type ToolPresentation,
  type ToolPresentationKind,
  type ToolPreviewMode,
  type ToolResultReference,
} from './toolPresentation.ts'

export {
  CLI_TOOL_PREVIEW_MAX_CHARS,
  CLI_TOOL_PREVIEW_MAX_LINES,
  CLI_TOOL_RUNNING_TAIL_MAX_CHARS,
  CLI_TOOL_RUNNING_TAIL_MAX_LINES,
  createCliToolDisplayState,
  projectCliToolDisplay,
  reduceCliToolDisplayState,
  type CliToolDisplayAction,
  type CliToolDisplayMode,
  type CliToolDisplayProjection,
  type CliToolDisplayState,
} from './cliToolDisplay.ts'

export {
  RUNTIME_COMMAND_ACTIONS,
  RUNTIME_COMMAND_ERROR_CODES,
  RUNTIME_CONTROL_BOUNDARIES,
  RUNTIME_CONTROL_KINDS,
  RUNTIME_CONTROL_STATES,
  RUNTIME_PROTOCOL_FEATURES,
  RUNTIME_PROTOCOL_SUPPORTED_VERSIONS,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESOLUTION_ACTIONS,
  RUNTIME_RESOLUTION_ENTITY_KINDS,
  RUNTIME_SESSION_PHASES,
  RUNTIME_TASK_ISOLATIONS,
  RUNTIME_TASK_STATES,
  RUNTIME_TURN_STATES,
  createRuntimeProtocolHello,
  negotiateRuntimeProtocol,
  parseRuntimeCommand,
  parseRuntimeCommandResult,
  parseRuntimeSnapshot,
  type RuntimeCommand,
  type RuntimeCommandAction,
  type RuntimeCommandErrorCode,
  type RuntimeCommandResult,
  type RuntimeControlBoundary,
  type RuntimeControlCancelCommand,
  type RuntimeControlReplaceCommand,
  type RuntimeControlReplacementView,
  type RuntimeControlKind,
  type RuntimeControlState,
  type RuntimeControlView,
  type RuntimeInspectCommand,
  type RuntimeProtocolFeature,
  type RuntimeProtocolHello,
  type RuntimeProtocolNegotiationRequest,
  type RuntimeProtocolNegotiationResult,
  type RuntimeProtocolParseErrorCode,
  type RuntimeProtocolParseResult,
  type RuntimeProtocolVersion,
  type RuntimeRunnerOwnerView,
  type RuntimeRunnerView,
  type RuntimeResolutionAction,
  type RuntimeResolutionEntityKind,
  type RuntimeResolutionView,
  type RuntimeSessionPhase,
  type RuntimeSessionView,
  type RuntimeSnapshot,
  type RuntimeTaskCancelCommand,
  type RuntimeTaskIsolation,
  type RuntimeTaskResultView,
  type RuntimeTaskState,
  type RuntimeTaskView,
  type RuntimeTurnInterruptCommand,
  type RuntimeTurnState,
  type RuntimeTurnView,
  type RuntimeUsageView,
  type RuntimeRecoveryCommand,
} from './runtimeProtocol.ts'

export {
  BACKGROUND_SHELL_STATUSES,
  DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES,
  advanceShellReadOffset,
  applyShellExit,
  createBackgroundShellRecord,
  createBackgroundShellStore,
  formatBackgroundShellStatusLine,
  getBackgroundShell,
  isTerminalShellStatus,
  listBackgroundShells,
  markShellInterrupted,
  markShellKilled,
  parseBackgroundShellManifest,
  registerBackgroundShell,
  serializeBackgroundShellManifest,
  shouldKillForOutputSize,
  type BackgroundShellRecord,
  type BackgroundShellStatus,
  type BackgroundShellStore,
} from './backgroundShell.ts'

export {
  TODO_REMINDER_CLOSE_TAG,
  TODO_REMINDER_OPEN_TAG,
  TODO_REMINDER_TURNS_BETWEEN,
  TODO_REMINDER_TURNS_SINCE_WRITE,
  TODO_STATUSES,
  applyTodoWrite,
  formatTodoReminder,
  shouldRemindTodos,
  summarizeTodoList,
  validateTodoList,
  type TodoItem,
  type TodoReminderInput,
  type TodoStatus,
  type TodoSummary,
  type TodoValidationErrorCode,
  type TodoValidationResult,
  type TodoWriteApplication,
} from './todo.ts'

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
} from './runtimeQuery.ts'

export {
  applyRuntimePagerKey,
  parseRuntimePagerKey,
  type RuntimePagerDoneReason,
  type RuntimePagerKey,
  type RuntimePagerSuccess,
  type RuntimePagerTransition,
} from './runtimePager.ts'

export {
  ASK_MAX_QUESTIONS,
  ASK_MIN_OPTIONS,
  ASK_MAX_OPTIONS,
  ASK_MAX_HEADER_CHARS,
  validateAskUserQuestionInput,
  projectAskUserQuestionAnswers,
  formatAskUserQuestionResult,
  type AskQuestion,
  type AskQuestionOption,
  type AskUserQuestionAnswer,
  type AskUserQuestionProjection,
  type AskUserQuestionSelection,
  type AskUserQuestionValidation,
} from './askUserQuestion.ts'

// AR3A：runtime protocol 消费侧（transport 抽象 + client + 单一 store）
export {
  createRuntimeClient,
  createMockRuntimeTransport,
  type RuntimeTransport,
  type RuntimeClient,
  type RuntimeClientState,
  type RuntimeClientOptions,
  type MockRuntimeTransportOptions,
} from './runtimeClient.ts'

// AR3B：会话列表视图模型（盘上列表 + 运行时状态 → 侧栏可扫读的行）
export {
  buildSessionListView,
  type SessionListSource,
  type SessionListStatus,
  type SessionListEntry,
  type BuildSessionListViewOptions,
} from './sessionListView.ts'

// AR3B：turn timeline 视图模型（消息 + 工具 + diff → 可回看的分组时间线）
export {
  COMPACT_SUMMARY_MARKER,
  buildTurnTimeline,
  type TimelineItem,
  type TimelineTurn,
  type TimelineFileDiff,
  type BuildTurnTimelineOptions,
} from './turnTimeline.ts'

// AR3C：内容卡片视图模型（折叠策略与截断在 packages 决定，renderer 只渲染）
export {
  buildTimelineCards,
  type TimelineCard,
  type TimelineCardKind,
  type TimelineCardStatus,
  type BuildTimelineCardsOptions,
} from './timelineCards.ts'

// AR3D：composer 意图 → 会话控制请求（queue/steer 显式化，不靠默认态）
export {
  buildComposerActions,
  composerIntentToControl,
  type ComposerAction,
  type ComposerActionOption,
  type ComposerRunnerState,
  type ComposerControlRequest,
  type ComposerIntentInput,
  type ComposerIntentResult,
} from './composerIntent.ts'

// OI-15B：retained slash command panel/toast 的纯单槽状态机
export {
  createCliCommandSurfaceState,
  reduceCliCommandSurfaceState,
  type CliCommandPanelInput,
  type CliCommandPanelState,
  type CliCommandSurfaceAction,
  type CliCommandSurfaceState,
  type CliCommandSurfaceToken,
  type CliCommandSurfaceTone,
  type CliCommandToastInput,
  type CliCommandToastState,
} from './cliCommandSurface.ts'

// OI-14B：CLI live transcript / activity / composer / overlay 的纯状态真源
export {
  CLI_TUI_BLOCK_KINDS,
  CLI_TUI_BLOCK_STATUSES,
  CLI_TUI_COMPOSER_MODES,
  CLI_TUI_OVERLAY_MODES,
  createCliTuiViewState,
  createCliTuiViewStateFromMessages,
  projectCliTuiSessionEvent,
  reduceCliTuiViewState,
  selectCliTuiActiveBlock,
  type CliTuiAssistantBlock,
  type CliTuiBlock,
  type CliTuiBlockBase,
  type CliTuiBlockKind,
  type CliTuiBlockStatus,
  type CliTuiComposerMode,
  type CliTuiComposerState,
  type CliTuiErrorBlock,
  type CliTuiOverlayMode,
  type CliTuiOverlayState,
  type CliTuiPermissionPreview,
  type CliTuiPermissionRequest,
  type CliTuiReasoningBlock,
  type CliTuiSearchBlock,
  type CliTuiSearchCitation,
  type CliTuiSessionEvent,
  type CliTuiSummaryBlock,
  type CliTuiTerminal,
  type CliTuiToolBlock,
  type CliTuiToolPresentationRecord,
  type CliTuiTurnState,
  type CliTuiTurnStatus,
  type CliTuiUserBlock,
  type CliTuiViewAction,
  type CliTuiViewState,
  type CliTuiWarningBlock,
} from './cliTuiViewState.ts'

// AR3E：secret 不越过进程/持久化边界
export { redactSecretsDeep } from './secretBoundary.ts'
export {
  SGR_MOUSE_DISABLE,
  SGR_MOUSE_ENABLE,
  isSgrMouseSequence,
  parseSgrMouseSequence,
  type SgrMouseDragEvent,
  type SgrMouseEvent,
  type SgrMousePressEvent,
  type SgrMouseReleaseEvent,
  type SgrMouseWheelEvent,
} from './tuiMouse.ts'
export {
  READ_ONLY_GROUP_MIN_MEMBERS,
  groupAdjacentReadTools,
  isAbsorbableThinkingBlock,
  isReadOnlyGroupableToolBlock,
  type CliTuiBlockProjection,
  type ReadToolGroup,
} from './toolGrouping.ts'
export {
  TOOL_REPETITION_ABORT_THRESHOLD,
  TOOL_REPETITION_WARN_THRESHOLD,
  advanceToolRepetition,
  createToolRepetitionState,
  fingerprintToolCall,
  formatToolRepetitionReminder,
  toolRepetitionStage,
  type ToolCallFingerprint,
  type ToolRepetitionStage,
  type ToolRepetitionState,
} from './toolRepetition.ts'
export { repairToolMessagePairs } from './messageRepair.ts'
export {
  DA2_QUERY,
  createDefaultTerminalCapabilities,
  familyFromEnv,
  familyFromVendorId,
  isDa2Response,
  parseDa2Response,
  resolveTerminalCapabilities,
  type TerminalCapabilities,
  type TerminalFamily,
} from './terminalProbe.ts'
export {
  CsiReassembler,
  CSI_REASSEMBLY_EXPIRED_SINK_MS,
  DEFAULT_CSI_REASSEMBLY_TIMEOUT_MS,
  MAX_CSI_REASSEMBLY_PENDING_CHARS,
  isCompleteCsiSequence,
  isCsiContinuation,
  isCsiStart,
  type CsiReassemblerOptions,
} from './csiReassembly.ts'
export {
  TUI_THEME_IDS,
  TUI_THEME_LABELS,
  isTuiThemeId,
  tuiThemeLabel,
  type TuiThemeId,
} from './theme.ts'
export {
  MODEL_CATALOG,
  MODEL_CATALOG_COUNT,
  catalogCostRates,
  resolveModelCatalogEntry,
  type ModelCatalogEntry,
  type ModelCostEntry,
} from './modelCatalog.ts'
