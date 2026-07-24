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
 * 会话级 Always-allow 规则（对照参考实现 session permission rules；无遥测）。
 * 可经 SessionSnapshot 本地持久化；plan 模式下写/壳/MCP 仍 deny，不受 alwaysAllow 覆盖。
 *
 * 扩展（TP*）：
 * - alwaysAllowPathGlobs：相对 cwd 的路径 glob（Read/Write/Edit/apply_patch 等带 path 的工具）
 * - alwaysAllowBashPrefixes：Bash command 字符串前缀（trim 后 startsWith）
 */
export type SessionPermissionRules = {
  alwaysAllowToolNames: string[]
  alwaysAllowPrefixes?: string[]
  /** 路径 glob（如 src 下全部、任意 .ts）；相对 cwd 匹配 */
  alwaysAllowPathGlobs?: string[]
  /** Bash 命令前缀（如 "git "、"npm test"） */
  alwaysAllowBashPrefixes?: string[]
}

export function createEmptyPermissionRules(): SessionPermissionRules {
  return { alwaysAllowToolNames: [] }
}

/** 极简 path glob：星号与问号（与 tools matchGlob 语义对齐，供权限规则用） */
export function matchPathGlob(relOrAbs: string, pattern: string): boolean {
  const norm = relOrAbs.split(path.sep).join('/').replace(/^\.\//, '')
  const pat = pattern.split(path.sep).join('/').replace(/^\.\//, '')
  let re = '^'
  for (let i = 0; i < pat.length; ) {
    const c = pat[i]!
    if (c === '*' && pat[i + 1] === '*') {
      if (pat[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 3
      } else {
        re += '.*'
        i += 2
      }
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    if ('+.^${}()|[]\\'.includes(c)) {
      re += '\\' + c
      i += 1
      continue
    }
    re += c
    i += 1
  }
  re += '$'
  return new RegExp(re).test(norm)
}

function pathMatchesAnyGlob(
  cwd: string,
  filePath: string,
  globs: string[],
): boolean {
  let rel: string
  try {
    const abs = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(cwd, filePath)
    const root = path.resolve(cwd)
    if (abs === root) rel = '.'
    else if (abs.startsWith(root + path.sep)) {
      rel = path.relative(root, abs).split(path.sep).join('/')
    } else {
      // cwd 外：仍用原始字符串尝试匹配（规则可写绝对路径风格）
      rel = filePath.split(path.sep).join('/')
    }
  } catch {
    rel = filePath.split(path.sep).join('/')
  }
  for (const g of globs) {
    if (g && (matchPathGlob(rel, g) || matchPathGlob(filePath, g))) return true
  }
  return false
}

function extractCommandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  if (typeof rec.command === 'string') return rec.command
  return undefined
}

export type AlwaysAllowMatchOpts = {
  toolInput?: unknown
  cwd?: string
}

/**
 * 是否命中 always-allow：
 * 1) 精确工具名 / 工具名前缀
 * 2) 路径 glob（带 path 的工具）
 * 3) Bash 命令前缀
 */
export function matchesAlwaysAllow(
  toolName: string,
  rules?: SessionPermissionRules | null,
  opts?: AlwaysAllowMatchOpts,
): boolean {
  if (!rules) return false
  if (rules.alwaysAllowToolNames.includes(toolName)) return true
  const prefixes = rules.alwaysAllowPrefixes
  if (prefixes?.length) {
    for (const p of prefixes) {
      if (p && toolName.startsWith(p)) return true
    }
  }

  const input = opts?.toolInput
  const cwd = opts?.cwd ?? process.cwd()

  const pathGlobs = rules.alwaysAllowPathGlobs
  if (pathGlobs?.length) {
    const p = extractPathFromInput(input)
    if (p && pathMatchesAnyGlob(cwd, p, pathGlobs)) return true
  }

  const bashPrefixes = rules.alwaysAllowBashPrefixes
  if (bashPrefixes?.length && toolName === 'Bash') {
    const cmd = extractCommandFromInput(input)?.trim() ?? ''
    if (cmd) {
      for (const pref of bashPrefixes) {
        if (pref && cmd.startsWith(pref)) return true
      }
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

/** 就地加入路径 glob（去重） */
export function addAlwaysAllowPathGlob(
  rules: SessionPermissionRules,
  glob: string,
): SessionPermissionRules {
  const g = glob.trim()
  if (!g) return rules
  if (!rules.alwaysAllowPathGlobs) rules.alwaysAllowPathGlobs = []
  if (!rules.alwaysAllowPathGlobs.includes(g)) {
    rules.alwaysAllowPathGlobs.push(g)
  }
  return rules
}

/** 就地加入 Bash 命令前缀（去重；保留用户给定空白语义，仅 trim 两端） */
export function addAlwaysAllowBashPrefix(
  rules: SessionPermissionRules,
  prefix: string,
): SessionPermissionRules {
  const p = prefix.trim()
  if (!p) return rules
  if (!rules.alwaysAllowBashPrefixes) rules.alwaysAllowBashPrefixes = []
  if (!rules.alwaysAllowBashPrefixes.includes(p)) {
    rules.alwaysAllowBashPrefixes.push(p)
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

  if (
    matchesAlwaysAllow(input.toolName, input.rules, {
      toolInput: input.toolInput,
      cwd: input.cwd,
    })
  ) {
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