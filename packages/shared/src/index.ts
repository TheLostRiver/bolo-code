/** 共享契约 — 类型真源 */

export const HOOK_EVENTS = [
  'PermissionRequest',
  'PostToolUse',
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
  | PreToolUseInput
  | PostToolUseInput
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
  markShellKilled,
  registerBackgroundShell,
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
  buildTurnTimeline,
  type TimelineItem,
  type TimelineTurn,
  type TimelineFileDiff,
  type BuildTurnTimelineOptions,
} from './turnTimeline.ts'
