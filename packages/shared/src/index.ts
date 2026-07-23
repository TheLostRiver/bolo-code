/** 共享契约 — 实现前的类型真源 */

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

/** matcher 被忽略的事件（配置了也始终全量触发） */
export const HOOK_EVENTS_WITHOUT_MATCHER = [
  'UserPromptSubmit',
  'Stop',
] as const satisfies readonly HookEvent[]

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
export type CompactTrigger = 'manual' | 'auto'

export type HookCommand = {
  type: 'command'
  command: string
  timeout?: number
  /** 预留：async 不阻塞主循环 */
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