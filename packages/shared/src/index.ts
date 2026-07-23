/** 共享契约 — 类型真源 */

export const HOOK_EVENTS = [
  'PermissionRequest',
  'PostToolUse',
  'PostCompact',
  'PreCompact',
  'PreToolUse',
  'SessionStart',
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
}

export type AnyHookInput =
  | PermissionRequestInput
  | PreToolUseInput
  | PostToolUseInput
  | SessionStartInput
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