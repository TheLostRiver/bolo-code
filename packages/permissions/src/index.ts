/**
 * 权限模式与门控 — 对照参考实现 PermissionMode / permissions 决策链语义
 * 见 docs/PERMISSIONS.md · docs/TODO_AUTO_PERMISSIONS.md
 * 无遥测；auto 分类器为 Y1–Y2 最小实现
 */

import path from 'node:path'
import { isAutoAllowlistedTool } from './autoAllowlist.ts'
import { matchDangerousBashCommand } from './dangerousPatterns.ts'
import { checkSensitivePath } from './sensitivePaths.ts'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
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
  auto: {
    id: 'auto',
    title: 'Auto',
    shortTitle: 'Auto',
    userLabel: '自动（分类器）',
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

/**
 * 子 agent 权限不得比父会话更宽（S8 最小）。
 * 排序：plan < default < acceptEdits < auto < bypassPermissions
 * auto 宽于 acceptEdits（可自动放行 shell，经分类器），窄于 bypass。
 */
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4,
}

export function permissionModeRank(mode: PermissionMode): number {
  return PERMISSION_MODE_RANK[mode] ?? 1
}

/**
 * 取父会话与 agent 定义中较严（rank 更低）的 mode。
 * defMode 缺省 / 非法 → 用 parent。
 */
export function resolveSubagentPermissionMode(
  parentMode: PermissionMode,
  defMode?: PermissionMode | string,
): PermissionMode {
  if (defMode == null || defMode === '') return parentMode
  const child = parsePermissionMode(
    typeof defMode === 'string' ? defMode : undefined,
    parentMode,
  )
  // parse 失败时若 def 非法会回退 parentMode，再取 min 仍是 parent
  if (typeof defMode === 'string' && !isPermissionMode(defMode)) {
    return parentMode
  }
  return permissionModeRank(child) <= permissionModeRank(parentMode)
    ? child
    : parentMode
}

/** Shift+Tab 风格循环：default → acceptEdits → plan → auto → bypass → default */
export function getNextPermissionMode(mode: PermissionMode): PermissionMode {
  switch (mode) {
    case 'default':
      return 'acceptEdits'
    case 'acceptEdits':
      return 'plan'
    case 'plan':
      return 'auto'
    case 'auto':
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
 * 会话级权限规则（对照参考实现 session permission rules；无遥测）。
 * 可经 SessionSnapshot / JSONL meta 本地持久化。
 *
 * Always-allow（TP*）：
 * - alwaysAllowPathGlobs：相对 cwd 的路径 glob
 * - alwaysAllowBashPrefixes：Bash 模式（前缀 / 通配 * / 遗留 :*）
 *
 * Always-deny（分类器小步 / 规则匹配增强）：
 * - 硬 deny 优先于 bypass / always-allow / 模式矩阵（对照参考实现 deny 规则先于 mode）
 * - plan 写/壳/MCP 仍 deny（与 always-allow 不可覆盖一致）
 */
export type SessionPermissionRules = {
  alwaysAllowToolNames: string[]
  alwaysAllowPrefixes?: string[]
  /** 路径 glob（如 src 下全部、任意 .ts）；相对 cwd 匹配 */
  alwaysAllowPathGlobs?: string[]
  /**
   * Bash 允许模式：
   * - 纯前缀：`git ` → startsWith
   * - 遗留：`git:*` → 前缀 `git`
   * - 通配：`git *` / `npm * --watch`（`*` 匹配任意子串；`\\*` 字面星号）
   */
  alwaysAllowBashPrefixes?: string[]
  /** 硬 deny：精确工具名 */
  alwaysDenyToolNames?: string[]
  /** 硬 deny：工具名前缀（如 mcp__untrusted） */
  alwaysDenyPrefixes?: string[]
  /** 硬 deny：路径 glob */
  alwaysDenyPathGlobs?: string[]
  /** 硬 deny：Bash 模式（语义同 alwaysAllowBashPrefixes） */
  alwaysDenyBashPrefixes?: string[]
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

/**
 * Bash 规则模式匹配（对照参考实现 shellRuleMatching 语义，无遥测）。
 *
 * - `foo:*` → 前缀 `foo`（遗留）
 * - 含未转义 `*` → 通配（`git *` 同时匹配 `git` 与 `git status`）
 * - 否则 → trim 后 startsWith（保留既有前缀语义）
 */
export function matchBashPattern(command: string, pattern: string): boolean {
  const cmd = command.trim()
  const pat = pattern.trim()
  if (!cmd || !pat) return false

  // 遗留 prefix:* 
  if (pat.endsWith(':*') && !pat.slice(0, -2).includes('*')) {
    const prefix = pat.slice(0, -2)
    return prefix.length > 0 && cmd.startsWith(prefix)
  }

  // 通配：未转义 *
  if (bashPatternHasWildcard(pat)) {
    return matchBashWildcard(pat, cmd)
  }

  // 纯前缀
  return cmd.startsWith(pat)
}

function bashPatternHasWildcard(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '*') continue
    let backslashCount = 0
    let j = i - 1
    while (j >= 0 && pattern[j] === '\\') {
      backslashCount++
      j--
    }
    if (backslashCount % 2 === 0) return true
  }
  return false
}

const ESCAPED_STAR = '\x00STAR\x00'
const ESCAPED_BS = '\x00BS\x00'

function matchBashWildcard(pattern: string, command: string): boolean {
  let processed = ''
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]!
      if (next === '*') {
        processed += ESCAPED_STAR
        i += 2
        continue
      }
      if (next === '\\') {
        processed += ESCAPED_BS
        i += 2
        continue
      }
    }
    processed += c
    i += 1
  }

  let escaped = ''
  for (const c of processed) {
    if ('+.?^${}()|[]"\''.includes(c)) escaped += '\\' + c
    else escaped += c
  }
  let regexPattern = escaped
    .replace(/\*/g, '.*')
    .split(ESCAPED_STAR)
    .join('\\*')
    .split(ESCAPED_BS)
    .join('\\\\')

  // 仅一个通配且形如 `cmd *` 时，尾部空格+参数可选（bare `git` 也命中）
  const starCount = (processed.match(/\*/g) || []).length
  if (regexPattern.endsWith(' .*') && starCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + '( .*)?'
  }

  try {
    return new RegExp(`^${regexPattern}$`, 's').test(command)
  } catch {
    return false
  }
}

export type AlwaysAllowMatchOpts = {
  toolInput?: unknown
  cwd?: string
}

function matchesToolNameList(toolName: string, names?: string[]): boolean {
  return !!names?.length && names.includes(toolName)
}

function matchesToolPrefixList(toolName: string, prefixes?: string[]): boolean {
  if (!prefixes?.length) return false
  for (const p of prefixes) {
    if (p && toolName.startsWith(p)) return true
  }
  return false
}

function matchesBashPatternList(
  toolName: string,
  patterns: string[] | undefined,
  input: unknown,
): boolean {
  if (!patterns?.length || toolName !== 'Bash') return false
  const cmd = extractCommandFromInput(input)?.trim() ?? ''
  if (!cmd) return false
  for (const pat of patterns) {
    if (pat && matchBashPattern(cmd, pat)) return true
  }
  return false
}

/**
 * 是否命中 always-allow：
 * 1) 精确工具名 / 工具名前缀
 * 2) 路径 glob（带 path 的工具）
 * 3) Bash 模式（前缀 / 通配 / :*）
 */
export function matchesAlwaysAllow(
  toolName: string,
  rules?: SessionPermissionRules | null,
  opts?: AlwaysAllowMatchOpts,
): boolean {
  if (!rules) return false
  if (matchesToolNameList(toolName, rules.alwaysAllowToolNames)) return true
  if (matchesToolPrefixList(toolName, rules.alwaysAllowPrefixes)) return true

  const input = opts?.toolInput
  const cwd = opts?.cwd ?? process.cwd()

  const pathGlobs = rules.alwaysAllowPathGlobs
  if (pathGlobs?.length) {
    const p = extractPathFromInput(input)
    if (p && pathMatchesAnyGlob(cwd, p, pathGlobs)) return true
  }

  if (matchesBashPatternList(toolName, rules.alwaysAllowBashPrefixes, input)) {
    return true
  }

  return false
}

/**
 * 是否命中 always-deny（硬规则；优先于 bypass / allow / 模式矩阵）。
 */
export function matchesAlwaysDeny(
  toolName: string,
  rules?: SessionPermissionRules | null,
  opts?: AlwaysAllowMatchOpts,
): boolean {
  if (!rules) return false
  if (matchesToolNameList(toolName, rules.alwaysDenyToolNames)) return true
  if (matchesToolPrefixList(toolName, rules.alwaysDenyPrefixes)) return true

  const input = opts?.toolInput
  const cwd = opts?.cwd ?? process.cwd()

  const pathGlobs = rules.alwaysDenyPathGlobs
  if (pathGlobs?.length) {
    const p = extractPathFromInput(input)
    if (p && pathMatchesAnyGlob(cwd, p, pathGlobs)) return true
  }

  if (matchesBashPatternList(toolName, rules.alwaysDenyBashPrefixes, input)) {
    return true
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

/** 就地加入 Bash 允许模式（去重；仅 trim 两端） */
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

/** 就地加入会话 always-deny 工具名（去重） */
export function addAlwaysDenyToolName(
  rules: SessionPermissionRules,
  toolName: string,
): SessionPermissionRules {
  const name = toolName.trim()
  if (!name) return rules
  if (!rules.alwaysDenyToolNames) rules.alwaysDenyToolNames = []
  if (!rules.alwaysDenyToolNames.includes(name)) {
    rules.alwaysDenyToolNames.push(name)
  }
  return rules
}

/** 就地加入硬 deny 路径 glob（去重） */
export function addAlwaysDenyPathGlob(
  rules: SessionPermissionRules,
  glob: string,
): SessionPermissionRules {
  const g = glob.trim()
  if (!g) return rules
  if (!rules.alwaysDenyPathGlobs) rules.alwaysDenyPathGlobs = []
  if (!rules.alwaysDenyPathGlobs.includes(g)) {
    rules.alwaysDenyPathGlobs.push(g)
  }
  return rules
}

/** 就地加入硬 deny Bash 模式（去重） */
export function addAlwaysDenyBashPrefix(
  rules: SessionPermissionRules,
  prefix: string,
): SessionPermissionRules {
  const p = prefix.trim()
  if (!p) return rules
  if (!rules.alwaysDenyBashPrefixes) rules.alwaysDenyBashPrefixes = []
  if (!rules.alwaysDenyBashPrefixes.includes(p)) {
    rules.alwaysDenyBashPrefixes.push(p)
  }
  return rules
}

/** 就地加入硬 deny 工具名前缀（去重） */
export function addAlwaysDenyPrefix(
  rules: SessionPermissionRules,
  prefix: string,
): SessionPermissionRules {
  const p = prefix.trim()
  if (!p) return rules
  if (!rules.alwaysDenyPrefixes) rules.alwaysDenyPrefixes = []
  if (!rules.alwaysDenyPrefixes.includes(p)) {
    rules.alwaysDenyPrefixes.push(p)
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
 * 纯函数门控 — 对照参考实现规则优先 + 模式矩阵的最小表驱动版
 *
 * 顺序：
 * 1. always-deny（硬规则，**含** bypass / auto）
 * 2. bypass → allow
 * 3. plan（写/壳/MCP 仍 deny，优先于 always-allow）
 * 4. always-allow
 * 5. auto：白名单 allow；acceptEdits 可放行的 edit → allow；其余 → ask（由 runToolUse 调分类器）
 * 6. acceptEdits / default 矩阵
 *
 * auto 的 LLM 分类在 toolExecution 异步路径；此处仅同步规则。
 */
export function decidePermission(input: GateInput): GateResult {
  const category = classifyTool(input.toolName)
  const mode = input.mode
  const base = { category, mode }
  const matchOpts = {
    toolInput: input.toolInput,
    cwd: input.cwd,
  }

  // 1. 硬 deny：即使用户开 bypass 也拦（对照参考实现 deny 规则优先）
  if (matchesAlwaysDeny(input.toolName, input.rules, matchOpts)) {
    return {
      ...base,
      behavior: 'deny',
      reason: 'session always-deny rule',
    }
  }

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

  if (matchesAlwaysAllow(input.toolName, input.rules, matchOpts)) {
    return {
      ...base,
      behavior: 'allow',
      reason: 'session always-allow rule',
    }
  }

  // auto：同步快路径 + 危险硬 deny；其余 ask → 分类器（toolExecution）
  if (mode === 'auto') {
    // Y3.3 危险 Bash 命令 → 硬 deny（不调分类器）
    if (input.toolName === 'Bash') {
      const cmd =
        input.toolInput &&
        typeof input.toolInput === 'object' &&
        typeof (input.toolInput as { command?: unknown }).command === 'string'
          ? String((input.toolInput as { command: string }).command)
          : ''
      const dang = matchDangerousBashCommand(cmd)
      if (dang.matched) {
        return {
          ...base,
          behavior: 'deny',
          reason: `auto: dangerous bash pattern (${dang.pattern})`,
        }
      }
    }

    // Y3.5 Agent 不在白名单：强制分类器
    if (input.toolName === 'Agent') {
      return {
        ...base,
        behavior: 'ask',
        reason: 'auto: Agent requires classifier',
      }
    }

    if (isAutoAllowlistedTool(input.toolName) || category === 'read') {
      return {
        ...base,
        behavior: 'allow',
        reason: 'auto: allowlisted / read',
      }
    }
    if (category === 'edit') {
      const p = extractPathFromInput(input.toolInput)
      if (p) {
        const sens = checkSensitivePath(p, input.cwd)
        if (sens.sensitive && sens.hardDeny) {
          return {
            ...base,
            behavior: 'deny',
            reason: `auto: ${sens.reason}`,
          }
        }
        if (sens.sensitive) {
          // 不快路径 allow；走分类器
          return {
            ...base,
            behavior: 'ask',
            reason: `auto: sensitive path needs classifier (${sens.reason})`,
          }
        }
        if (isPathInsideCwd(input.cwd, p)) {
          return {
            ...base,
            behavior: 'allow',
            reason: 'auto: edit inside cwd (acceptEdits fast-path)',
          }
        }
      }
    }
    // 需分类器（或熔断后 fallback）
    return {
      ...base,
      behavior: 'ask',
      reason: 'auto: needs classifier',
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

// re-exports for auto subsystem
export {
  isAutoAllowlistedTool,
  AUTO_ALLOWLIST_TOOLS,
} from './autoAllowlist.ts'
export {
  createAutoModeState,
  recordAutoClassifySuccess,
  recordAutoClassifyFailure,
  resetAutoModeCircuit,
  DEFAULT_AUTO_CIRCUIT_THRESHOLD,
  type AutoModeState,
  type AutoModeFallback,
} from './autoMode.ts'
export {
  parseAutoClassifierResponse,
  buildAutoClassifierSystemPrompt,
  buildAutoClassifierFastSystemPrompt,
  buildAutoClassifierUserPrompt,
  buildClassifierMessages,
  createAutoClassifyFromCompleteText,
  truncateForClassifier,
  serializeToolInputForClassifier,
  DEFAULT_AUTO_CLASSIFY_TIMEOUT_MS,
  MAX_CLASSIFIER_SUMMARY_CHARS,
  MAX_CLASSIFIER_INPUT_JSON_CHARS,
  type AutoClassifyInput,
  type AutoClassifyResult,
  type AutoClassifyFn,
} from './autoClassifier.ts'
export { stripDangerousAllowsForAuto } from './stripDangerousAllows.ts'
export {
  matchDangerousBashCommand,
  isDangerousBashAllowPrefix,
  DANGEROUS_BASH_COMMAND_PATTERNS,
  DANGEROUS_POWERSHELL_COMMAND_PATTERNS,
} from './dangerousPatterns.ts'
export {
  checkSensitivePath,
  type SensitivePathResult,
} from './sensitivePaths.ts'