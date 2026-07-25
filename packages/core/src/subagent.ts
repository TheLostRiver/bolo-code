/**
 * Subagent 运行时 — 对照 HC AgentTool / runAgent / resolveAgentTools / loadAgentsDir
 * 无遥测；默认禁止子 agent 再调 Agent。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getBoloHomeDir, getProjectLayout } from '../../config/src/paths.ts'
import { runHooks } from '../../hooks/src/index.ts'
import {
  newId,
  nowIso,
  type ChatMessage,
  type HooksConfig,
} from '../../shared/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import {
  buildTool,
  createBuiltinTools,
  type BoloTool,
} from '../../tools/src/index.ts'
import {
  isPermissionMode,
  resolveSubagentPermissionMode,
  type PermissionMode,
  type SessionPermissionRules,
} from '../../permissions/src/index.ts'
import type { QueryDeps } from './deps.ts'
import { queryLoop, type QueryLoopEvent, type Terminal } from './queryLoop.ts'
import {
  ensureTranscriptFile,
  recordSessionMessages,
} from './sessionTranscript.ts'
import type { AskPermissionFn } from './toolExecution.ts'
import { isWorktreeEnabled } from './worktree.ts'

export const AGENT_TOOL_NAME = 'Agent'

export type AgentDefinitionSource = 'builtin' | 'user' | 'project'

export type AgentDefinition = {
  agentType: string
  description: string
  /** 白名单工具名，或 '*' 表示默认可写集（仍会排除 Agent） */
  tools: string[] | '*'
  /** HC disallowedTools：从已解析工具集中再剔除 */
  disallowedTools?: string[]
  systemPrompt: string
  permissionMode?: PermissionMode
  /** 定义来源；内置为 builtin */
  source?: AgentDefinitionSource
  /** 最大 agentic turns（对照 HC maxTurns）；默认 run 侧 8 */
  maxTurns?: number
  /** 定义级默认后台跑（对照 HC background） */
  background?: boolean
  /** 何时选用（可与 description 相同；/agents 展示） */
  whenToUse?: string
  /** 默认 isolation；Agent 工具 isolation 参数可覆盖 */
  isolation?: 'none' | 'worktree'
}

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: 'explore',
  description:
    'Read-only explorer: find files and search code. Use for codebase questions without edits.',
  whenToUse:
    'Fast codebase exploration. Prefer when you need file patterns, keyword search, or architecture questions without edits. Specify thoroughness in the prompt: quick | medium | very thorough.',
  tools: ['Read', 'Glob', 'Grep'],
  disallowedTools: ['Write', 'Edit', 'ApplyPatch', 'Bash', 'Agent'],
  systemPrompt: `You are a file-search specialist for Bolo (read-only).

=== CRITICAL: READ-ONLY — NO FILE MODIFICATIONS ===
STRICTLY PROHIBITED: Write / Edit / ApplyPatch / Bash / creating or deleting files.
Use only Read, Glob, and Grep. Prefer parallel tool calls when searching.

Guidelines:
- Glob for broad file patterns; Grep for content; Read when you know the path
- Adapt thoroughness to the caller (quick / medium / very thorough)
- Reply with a concise findings report for the parent agent — do not create files`,
  permissionMode: 'default',
  source: 'builtin',
  maxTurns: 12,
}

export const GENERAL_AGENT: AgentDefinition = {
  agentType: 'general',
  description:
    'General-purpose subagent for multi-step tasks. Cannot spawn further agents.',
  whenToUse:
    'Multi-step implementation or investigation that should not pollute the parent context. Full tools except nested Agent.',
  tools: '*',
  disallowedTools: ['Agent'],
  systemPrompt: `You are a general-purpose subagent for Bolo.
Complete the task with the tools you have. Do not spawn nested agents.
When done, reply with a concise report of what you did and key findings.`,
  source: 'builtin',
}

/**
 * 只读规划子 agent（对照 HC Plan agent）。
 * 探索 + 出实现计划；禁止写文件。
 */
export const PLAN_AGENT: AgentDefinition = {
  agentType: 'plan',
  description:
    'Read-only software architect: explore the repo and design an implementation plan.',
  whenToUse:
    'When you need a step-by-step implementation strategy, critical files list, and trade-offs — without making edits yet.',
  tools: ['Read', 'Glob', 'Grep'],
  disallowedTools: ['Write', 'Edit', 'ApplyPatch', 'Bash', 'Agent'],
  permissionMode: 'plan',
  source: 'builtin',
  maxTurns: 16,
  systemPrompt: `You are a software architect and planning specialist for Bolo.

=== CRITICAL: READ-ONLY — NO FILE MODIFICATIONS ===
You may only use Read, Glob, and Grep. No Write / Edit / Bash / Agent.

Process:
1. Understand the requirements and any perspective given by the parent
2. Explore existing patterns, architecture, and similar features
3. Design an approach with trade-offs
4. Detail a step-by-step plan with dependencies and risks

End your response with:

### Critical Files for Implementation
List 3–5 paths most important for this plan:
- path/to/file1
- path/to/file2
- path/to/file3

REMEMBER: explore and plan only — never modify the tree.`,
}

/** S12 最小 fork：继承父 messages；工具=父集去掉 Agent；无 worktree / 无完整 cache 共享 */
export const FORK_AGENT: AgentDefinition = {
  agentType: 'fork',
  description:
    'Fork of the current conversation: inherits parent messages, same tools minus Agent. Use for context-heavy subtasks.',
  whenToUse:
    'Omit subagent_type or set fork when intermediate tool noise should stay out of parent context but full history is needed.',
  tools: '*',
  disallowedTools: ['Agent'],
  systemPrompt: `你是 fork 工作者。继承父会话上下文，完成指派任务后给出简洁报告。不要再 spawn 子 agent。`,
  source: 'builtin',
  maxTurns: 32,
}

const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  explore: EXPLORE_AGENT,
  general: GENERAL_AGENT,
  plan: PLAN_AGENT,
  fork: FORK_AGENT,
}

export function listBuiltinAgents(): AgentDefinition[] {
  return Object.values(BUILTIN_AGENTS).map((d) => ({ ...d, source: 'builtin' }))
}

/** 内置 + 用户 + 项目 合并表；项目覆盖同名 */
export type ActiveAgentDefinitions = Record<string, AgentDefinition>

export function builtinAgentMap(): ActiveAgentDefinitions {
  const out: ActiveAgentDefinitions = {}
  for (const [k, v] of Object.entries(BUILTIN_AGENTS)) {
    out[k] = { ...v, source: 'builtin' }
  }
  return out
}

/**
 * 合并 agent 定义层：后者覆盖同名 agentType。
 * 典型顺序：builtin → user → project
 */
export function mergeAgentDefinitions(
  ...layers: Array<readonly AgentDefinition[] | ActiveAgentDefinitions>
): ActiveAgentDefinitions {
  const out = builtinAgentMap()
  for (const layer of layers) {
    const list = Array.isArray(layer) ? layer : Object.values(layer)
    for (const def of list) {
      const key = def.agentType.trim().toLowerCase()
      if (!key) continue
      out[key] = { ...def, agentType: key }
    }
  }
  return out
}

export function listActiveAgents(
  active?: ActiveAgentDefinitions | null,
): AgentDefinition[] {
  const map = active && Object.keys(active).length ? active : builtinAgentMap()
  return Object.values(map).sort((a, b) =>
    a.agentType.localeCompare(b.agentType),
  )
}

export function getAgentDefinition(
  agentType: string | undefined | null,
  active?: ActiveAgentDefinitions | null,
): AgentDefinition {
  const key = (agentType ?? 'general').trim().toLowerCase()
  const map = active && Object.keys(active).length ? active : builtinAgentMap()
  const def = map[key]
  if (!def) {
    const known = Object.keys(map).sort().join(', ')
    throw new Error(
      `Unknown subagent_type "${agentType}". Known: ${known || '(none)'}`,
    )
  }
  return def
}

// ── frontmatter / loadAgentsDir（对照 HC loadAgentsDir，无遥测）──

function parseBoolish(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true
  if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false
  return undefined
}

/** 解析 tools: * | tools: Read, Glob | 多行 - Read */
export function parseToolsField(raw: string): string[] | '*' | undefined {
  const t = raw.trim()
  if (!t) return undefined
  if (t === '*' || t === '"*"' || t === "'*'") return '*'
  // YAML list inline: [Read, Glob] or Read, Glob
  const unbracket = t.replace(/^\[/, '').replace(/\]$/, '').trim()
  if (unbracket === '*') return '*'
  const parts = unbracket
    .split(/[,]+/)
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  if (!parts.length) return undefined
  if (parts.length === 1 && parts[0] === '*') return '*'
  return parts
}

export function parseAgentFrontmatter(raw: string): {
  meta: Record<string, string>
  body: string
  toolsLines: string[]
} {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) {
    return { meta: {}, body: text, toolsLines: [] }
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) {
    return { meta: {}, body: text, toolsLines: [] }
  }
  const fmBlock = text.slice(3, end).replace(/^\r?\n/, '')
  let body = text.slice(end + 4)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)

  const meta: Record<string, string> = {}
  const toolsLines: string[] = []
  let inToolsList = false

  for (const line of fmBlock.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const listItem = /^-\s+(.+)$/.exec(trimmed)
    if (inToolsList && listItem) {
      toolsLines.push(listItem[1]!.replace(/^["']|["']$/g, '').trim())
      continue
    }
    if (inToolsList && !listItem) {
      inToolsList = false
    }

    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed)
    if (!m) continue
    const key = m[1]!
    const val = m[2]!.trim()
    const keyLower = key.toLowerCase()
    if (keyLower === 'tools') {
      if (!val || val === '|' || val === '>') {
        inToolsList = true
        continue
      }
      meta.tools = val.replace(/^["']|["']$/g, '').trim()
      inToolsList = false
      continue
    }
    inToolsList = false
    meta[keyLower] = val.replace(/^["']|["']$/g, '').trim()
  }

  return { meta, body, toolsLines }
}

export function agentDefinitionFromMarkdown(
  raw: string,
  filePath: string,
  source: AgentDefinitionSource,
): AgentDefinition | null {
  const { meta, body, toolsLines } = parseAgentFrontmatter(raw)
  if (parseBoolish(meta.disabled ?? '') === true) return null

  const baseName = path.basename(filePath, path.extname(filePath))
  const agentType = (
    meta.agenttype ||
    meta.name ||
    meta.id ||
    baseName
  )
    .trim()
    .toLowerCase()
  if (!agentType) return null

  let tools: string[] | '*' = '*'
  if (toolsLines.length) {
    tools =
      toolsLines.length === 1 && toolsLines[0] === '*'
        ? '*'
        : toolsLines.filter((t) => t !== '*')
    if (Array.isArray(tools) && tools.includes('*')) tools = '*'
  } else if (meta.tools != null) {
    const parsed = parseToolsField(meta.tools)
    if (parsed !== undefined) tools = parsed
  }

  let permissionMode: PermissionMode | undefined
  if (meta.permissionmode && isPermissionMode(meta.permissionmode)) {
    permissionMode = meta.permissionmode
  }

  let maxTurns: number | undefined
  if (meta.maxturns != null && meta.maxturns !== '') {
    const n = Number(meta.maxturns)
    if (Number.isFinite(n) && n >= 1) maxTurns = Math.min(200, Math.floor(n))
  }

  let background: boolean | undefined
  if (meta.background != null && meta.background !== '') {
    const b = parseBoolish(String(meta.background))
    if (b === true) background = true
    if (b === false) background = false
  }

  let disallowedTools: string[] | undefined
  if (meta.disallowedtools != null && meta.disallowedtools !== '') {
    const parts = String(meta.disallowedtools)
      .split(/[,|\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length) disallowedTools = parts
  }

  let isolation: 'none' | 'worktree' | undefined
  if (meta.isolation != null) {
    const iso = String(meta.isolation).trim().toLowerCase()
    if (iso === 'worktree') isolation = 'worktree'
    if (iso === 'none' || iso === 'off') isolation = 'none'
  }

  const description =
    meta.description?.trim() ||
    meta.whentouse?.trim() ||
    `Custom subagent "${agentType}" from ${source} .bolo/agents`

  const whenToUse = meta.whentouse?.trim() || undefined

  const systemBody = body.trim()
  // body = system 内容；覆盖内置时由 merge 整表替换；空 body 给简短默认
  const systemPrompt =
    systemBody ||
    `You are the "${agentType}" subagent. Complete the assigned task and reply with a concise report.`

  return {
    agentType,
    description,
    tools,
    systemPrompt,
    permissionMode,
    source,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(isolation ? { isolation } : {}),
  }
}

async function readAgentMarkdownFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => path.join(dir, e.name))
    .sort()
}

export type LoadAgentsDirOptions = {
  cwd: string
  /** 覆盖用户配置根（测试用）；默认 getBoloHomeDir() */
  userConfigDir?: string
  loadUserAgents?: boolean
  loadProjectAgents?: boolean
}

export type LoadAgentsDirResult = {
  agents: AgentDefinition[]
  /** 合并后的 active 表（含内置） */
  active: ActiveAgentDefinitions
  errors: string[]
}

/**
 * 发现 `~/.bolo/agents/*.md` + `{cwd}/.bolo/agents/*.md`，
 * 合并进内置表；项目覆盖用户与同名内置。
 */
export async function loadAgentsDir(
  opts: LoadAgentsDirOptions,
): Promise<LoadAgentsDirResult> {
  const cwd = path.resolve(opts.cwd)
  const userRoot = opts.userConfigDir ?? getBoloHomeDir()
  const errors: string[] = []
  const userAgents: AgentDefinition[] = []
  const projectAgents: AgentDefinition[] = []

  if (opts.loadUserAgents !== false) {
    const dir = path.join(userRoot, 'agents')
    for (const file of await readAgentMarkdownFiles(dir)) {
      try {
        const raw = await fs.readFile(file, 'utf8')
        const def = agentDefinitionFromMarkdown(raw, file, 'user')
        if (def) userAgents.push(def)
      } catch (e) {
        errors.push(
          `user agent ${file}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  if (opts.loadProjectAgents !== false) {
    const dir = path.join(cwd, '.bolo', 'agents')
    for (const file of await readAgentMarkdownFiles(dir)) {
      try {
        const raw = await fs.readFile(file, 'utf8')
        const def = agentDefinitionFromMarkdown(raw, file, 'project')
        if (def) projectAgents.push(def)
      } catch (e) {
        errors.push(
          `project agent ${file}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  const active = mergeAgentDefinitions(userAgents, projectAgents)
  return {
    agents: [...userAgents, ...projectAgents],
    active,
    errors,
  }
}

export type ResolveAgentToolsResult = {
  resolvedTools: BoloTool[]
  /** 白名单里不存在的名字 */
  invalidTools: string[]
  hasWildcard: boolean
}

/**
 * 按 AgentDefinition 裁剪工具；始终排除 Agent（防递归）。
 * 支持 disallowedTools 二次剔除（HC loadAgentsDir 语义）。
 */
export function resolveAgentTools(
  def: Pick<AgentDefinition, 'tools' | 'disallowedTools'>,
  allTools: readonly BoloTool[],
): ResolveAgentToolsResult {
  const withoutAgent = allTools.filter((t) => t.name !== AGENT_TOOL_NAME)
  const hasWildcard =
    def.tools === '*' ||
    (Array.isArray(def.tools) && def.tools.includes('*'))

  let resolvedTools: BoloTool[]
  const invalidTools: string[] = []

  if (hasWildcard) {
    resolvedTools = [...withoutAgent]
  } else {
    const allow = new Set(
      (def.tools as string[]).map((n) => n.trim()).filter(Boolean),
    )
    allow.delete(AGENT_TOOL_NAME)
    const byName = new Map(withoutAgent.map((t) => [t.name, t]))
    resolvedTools = []
    for (const name of allow) {
      const t = byName.get(name)
      if (t) resolvedTools.push(t)
      else invalidTools.push(name)
    }
  }

  if (def.disallowedTools?.length) {
    const ban = new Set(
      def.disallowedTools.map((n) => n.trim()).filter(Boolean),
    )
    ban.add(AGENT_TOOL_NAME)
    resolvedTools = resolvedTools.filter((t) => !ban.has(t.name))
  }

  return { resolvedTools, invalidTools, hasWildcard }
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.content?.trim()) {
      return m.content.trim()
    }
  }
  return ''
}

/** 对照 HC countToolUses：统计 assistant.tool_calls 条数 */
export function countToolUses(messages: readonly ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    const calls = m.tool_calls
    if (Array.isArray(calls)) n += calls.length
  }
  return n
}

/** 格式化耗时（本地展示；无遥测） */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/**
 * 对照 HC finalizeAgentTool：汇总子 agent 结果 trailer（无遥测）。
 */
export function finalizeSubagentStats(opts: {
  messages: readonly ChatMessage[]
  startTimeMs: number
  usage?: import('./sessionUsage.ts').SessionUsage
  endTimeMs?: number
}): {
  totalDurationMs: number
  totalToolUseCount: number
  totalTokens: number
} {
  const end = opts.endTimeMs ?? Date.now()
  const totalDurationMs = Math.max(0, end - opts.startTimeMs)
  const totalToolUseCount = countToolUses(opts.messages)
  const totalTokens = opts.usage?.totalTokens ?? 0
  return { totalDurationMs, totalToolUseCount, totalTokens }
}

/** 同步 Agent tool_result 正文（header + summary + stats） */
export function formatSubagentToolOutput(opts: {
  agentType: string
  agentId: string
  summary: string
  agentTranscriptPath?: string
  usage?: import('./sessionUsage.ts').SessionUsage
  totalDurationMs?: number
  totalToolUseCount?: number
  description?: string
}): string {
  const header = `[subagent ${opts.agentType} ${opts.agentId}]`
  const desc =
    opts.description?.trim()
      ? `\ntask: ${opts.description.trim()}`
      : ''
  const body = opts.summary
  const pathNote = opts.agentTranscriptPath
    ? `\ntranscript: ${opts.agentTranscriptPath}`
    : ''
  const statsParts: string[] = []
  if (opts.totalDurationMs != null) {
    statsParts.push(`duration ${formatDurationMs(opts.totalDurationMs)}`)
  }
  if (opts.totalToolUseCount != null) {
    statsParts.push(`tools ${opts.totalToolUseCount}`)
  }
  if (opts.usage && opts.usage.calls > 0) {
    statsParts.push(
      `${opts.usage.totalTokens} tokens (${opts.usage.calls} calls)`,
    )
    const cr = opts.usage.cacheReadInputTokens ?? 0
    const cw = opts.usage.cacheCreationInputTokens ?? 0
    if (cr > 0 || cw > 0) statsParts.push(`cache r/w ${cr}/${cw}`)
  }
  const statsNote = statsParts.length ? `\nstats: ${statsParts.join(' · ')}` : ''
  return `${header}${desc}\n${body}${pathNote}${statsNote}`
}

export type RunSubagentParams = {
  def: AgentDefinition
  prompt: string
  parentSessionId: string
  cwd: string
  hooks: HooksConfig
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  /** 父会话 always-allow；子 agent 共享引用 */
  permissionRules?: SessionPermissionRules
  maxToolResultChars?: number
  /** 父侧全量工具（含 Agent）；内部会 resolve 并去掉 Agent */
  allTools?: readonly BoloTool[]
  skills?: LoadedSkill[]
  maxTurns?: number
  signal?: AbortSignal
  onEvent?: (e: QueryLoopEvent) => void
  /**
   * 结束后写侧链 transcript。
   * - true：`{cwd}/.bolo/sessions/agent-{id}.jsonl`
   * - string：sessions 目录（写 `agent-{id}.jsonl`）
   * - 默认 false
   */
  writeTranscript?: boolean | string
  /** 可选固定 agent id（后台启动时先占位再跑） */
  agentId?: string
  /**
   * S12 fork：子 messages = 父 messages 浅拷贝 + 新 user 任务。
   * 工具 = 父 allTools 去掉 Agent；system 优先用父 sections。
   */
  fork?: boolean
  /** fork 时继承的父会话 messages（浅拷贝数组；不改父） */
  parentMessages?: readonly ChatMessage[]
  /** fork 时优先使用的父 system 段；缺省用 def.systemPrompt */
  parentSystemPromptSections?: readonly string[]
  /**
   * 强制 isolation：worktree / none；缺省用 def.isolation 再 env。
   */
  isolation?: 'none' | 'worktree'
  /**
   * 子 agent 本地 usage（可选）；不传则内部新建。
   */
  usage?: import('./sessionUsage.ts').SessionUsage
  /**
   * 父会话 usage：子 loop 结束后 merge 进去（对照 HC totalUsage 回卷）。
   * 与 `usage` 不同：`usage` 是子自己的桶，`parentUsage` 是回卷目标。
   */
  parentUsage?: import('./sessionUsage.ts').SessionUsage
  model?: string
  /**
   * worktree 结束后是否清理（默认 true；有改动时仍 force remove，可逆靠 git）。
   * 设 false 保留 worktree 目录便于调试。
   */
  cleanupWorktree?: boolean
  /**
   * 短任务标签（对照 HC AgentTool description，3–5 词）。
   * 写入后台表与 tool_result trailer；不进子模型 prompt（prompt 已是完整任务）。
   */
  description?: string
}

export type RunSubagentResult = {
  agentId: string
  agentType: string
  summary: string
  isError: boolean
  terminal: Terminal
  messages: ChatMessage[]
  /** 侧链 transcript 路径（若写入） */
  agentTranscriptPath?: string
  /** 子 loop 本地 usage 快照（若启用） */
  usage?: import('./sessionUsage.ts').SessionUsage
  /** 实际工作目录（可能为 worktree） */
  cwd?: string
  isolation?: 'none' | 'worktree'
  /** 墙钟耗时 ms（对照 HC totalDurationMs） */
  totalDurationMs?: number
  /** 子消息中 tool_calls 总数 */
  totalToolUseCount?: number
  /** 入参 description 回传 */
  description?: string
}

/** 后台 subagent 状态（S12 最小 async） */
export type BackgroundAgentStatus = 'running' | 'done' | 'error'

export type BackgroundAgentEntry = {
  agentId: string
  agentType: string
  prompt: string
  status: BackgroundAgentStatus
  startedAt: string
  finishedAt?: string
  summary?: string
  isError?: boolean
  agentTranscriptPath?: string
  /** 完成后的子 usage 快照（calls>0 时） */
  usage?: import('./sessionUsage.ts').SessionUsage
  description?: string
  totalDurationMs?: number
  totalToolUseCount?: number
}

/**
 * 会话级后台 agent 表：pending + 完成后结果。
 * Agent 工具 `run_in_background` 写入；`/agents status` / `/bg` 读取。
 */
export type BackgroundAgentStore = {
  /** 仍在跑或刚登记的条目（done 后可保留或移到 results） */
  pendingAgents: Record<string, BackgroundAgentEntry>
  /** 完成后的结果摘要（与 pending 可并存；以 results 为准可轮询） */
  backgroundAgentResults: Record<string, BackgroundAgentEntry>
  /**
   * 并发上限（P-SA-CAP）。未设则用 getDefaultMaxBackgroundAgents()。
   */
  maxConcurrent?: number
}

/** 默认后台并发；环境 BOLO_MAX_BACKGROUND_AGENTS 可覆（1–32） */
export function getDefaultMaxBackgroundAgents(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.BOLO_MAX_BACKGROUND_AGENTS?.trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 1) return Math.min(32, Math.floor(n))
  }
  return 3
}

export function countRunningBackgroundAgents(
  store: BackgroundAgentStore,
): number {
  return Object.values(store.pendingAgents).filter((e) => e.status === 'running')
    .length
}

/**
 * 是否允许再启一个后台 agent。
 * @returns ok 或拒绝原因
 */
/**
 * 后台溢出策略（F-SA-PAR2）：
 * - reject（默认）：达 cap 拒绝
 * - queue：标记 queued（调用方负责稍后启动；本最小实现仍返回 queue 提示）
 */
export type BackgroundOverflowPolicy = 'reject' | 'queue'

export function getBackgroundOverflowPolicy(
  env: NodeJS.ProcessEnv = process.env,
): BackgroundOverflowPolicy {
  const v = env.BOLO_BACKGROUND_OVERFLOW?.trim().toLowerCase()
  if (v === 'queue') return 'queue'
  return 'reject'
}

export function canStartBackgroundAgent(
  store: BackgroundAgentStore,
  opts?: { maxConcurrent?: number; policy?: BackgroundOverflowPolicy },
):
  | { ok: true }
  | {
      ok: false
      reason: string
      running: number
      max: number
      policy: BackgroundOverflowPolicy
    } {
  const max =
    opts?.maxConcurrent ??
    store.maxConcurrent ??
    getDefaultMaxBackgroundAgents()
  const policy = opts?.policy ?? getBackgroundOverflowPolicy()
  const running = countRunningBackgroundAgents(store)
  if (running >= max) {
    return {
      ok: false,
      running,
      max,
      policy,
      reason:
        policy === 'queue'
          ? `background agent queue full (${running}/${max}); wait or poll /agents status · /bg (queue mode: try later)`
          : `background agent limit reached (${running}/${max}); wait for one to finish or poll /agents status · /bg`,
    }
  }
  return { ok: true }
}

export function createBackgroundAgentStore(opts?: {
  maxConcurrent?: number
}): BackgroundAgentStore {
  return {
    pendingAgents: {},
    backgroundAgentResults: {},
    ...(opts?.maxConcurrent !== undefined
      ? { maxConcurrent: opts.maxConcurrent }
      : {}),
  }
}

export function markBackgroundAgentRunning(
  store: BackgroundAgentStore,
  entry: Pick<BackgroundAgentEntry, 'agentId' | 'agentType' | 'prompt'> & {
    startedAt?: string
    description?: string
  },
): BackgroundAgentEntry {
  const row: BackgroundAgentEntry = {
    agentId: entry.agentId,
    agentType: entry.agentType,
    prompt: entry.prompt,
    status: 'running',
    startedAt: entry.startedAt ?? nowIso(),
    ...(entry.description?.trim()
      ? { description: entry.description.trim() }
      : {}),
  }
  store.pendingAgents[entry.agentId] = row
  return row
}

export function markBackgroundAgentFinished(
  store: BackgroundAgentStore,
  result: Pick<
    RunSubagentResult,
    | 'agentId'
    | 'agentType'
    | 'summary'
    | 'isError'
    | 'agentTranscriptPath'
    | 'usage'
    | 'totalDurationMs'
    | 'totalToolUseCount'
    | 'description'
  > & { prompt?: string; startedAt?: string },
): BackgroundAgentEntry {
  const prev = store.pendingAgents[result.agentId]
  const row: BackgroundAgentEntry = {
    agentId: result.agentId,
    agentType: result.agentType,
    prompt: result.prompt ?? prev?.prompt ?? '',
    status: result.isError ? 'error' : 'done',
    startedAt: result.startedAt ?? prev?.startedAt ?? nowIso(),
    finishedAt: nowIso(),
    summary: result.summary,
    isError: result.isError,
    ...(result.agentTranscriptPath
      ? { agentTranscriptPath: result.agentTranscriptPath }
      : {}),
    ...(result.usage && result.usage.calls > 0 ? { usage: result.usage } : {}),
    ...(result.description?.trim() || prev?.description
      ? {
          description: (result.description ?? prev?.description ?? '').trim(),
        }
      : {}),
    ...(result.totalDurationMs != null
      ? { totalDurationMs: result.totalDurationMs }
      : {}),
    ...(result.totalToolUseCount != null
      ? { totalToolUseCount: result.totalToolUseCount }
      : {}),
  }
  store.pendingAgents[result.agentId] = row
  store.backgroundAgentResults[result.agentId] = row
  return row
}

/** 列表 running / done 摘要（slash 与调试）；SA-PAR：计数 + 清晰状态 */
export function formatBackgroundAgentsStatus(
  store?: BackgroundAgentStore | null,
): string {
  if (!store) {
    return 'No background agent store on session.'
  }
  const pending = Object.values(store.pendingAgents)
  const results = Object.values(store.backgroundAgentResults)
  if (!pending.length && !results.length) {
    return 'No background agents. Start with Agent tool run_in_background=true.'
  }
  const seen = new Set<string>()
  const rows: BackgroundAgentEntry[] = []
  for (const r of [
    ...pending,
    ...results.filter((r) => !store.pendingAgents[r.agentId]),
  ]) {
    if (seen.has(r.agentId)) continue
    seen.add(r.agentId)
    rows.push(r)
  }
  const nRun = rows.filter((r) => r.status === 'running').length
  const nDone = rows.filter((r) => r.status === 'done').length
  const nErr = rows.filter((r) => r.status === 'error').length
  const max =
    store.maxConcurrent ?? getDefaultMaxBackgroundAgents()
  const lines: string[] = [
    `Background agents: total=${rows.length}  running=${nRun}/${max}  done=${nDone}  error=${nErr}`,
    '',
  ]
  for (const r of rows) {
    const tag =
      r.status === 'running'
        ? 'RUNNING'
        : r.status === 'error'
          ? 'ERROR'
          : 'DONE'
    const desc = r.description?.trim() ? `  · ${r.description.trim()}` : ''
    lines.push(`  ${r.agentId}  [${tag}]  type=${r.agentType}${desc}`)
    if (r.status === 'running') {
      lines.push(`    prompt:  ${truncateOneLine(r.prompt, 80)}`)
      lines.push(`    started: ${r.startedAt}`)
    } else {
      const sum = (r.summary ?? '').trim() || '(no summary)'
      lines.push(`    summary: ${truncateOneLine(sum, 120)}`)
      if (r.finishedAt) lines.push(`    finished: ${r.finishedAt}`)
      if (r.agentTranscriptPath) {
        lines.push(`    transcript: ${r.agentTranscriptPath}`)
      }
      const meta: string[] = []
      if (r.totalDurationMs != null) {
        meta.push(formatDurationMs(r.totalDurationMs))
      }
      if (r.totalToolUseCount != null) {
        meta.push(`${r.totalToolUseCount} tools`)
      }
      if (r.usage && r.usage.calls > 0) {
        meta.push(
          `${r.usage.totalTokens} tokens (${r.usage.calls} calls)` +
            (r.usage.cacheReadInputTokens || r.usage.cacheCreationInputTokens
              ? ` cache r/w ${r.usage.cacheReadInputTokens ?? 0}/${r.usage.cacheCreationInputTokens ?? 0}`
              : ''),
        )
      }
      if (meta.length) lines.push(`    stats: ${meta.join(' · ')}`)
    }
  }
  lines.push('')
  lines.push('Poll: /agents status  ·  /bg')
  return lines.join('\n')
}

function truncateOneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 1))}…`
}

/** 解析子 agent 侧链 jsonl 路径 */
export function resolveSubagentTranscriptPath(opts: {
  cwd: string
  agentId: string
  writeTranscript?: boolean | string
}): string | null {
  const wt = opts.writeTranscript
  if (wt === undefined || wt === false) return null
  const sessionsDir =
    typeof wt === 'string' && wt.trim()
      ? path.resolve(wt.trim())
      : getProjectLayout(opts.cwd).sessionsDir
  const safeId = opts.agentId.replace(/[^\w.-]+/g, '_')
  return path.join(sessionsDir, `agent-${safeId}.jsonl`)
}

async function writeSubagentTranscript(opts: {
  filePath: string
  parentSessionId: string
  agentId: string
  agentType: string
  cwd: string
  messages: ChatMessage[]
}): Promise<void> {
  const sessionId = `${opts.parentSessionId}:${opts.agentId}`
  await ensureTranscriptFile(opts.filePath, {
    sessionId,
    cwd: opts.cwd,
    createdAt: nowIso(),
  })
  await recordSessionMessages(opts.filePath, opts.messages, { sessionId })
}

/**
 * 真子 loop：SubagentStart → 独立 messages + queryLoop → 摘要 → SubagentStop
 * fork 时 messages = 父浅拷贝 + directive；tools = 父集去 Agent。
 * 结束时：merge usage → parentUsage；可选 cleanup worktree。
 */
export async function runSubagent(
  params: RunSubagentParams,
): Promise<RunSubagentResult> {
  const agentId = params.agentId?.trim() || newId('agent')
  const agentType = params.def.agentType
  const isFork = params.fork === true || agentType === 'fork'
  const taskDescription = params.description?.trim() || undefined
  const startTimeMs = Date.now()
  const allTools = params.allTools ?? createDefaultTools()
  const { resolvedTools } = isFork
    ? {
        // fork：与父相同工具，仅去掉 Agent（禁递归 fork）
        resolvedTools: allTools.filter((t) => t.name !== AGENT_TOOL_NAME),
      }
    : resolveAgentTools(params.def, allTools)
  const messages: ChatMessage[] = isFork
    ? [
        // 浅拷贝父 messages，再追加本任务 directive
        ...(params.parentMessages ?? []).map((m) => ({ ...m })),
        { role: 'user', content: params.prompt },
      ]
    : [{ role: 'user', content: params.prompt }]
  const systemPromptSections =
    isFork &&
    params.parentSystemPromptSections &&
    params.parentSystemPromptSections.length > 0
      ? [...params.parentSystemPromptSections]
      : [params.def.systemPrompt]
  const permissionMode = resolveSubagentPermissionMode(
    params.permissionMode,
    params.def.permissionMode,
  )
  // isolation：参数 > def > env BOLO_SUBAGENT_WORKTREE
  const isolationPref =
    params.isolation ?? params.def.isolation ?? 'none'
  const wantWorktree =
    isolationPref === 'worktree' ||
    (isolationPref !== 'none' && isWorktreeEnabled())
  let cwd = params.cwd
  let isolationUsed: 'none' | 'worktree' = 'none'
  let worktreePath: string | undefined
  if (wantWorktree) {
    const { tryCreateSubagentWorktree } = await import('./worktree.ts')
    const wt = await tryCreateSubagentWorktree({
      parentCwd: params.cwd,
      agentId,
      force: isolationPref === 'worktree',
    })
    if (wt.ok) {
      cwd = wt.cwd
      isolationUsed = 'worktree'
      worktreePath = wt.path
    }
  }
  const maxTurns =
    params.maxTurns ??
    params.def.maxTurns ??
    8
  // 子 agent 本地 usage（无遥测）
  let childUsage = params.usage
  if (!childUsage) {
    const { createEmptySessionUsage } = await import('./sessionUsage.ts')
    childUsage = createEmptySessionUsage()
  }

  await runHooks(
    'SubagentStart',
    {
      hook_event_name: 'SubagentStart',
      session_id: params.parentSessionId,
      cwd,
      timestamp: nowIso(),
      agent_id: agentId,
      agent_type: agentType,
      ...(taskDescription ? { description: taskDescription } : {}),
    },
    params.hooks,
    { signal: params.signal },
  )

  let terminal: Terminal
  try {
    terminal = await queryLoop({
      sessionId: `${params.parentSessionId}:${agentId}`,
      cwd,
      hooks: params.hooks,
      messages,
      systemPromptSections,
      deps: params.deps,
      permissionMode,
      askPermission: params.askPermission,
      permissionRules: params.permissionRules,
      maxToolResultChars: params.maxToolResultChars,
      skills: params.skills,
      tools: resolvedTools,
      maxTurns,
      maxPtlRetries: 0,
      querySource: `subagent:${agentType}`,
      signal: params.signal,
      onEvent: params.onEvent,
      usage: childUsage,
      model: params.model,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    terminal = { reason: 'error', detail }
  }

  const stats = finalizeSubagentStats({
    messages,
    startTimeMs,
    usage: childUsage,
  })

  const summaryText = lastAssistantText(messages)
  const failed =
    terminal.reason === 'error' ||
    terminal.reason === 'aborted' ||
    terminal.reason === 'user_prompt_blocked'
  const isError = failed || !summaryText
  const summary = isError
    ? summaryText ||
      `Subagent ${agentType} ended: ${terminal.reason}${terminal.detail ? ` (${terminal.detail})` : ''}`
    : summaryText

  let agentTranscriptPath: string | undefined
  const sidePath = resolveSubagentTranscriptPath({
    // 侧链写在父 cwd 的 sessions，避免 worktree 清理后丢失
    cwd: params.cwd,
    agentId,
    writeTranscript: params.writeTranscript,
  })
  if (sidePath) {
    try {
      await writeSubagentTranscript({
        filePath: sidePath,
        parentSessionId: params.parentSessionId,
        agentId,
        agentType,
        cwd,
        messages,
      })
      agentTranscriptPath = sidePath
    } catch {
      // 侧链失败不阻断主结果；hook 不带 path
    }
  }

  // 父会话 usage 回卷（同步与后台均可）
  if (params.parentUsage && childUsage) {
    const { mergeSessionUsage } = await import('./sessionUsage.ts')
    mergeSessionUsage(params.parentUsage, childUsage)
  }

  // worktree 清理（默认 on；cleanupWorktree=false 保留）
  if (
    isolationUsed === 'worktree' &&
    worktreePath &&
    params.cleanupWorktree !== false
  ) {
    try {
      const { removeSubagentWorktree } = await import('./worktree.ts')
      await removeSubagentWorktree({
        parentCwd: params.cwd,
        worktreePath,
      })
    } catch {
      // 清理失败不阻断
    }
  }

  await runHooks(
    'SubagentStop',
    {
      hook_event_name: 'SubagentStop',
      session_id: params.parentSessionId,
      cwd: params.cwd,
      timestamp: nowIso(),
      agent_id: agentId,
      agent_type: agentType,
      ...(agentTranscriptPath
        ? { agent_transcript_path: agentTranscriptPath }
        : {}),
      ...(taskDescription ? { description: taskDescription } : {}),
      total_duration_ms: stats.totalDurationMs,
      total_tool_use_count: stats.totalToolUseCount,
      total_tokens: stats.totalTokens,
    },
    params.hooks,
    { signal: params.signal },
  )

  return {
    agentId,
    agentType,
    summary,
    isError,
    terminal,
    messages,
    ...(agentTranscriptPath ? { agentTranscriptPath } : {}),
    usage: childUsage,
    cwd,
    isolation: isolationUsed,
    totalDurationMs: stats.totalDurationMs,
    totalToolUseCount: stats.totalToolUseCount,
    ...(taskDescription ? { description: taskDescription } : {}),
  }
}

export type SubagentParentContext = {
  parentSessionId: string
  cwd: string
  hooks: HooksConfig
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  permissionRules?: SessionPermissionRules
  maxToolResultChars?: number
  allTools: readonly BoloTool[]
  skills?: LoadedSkill[]
  /** 会话 active agent 定义（含 .bolo/agents） */
  agentDefinitions?: ActiveAgentDefinitions
  signal?: AbortSignal
  onEvent?: (e: QueryLoopEvent) => void
  /** 覆盖默认侧链写盘（默认 Agent 工具会写 transcript） */
  writeTranscript?: boolean | string
  /** 会话后台 agent 表（run_in_background） */
  backgroundStore?: BackgroundAgentStore
  /**
   * 后台完成后可选通知：推一条 system 文本到父 messages。
   * 未传则只写 backgroundAgentResults。
   * fork 时也作为继承上下文源。
   */
  parentMessages?: ChatMessage[]
  /** fork 时继承的父 system 段 */
  parentSystemPromptSections?: readonly string[]
  /** 父会话 model 标签；写入子 usage.byModel */
  model?: string
  /**
   * 父会话 usage 引用；子完成后 merge 回卷（同步 + 后台均生效）。
   */
  parentUsage?: import('./sessionUsage.ts').SessionUsage
}

function agentTypesHint(active?: ActiveAgentDefinitions | null): string {
  const types = listActiveAgents(active)
    .map((a) => a.agentType)
    .join('|')
  return types || 'explore|general|fork'
}

function isTruthyBackgroundFlag(v: unknown): boolean {
  if (v === true || v === 1) return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes'
  }
  return false
}

/** Agent 工具是否走 fork 路径：type 省略 / type=fork / fork:true */
export function isForkAgentRequest(input: {
  subagent_type?: unknown
  fork?: unknown
}): boolean {
  if (isTruthyBackgroundFlag(input.fork)) return true
  if (input.subagent_type == null) return true
  const t = String(input.subagent_type).trim().toLowerCase()
  if (!t) return true
  return t === 'fork'
}

/**
 * 主会话 Agent 工具描述（对照 HC getPrompt 极简版；类型列表动态）。
 */
export function buildAgentToolDescription(
  active?: ActiveAgentDefinitions | null,
): string {
  const agents = listActiveAgents(active)
  const typeLines = agents
    .map((a) => {
      const when = a.whenToUse?.trim() || a.description
      return `- ${a.agentType}: ${when}`
    })
    .join('\n')
  return [
    'Spawn a specialized subagent for a focused task. The child starts with its own context unless you fork.',
    'Omit subagent_type (or use fork / fork:true) to inherit parent messages. Prefer a complete briefing in prompt — file paths, constraints, done criteria.',
    'Optional: description (3–5 words for status UI), run_in_background, max_turns, isolation=worktree|none.',
    'Poll background runs with /agents status or /bg. Nested Agent is disabled in children.',
    typeLines ? `Available types:\n${typeLines}` : 'Types: explore|general|plan|fork',
  ].join(' ')
}

/**
 * 主会话 Agent 工具。须在 tool.call 的 extras.subagentParent 注入父上下文。
 */
export function createAgentTool(
  activeAgents?: ActiveAgentDefinitions | null,
): BoloTool {
  const hint = agentTypesHint(activeAgents)
  return buildTool({
    name: AGENT_TOOL_NAME,
    description: buildAgentToolDescription(activeAgents),
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Full task briefing for the subagent (context, constraints, done criteria)',
        },
        description: {
          type: 'string',
          description:
            'Short 3–5 word label for /agents status and tool_result trailer (not the full task)',
        },
        subagent_type: {
          type: 'string',
          description: `Agent type (${hint}); omit or "fork" = inherit parent conversation`,
        },
        fork: {
          type: 'boolean',
          description:
            'If true, fork parent messages into the child (same as subagent_type=fork)',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'If true, start subagent async and return immediately; poll /agents status or /bg',
        },
        async: {
          type: 'boolean',
          description: 'Alias of run_in_background',
        },
        max_turns: {
          type: 'number',
          description: 'Max agentic turns for this spawn (overrides agent def)',
        },
        isolation: {
          type: 'string',
          description: 'none | worktree — worktree uses git worktree isolation',
        },
      },
      required: ['prompt'],
    },
    async call(input, ctx) {
      const prompt = String(input.prompt ?? '').trim()
      if (!prompt) {
        return {
          ok: false,
          isError: true,
          output: 'Agent tool requires non-empty prompt',
          errorCode: 'empty_prompt',
        }
      }

      const taskDescription =
        input.description != null && String(input.description).trim()
          ? String(input.description).trim()
          : undefined

      const parent = ctx.extras?.subagentParent as
        | SubagentParentContext
        | undefined
      if (!parent?.deps) {
        return {
          ok: false,
          isError: true,
          output:
            'Agent tool missing parent context (subagentParent). Use session tools from core createDefaultTools().',
          errorCode: 'no_parent',
        }
      }

      const active =
        parent.agentDefinitions ?? activeAgents ?? builtinAgentMap()

      const useFork = isForkAgentRequest(input)

      let def: AgentDefinition
      try {
        def = getAgentDefinition(
          useFork
            ? 'fork'
            : input.subagent_type != null
              ? String(input.subagent_type)
              : 'general',
          active,
        )
      } catch (e) {
        return {
          ok: false,
          isError: true,
          output: e instanceof Error ? e.message : String(e),
          errorCode: 'unknown_type',
        }
      }

      const writeTranscript: boolean | string =
        parent.writeTranscript !== undefined
          ? parent.writeTranscript
          : ctx.extras?.writeTranscript !== undefined
            ? (ctx.extras.writeTranscript as boolean | string)
            : true

      let maxTurnsOverride: number | undefined
      if (input.max_turns != null && input.max_turns !== '') {
        const n = Number(input.max_turns)
        if (Number.isFinite(n) && n >= 1) maxTurnsOverride = Math.min(200, Math.floor(n))
      }
      let isolationOverride: 'none' | 'worktree' | undefined
      if (input.isolation != null) {
        const iso = String(input.isolation).trim().toLowerCase()
        if (iso === 'worktree') isolationOverride = 'worktree'
        if (iso === 'none' || iso === 'off') isolationOverride = 'none'
      }

      const runParams: RunSubagentParams = {
        def,
        prompt,
        parentSessionId: parent.parentSessionId,
        cwd: parent.cwd,
        hooks: parent.hooks,
        deps: parent.deps,
        permissionMode: parent.permissionMode,
        askPermission: parent.askPermission,
        permissionRules: parent.permissionRules,
        maxToolResultChars: parent.maxToolResultChars,
        allTools: parent.allTools,
        skills: parent.skills,
        signal: parent.signal ?? ctx.signal,
        onEvent: parent.onEvent,
        writeTranscript,
        model: parent.model,
        parentUsage: parent.parentUsage,
        ...(taskDescription ? { description: taskDescription } : {}),
        ...(maxTurnsOverride !== undefined ? { maxTurns: maxTurnsOverride } : {}),
        ...(isolationOverride ? { isolation: isolationOverride } : {}),
        ...(useFork
          ? {
              fork: true,
              parentMessages: parent.parentMessages,
              parentSystemPromptSections: parent.parentSystemPromptSections,
            }
          : {}),
      }

      const runInBackground =
        isTruthyBackgroundFlag(input.run_in_background ?? input.async) ||
        def.background === true

      if (runInBackground) {
        const store = parent.backgroundStore
        if (!store) {
          return {
            ok: false,
            isError: true,
            output:
              'Agent run_in_background requires session backgroundStore (createSession wires it).',
            errorCode: 'no_background_store',
          }
        }
        const cap = canStartBackgroundAgent(store)
        if (!cap.ok) {
          return {
            ok: false,
            isError: true,
            output: cap.reason,
            errorCode: 'background_limit',
          }
        }
        const agentId = newId('agent')
        markBackgroundAgentRunning(store, {
          agentId,
          agentType: def.agentType,
          prompt,
          ...(taskDescription ? { description: taskDescription } : {}),
        })
        void runSubagent({ ...runParams, agentId })
          .then((result) => {
            markBackgroundAgentFinished(store, {
              agentId: result.agentId,
              agentType: result.agentType,
              summary: result.summary,
              isError: result.isError,
              agentTranscriptPath: result.agentTranscriptPath,
              usage: result.usage,
              totalDurationMs: result.totalDurationMs,
              totalToolUseCount: result.totalToolUseCount,
              description: result.description ?? taskDescription,
              prompt,
            })
            if (parent.parentMessages) {
              const tag = result.isError ? 'error' : 'done'
              const u =
                result.usage && result.usage.calls > 0
                  ? ` · ${result.usage.totalTokens} tok`
                  : ''
              const d = result.description?.trim()
                ? ` (${result.description.trim()})`
                : ''
              parent.parentMessages.push({
                role: 'system',
                content: `[background agent ${result.agentId} ${tag}]${d} ${result.summary}${u}`,
              })
            }
          })
          .catch((e) => {
            const detail = e instanceof Error ? e.message : String(e)
            markBackgroundAgentFinished(store, {
              agentId,
              agentType: def.agentType,
              summary: `Background subagent failed: ${detail}`,
              isError: true,
              description: taskDescription,
              prompt,
            })
            if (parent.parentMessages) {
              parent.parentMessages.push({
                role: 'system',
                content: `[background agent ${agentId} error] ${detail}`,
              })
            }
          })

        const label = taskDescription ? ` (${taskDescription})` : ''
        return {
          ok: true,
          output: `started agent ${agentId}${label} in background; poll with /agents status or /bg`,
        }
      }

      const result = await runSubagent(runParams)

      return {
        ok: !result.isError,
        isError: result.isError,
        output: formatSubagentToolOutput({
          agentType: result.agentType,
          agentId: result.agentId,
          summary: result.summary,
          agentTranscriptPath: result.agentTranscriptPath,
          usage: result.usage,
          totalDurationMs: result.totalDurationMs,
          totalToolUseCount: result.totalToolUseCount,
          description: result.description ?? taskDescription,
        }),
        errorCode: result.isError ? 'subagent_failed' : undefined,
      }
    },
  })
}

/** 主会话默认工具集：内置 + Agent */
export function createDefaultTools(
  activeAgents?: ActiveAgentDefinitions | null,
): BoloTool[] {
  return [...createBuiltinTools(), createAgentTool(activeAgents)]
}

/**
 * 从父会话上下文启动子 agent（替换旧 stub）。
 * 无 prompt 时使用占位任务（仅调试）；生产路径应走 Agent 工具。
 */
export async function spawnSubagent(
  parent: {
    id: string
    cwd: string
    hooks: HooksConfig
    deps: QueryDeps
    permissionMode: PermissionMode
    askPermission: AskPermissionFn
    permissionRules?: SessionPermissionRules
    maxToolResultChars?: number
    skills?: LoadedSkill[]
    agentDefinitions?: ActiveAgentDefinitions
    onEvent?: (e: QueryLoopEvent) => void
  },
  agentType: string,
  prompt?: string,
): Promise<RunSubagentResult> {
  const def = getAgentDefinition(agentType, parent.agentDefinitions)
  return runSubagent({
    def,
    prompt:
      prompt ??
      `You are a ${def.agentType} subagent. Await a real task from the parent.`,
    parentSessionId: parent.id,
    cwd: parent.cwd,
    hooks: parent.hooks,
    deps: parent.deps,
    permissionMode: parent.permissionMode,
    askPermission: parent.askPermission,
    permissionRules: parent.permissionRules,
    maxToolResultChars: parent.maxToolResultChars,
    allTools: createDefaultTools(parent.agentDefinitions),
    skills: parent.skills,
    onEvent: parent.onEvent,
  })
}

/** @deprecated 使用 spawnSubagent / runSubagent；保留别名避免外部 import 断裂 */
export const spawnSubagentStub = spawnSubagent