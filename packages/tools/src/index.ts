/** 内置工具注册表骨架 — 执行必须经 core PermissionGate */

export type ToolSpec = {
  name: string
  description: string
  /** 是否默认触发 PermissionRequest */
  requiresPermission: boolean
}

export const BUILTIN_TOOLS: ToolSpec[] = [
  { name: 'Bash', description: 'Run a shell command', requiresPermission: true },
  { name: 'Read', description: 'Read a file', requiresPermission: false },
  { name: 'Write', description: 'Write a file', requiresPermission: true },
  { name: 'apply_patch', description: 'Apply a multi-file patch', requiresPermission: true },
  { name: 'Glob', description: 'Find files by pattern', requiresPermission: false },
  { name: 'Grep', description: 'Search file contents', requiresPermission: false },
]

export function listToolNames(): string[] {
  return BUILTIN_TOOLS.map((t) => t.name)
}