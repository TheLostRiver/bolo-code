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

export const AGENT_TOOL_NAME = 'Agent'

export type AgentDefinitionSource = 'builtin' | 'user' | 'project'

export type AgentDefinition = {
  agentType: string
  description: string
  /** 白名单工具名，或 '*' 表示默认可写集（仍会排除 Agent） */
  tools: string[] | '*'
  systemPrompt: string
  permissionMode?: PermissionMode
  /** 定义来源；内置为 builtin */
  source?: AgentDefinitionSource
}

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: 'explore',
  description:
    'Read-only explorer: find files and search code. Use for codebase questions without edits.',
  tools: ['Read', 'Glob', 'Grep'],
  systemPrompt: `You are a read-only explore subagent for Bolo.
Use only Read, Glob, and Grep. Do not modify files or run shell writes.
Search efficiently and reply with a concise findings report for the parent agent.`,
  permissionMode: 'default',
  source: 'builtin',
}

export const GENERAL_AGENT: AgentDefinition = {
  agentType: 'general',
  description:
    'General-purpose subagent for multi-step tasks. Cannot spawn further agents.',
  tools: '*',
  systemPrompt: `You are a general-purpose subagent for Bolo.
Complete the task with the tools you have. Do not spawn nested agents.
When done, reply with a concise report of what you did and key findings.`,
  source: 'builtin',
}

/** S12 最小 fork：继承父 messages；工具=父集去掉 Agent；无 worktree / 无完整 cache 共享 */
export const FORK_AGENT: AgentDefinition = {
  agentType: 'fork',
  description:
    'Fork of the current conversation: inherits parent messages, same tools minus Agent. Use for context-heavy subtasks.',
  tools: '*',
  systemPrompt: `你是 fork 工作者。继承父会话上下文，完成指派任务后给出简洁报告。不要再 spawn 子 agent。`,
  source: 'builtin',
}

const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  explore: EXPLORE_AGENT,
  general: GENERAL_AGENT,
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

  const description =
    meta.description?.trim() ||
    `Custom subagent "${agentType}" from ${source} .bolo/agents`

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
 */
export function resolveAgentTools(
  def: Pick<AgentDefinition, 'tools'>,
  allTools: readonly BoloTool[],
): ResolveAgentToolsResult {
  const withoutAgent = allTools.filter((t) => t.name !== AGENT_TOOL_NAME)
  const hasWildcard =
    def.tools === '*' ||
    (Array.isArray(def.tools) && def.tools.includes('*'))

  if (hasWildcard) {
    return {
      resolvedTools: withoutAgent,
      invalidTools: [],
      hasWildcard: true,
    }
  }

  const allow = new Set(
    (def.tools as string[]).map((n) => n.trim()).filter(Boolean),
  )
  allow.delete(AGENT_TOOL_NAME)

  const byName = new Map(withoutAgent.map((t) => [t.name, t]))
  const resolvedTools: BoloTool[] = []
  const invalidTools: string[] = []

  for (const name of allow) {
    const t = byName.get(name)
    if (t) resolvedTools.push(t)
    else invalidTools.push(name)
  }

  return { resolvedTools, invalidTools, hasWildcard: false }
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
}

export function createBackgroundAgentStore(): BackgroundAgentStore {
  return { pendingAgents: {}, backgroundAgentResults: {} }
}

export function markBackgroundAgentRunning(
  store: BackgroundAgentStore,
  entry: Pick<BackgroundAgentEntry, 'agentId' | 'agentType' | 'prompt'> & {
    startedAt?: string
  },
): BackgroundAgentEntry {
  const row: BackgroundAgentEntry = {
    agentId: entry.agentId,
    agentType: entry.agentType,
    prompt: entry.prompt,
    status: 'running',
    startedAt: entry.startedAt ?? nowIso(),
  }
  store.pendingAgents[entry.agentId] = row
  return row
}

export function markBackgroundAgentFinished(
  store: BackgroundAgentStore,
  result: Pick<
    RunSubagentResult,
    'agentId' | 'agentType' | 'summary' | 'isError' | 'agentTranscriptPath'
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
  const lines: string[] = [
    `Background agents: total=${rows.length}  running=${nRun}  done=${nDone}  error=${nErr}`,
    '',
  ]
  for (const r of rows) {
    const tag =
      r.status === 'running'
        ? 'RUNNING'
        : r.status === 'error'
          ? 'ERROR'
          : 'DONE'
    lines.push(`  ${r.agentId}  [${tag}]  type=${r.agentType}`)
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
 */
export async function runSubagent(
  params: RunSubagentParams,
): Promise<RunSubagentResult> {
  const agentId = params.agentId?.trim() || newId('agent')
  const agentType = params.def.agentType
  const isFork = params.fork === true || agentType === 'fork'
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
  const maxTurns = params.maxTurns ?? 8

  await runHooks(
    'SubagentStart',
    {
      hook_event_name: 'SubagentStart',
      session_id: params.parentSessionId,
      cwd: params.cwd,
      timestamp: nowIso(),
      agent_id: agentId,
      agent_type: agentType,
    },
    params.hooks,
    { signal: params.signal },
  )

  let terminal: Terminal
  try {
    terminal = await queryLoop({
      sessionId: `${params.parentSessionId}:${agentId}`,
      cwd: params.cwd,
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
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    terminal = { reason: 'error', detail }
  }

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
        cwd: params.cwd,
        messages,
      })
      agentTranscriptPath = sidePath
    } catch {
      // 侧链失败不阻断主结果；hook 不带 path
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
 * 主会话 Agent 工具。须在 tool.call 的 extras.subagentParent 注入父上下文。
 */
export function createAgentTool(
  activeAgents?: ActiveAgentDefinitions | null,
): BoloTool {
  const hint = agentTypesHint(activeAgents)
  return buildTool({
    name: AGENT_TOOL_NAME,
    description: `Spawn a subagent. Omit subagent_type or use fork / fork:true to inherit parent messages. Types: ${hint}. Optional run_in_background.`,
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Task for the subagent to perform',
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
        // 默认写侧链 transcript（S7+）；可用 extras.writeTranscript=false 关闭
        writeTranscript,
        ...(useFork
          ? {
              fork: true,
              parentMessages: parent.parentMessages,
              parentSystemPromptSections: parent.parentSystemPromptSections,
            }
          : {}),
      }

      const runInBackground = isTruthyBackgroundFlag(
        input.run_in_background ?? input.async,
      )

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
        const agentId = newId('agent')
        markBackgroundAgentRunning(store, {
          agentId,
          agentType: def.agentType,
          prompt,
        })
        void runSubagent({ ...runParams, agentId })
          .then((result) => {
            markBackgroundAgentFinished(store, {
              agentId: result.agentId,
              agentType: result.agentType,
              summary: result.summary,
              isError: result.isError,
              agentTranscriptPath: result.agentTranscriptPath,
              prompt,
            })
            if (parent.parentMessages) {
              const tag = result.isError ? 'error' : 'done'
              parent.parentMessages.push({
                role: 'system',
                content: `[background agent ${result.agentId} ${tag}] ${result.summary}`,
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
              prompt,
            })
            if (parent.parentMessages) {
              parent.parentMessages.push({
                role: 'system',
                content: `[background agent ${agentId} error] ${detail}`,
              })
            }
          })

        return {
          ok: true,
          output: `started agent ${agentId} in background; poll with /agents status or /bg`,
        }
      }

      const result = await runSubagent(runParams)

      const header = `[subagent ${result.agentType} ${result.agentId}]`
      const body = result.summary
      const pathNote = result.agentTranscriptPath
        ? `\ntranscript: ${result.agentTranscriptPath}`
        : ''
      return {
        ok: !result.isError,
        isError: result.isError,
        output: `${header}\n${body}${pathNote}`,
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