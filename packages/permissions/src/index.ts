/**
 * 权限模式与门控 — 对照 HelsincyCode PermissionMode / permissions 语义
 * 见 docs/PERMISSIONS.md
 * 无遥测、无 auto 分类器
 */

import path from 'node:path'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type ToolCategory = 'read' | 'edit' | 'shell' | 'mcp' | 'unknown'

export type PermissionModeMeta = {
  id: PermissionMode
  title: string
  shortTitle: string
  /** 用户口语 */
  userLabel: string
}

export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  default: {
    id: 'default',
    title: 'Default',
    shortTitle: 'Default',
    userLabel: '请求批准',
  },
  acceptEdits: {
    id: 'acceptEdits',
    title: 'Accept edits',
    shortTitle: 'Accept',
    userLabel: '自动审批（编辑）',
  },
  plan: {
    id: 'plan',
    title: 'Plan Mode',
    shortTitle: 'Plan',
    userLabel: 'Plan',
  },
  bypassPermissions: {
    id: 'bypassPermissions',
    title: 'Bypass Permissions',
    shortTitle: 'Bypass',
    userLabel: '完全访问',
  },
}

export function isPermissionMode(v: string): v is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(v)
}

export function parsePermissionMode(
  v: string | undefined,
  fallback: PermissionMode = 'default',
): PermissionMode {
  if (v && isPermissionMode(v)) return v
  return fallback
}

/** Shift+Tab 风格循环（对照 getNextPermissionMode，无 auto/dontAsk） */
export function getNextPermissionMode(mode: PermissionMode): PermissionMode {
  switch (mode) {
    case 'default':
      return 'acceptEdits'
    case 'acceptEdits':
      return 'plan'
    case 'plan':
      return 'bypassPermissions'
    case 'bypassPermissions':
      return 'default'
  }
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill'])
const EDIT_TOOLS = new Set(['Write', 'apply_patch', 'Edit'])
const SHELL_TOOLS = new Set(['Bash'])

export function classifyTool(toolName: string): ToolCategory {
  if (toolName.startsWith('mcp__')) return 'mcp'
  if (READ_TOOLS.has(toolName)) return 'read'
  if (EDIT_TOOLS.has(toolName)) return 'edit'
  if (SHELL_TOOLS.has(toolName)) return 'shell'
  return 'unknown'
}

function extractPathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  if (typeof rec.path === 'string') return rec.path
  if (typeof rec.file_path === 'string') return rec.file_path
  if (typeof rec.filePath === 'string') return rec.filePath
  return undefined
}

/** 路径是否在 cwd 内（acceptEdits 快路径） */
export function isPathInsideCwd(cwd: string, filePath: string): boolean {
  try {
    const abs = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(cwd, filePath)
    const root = path.resolve(cwd)
    return abs === root || abs.startsWith(root + path.sep)
  } catch {
    return false
  }
}

/**
 * 会话级 Always-allow 规则（对照 HC session permission rules；无遥测）。
 * 可经 SessionSnapshot 本地持久化；plan 模式下写/壳/MCP 仍 deny，不受 alwaysAllow 覆盖。
 */
export type SessionPermissionRules = {
  alwaysAllowToolNames: string[]
  alwaysAllowPrefixes?: string[]
}

export function createEmptyPermissionRules(): SessionPermissionRules {
  return { alwaysAllowToolNames: [] }
}

/** toolName 是否命中 always-allow（精确名或前缀） */
export function matchesAlwaysAllow(
  toolName: string,
  rules?: SessionPermissionRules | null,
): boolean {
  if (!rules) return false
  if (rules.alwaysAllowToolNames.includes(toolName)) return true
  const prefixes = rules.alwaysAllowPrefixes
  if (prefixes?.length) {
    for (const p of prefixes) {
      if (p && toolName.startsWith(p)) return true
    }
  }
  return false
}

/** 就地加入会话 always-allow 工具名（去重） */
export function addAlwaysAllowToolName(
  rules: SessionPermissionRules,
  toolName: string,
): SessionPermissionRules {
  const name = toolName.trim()
  if (name && !rules.alwaysAllowToolNames.includes(name)) {
    rules.alwaysAllowToolNames.push(name)
  }
  return rules
}

export type GateInput = {
  mode: PermissionMode
  toolName: string
  toolInput: unknown
  cwd: string
  /**
   * tool 元数据：若明确 requiresPermission=false，default 下可读类已 allow；
   * 对 unknown 工具更保守。
   */
  requiresPermission?: boolean
  /** 会话 Always-allow 规则；bypass 之后、plan 仍优先 deny 写操作 */
  rules?: SessionPermissionRules | null
}

export type GateResult = {
  behavior: PermissionBehavior
  reason: string
  category: ToolCategory
  mode: PermissionMode
}

/**
 * 纯函数门控 — 对照 HC 模式变换的最小表驱动版
 *
 * 顺序：bypass → plan（写仍 deny）→ alwaysAllow rules → acceptEdits / default
 */
export function decidePermission(input: GateInput): GateResult {
  const category = classifyTool(input.toolName)
  const mode = input.mode
  const base = { category, mode }

  if (mode === 'bypassPermissions') {
    return {
      ...base,
      behavior: 'allow',
      reason: 'bypassPermissions: allow all',
    }
  }

  // plan 优先于 always-allow：规划态仍禁止写/壳/MCP
  if (mode === 'plan') {
    if (category === 'read') {
      return { ...base, behavior: 'allow', reason: 'plan: read allowed' }
    }
    return {
      ...base,
      behavior: 'deny',
      reason: `plan: ${category} not allowed (planning only)`,
    }
  }

  if (matchesAlwaysAllow(input.toolName, input.rules)) {
    return {
      ...base,
      behavior: 'allow',
      reason: 'session always-allow rule',
    }
  }

  if (mode === 'acceptEdits') {
    if (category === 'read') {
      return { ...base, behavior: 'allow', reason: 'acceptEdits: read allowed' }
    }
    if (category === 'edit') {
      const p = extractPathFromInput(input.toolInput)
      if (p && isPathInsideCwd(input.cwd, p)) {
        return {
          ...base,
          behavior: 'allow',
          reason: 'acceptEdits: edit inside cwd',
        }
      }
      if (!p) {
        // 无路径信息时保守 ask
        return {
          ...base,
          behavior: 'ask',
          reason: 'acceptEdits: edit without path → ask',
        }
      }
      return {
        ...base,
        behavior: 'ask',
        reason: 'acceptEdits: edit outside cwd → ask',
      }
    }
    // shell / mcp / unknown
    return {
      ...base,
      behavior: 'ask',
      reason: `acceptEdits: ${category} → ask`,
    }
  }

  // default
  if (category === 'read' || input.requiresPermission === false) {
    return {
      ...base,
      behavior: 'allow',
      reason: 'default: read / no-permission tool allowed',
    }
  }
  if (input.requiresPermission === true || category !== 'unknown') {
    return {
      ...base,
      behavior: 'ask',
      reason: `default: ${category} → ask`,
    }
  }
  return {
    ...base,
    behavior: 'ask',
    reason: 'default: unknown tool → ask',
  }
}