/**
 * Subagent 运行时 — 对照 HC AgentTool / runAgent / resolveAgentTools / loadAgentsDir
 * 无遥测；默认禁止子 agent 再调 Agent。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  getBoloHomeDir,
  getWorkspaceSessionsDir,
} from '../../config/src/paths.ts'
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
import {
  isWorktreeEnabled,
  type WorktreeCleanupResult,
} from './worktree.ts'
import type {
  DurableTaskIsolation,
  DurableTaskRecord,
  DurableTaskState,
} from './durableTask.ts'

export const AGENT_TOOL_NAME = 'Agent'

export type AgentDefinitionSource = 'builtin' | 'user' | 'project'

export type AgentDefinition = {
  agentType: string
  description: string
  /** 白名单工具名，或 '*' 表示默认可写集（仍会按 depth 规则处理 Agent） */
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
  /**
   * 子 agent 模型：`inherit` 或具体 model id。
   * 解析见 resolveSubagentModel。
   */
  model?: string
  /**
   * 子 agent effort：`inherit` 或 low|medium|high|max|…。
   */
  effort?: string
  /**
   * 本 agent 作为父时允许的最大 spawnDepth（子 depth 必须 ≤ 此值才可再带 Agent）。
   * 缺省用 AgentPolicy.maxSpawnDepth（默认 0）。
   */
  maxSpawnDepth?: number
  /**
   * Codex sandbox 语法糖：`read-only` → 只读工具集。
   */
  sandbox?: 'read-only' | 'workspace-write' | 'none'
}

/** 全局 subagent 策略（config.agents + env） */
export type AgentPolicy = {
  enabled: boolean
  maxConcurrent: number
  defaultModel: string
  defaultEffort?: string
  /** 默认 0：主(depth0)可 spawn，子不可再 spawn */
  maxSpawnDepth: number
  overflow: 'reject' | 'queue'
}

export const MAX_SPAWN_DEPTH_CLAMP = 3

export function defaultAgentPolicy(): AgentPolicy {
  return {
    enabled: true,
    maxConcurrent: 3,
    defaultModel: 'inherit',
    maxSpawnDepth: 0,
    overflow: 'reject',
  }
}

/** 从 config.agents + env 归一化（无遥测） */
export function resolveAgentPolicy(
  raw?: {
    enabled?: boolean
    maxConcurrent?: number
    defaultModel?: string
    defaultEffort?: string
    maxSpawnDepth?: number
    overflow?: 'reject' | 'queue'
  } | null,
  env: NodeJS.ProcessEnv = process.env,
): AgentPolicy {
  const base = defaultAgentPolicy()
  const enabledEnv = env.BOLO_AGENTS_ENABLED?.trim().toLowerCase()
  let enabled = raw?.enabled ?? base.enabled
  if (enabledEnv === '0' || enabledEnv === 'false' || enabledEnv === 'off') {
    enabled = false
  }
  if (enabledEnv === '1' || enabledEnv === 'true' || enabledEnv === 'on') {
    enabled = true
  }

  let maxConcurrent = raw?.maxConcurrent ?? base.maxConcurrent
  const mcEnv = env.BOLO_MAX_BACKGROUND_AGENTS?.trim()
  if (mcEnv) {
    const n = Number(mcEnv)
    if (Number.isFinite(n) && n >= 1) maxConcurrent = Math.min(32, Math.floor(n))
  }
  if (Number.isFinite(maxConcurrent) && maxConcurrent >= 1) {
    maxConcurrent = Math.min(32, Math.floor(maxConcurrent))
  } else {
    maxConcurrent = 3
  }

  let maxSpawnDepth = raw?.maxSpawnDepth ?? base.maxSpawnDepth
  const depthEnv = env.BOLO_SUBAGENT_MAX_SPAWN_DEPTH?.trim()
  if (depthEnv) {
    const n = Number(depthEnv)
    if (Number.isFinite(n) && n >= 0) maxSpawnDepth = Math.floor(n)
  }
  maxSpawnDepth = clampSpawnDepth(maxSpawnDepth)

  let overflow: 'reject' | 'queue' =
    raw?.overflow === 'queue' ? 'queue' : base.overflow
  const ovEnv = env.BOLO_BACKGROUND_OVERFLOW?.trim().toLowerCase()
  if (ovEnv === 'queue') overflow = 'queue'
  if (ovEnv === 'reject') overflow = 'reject'

  const defaultModel =
    (raw?.defaultModel && String(raw.defaultModel).trim()) || base.defaultModel
  const defaultEffort =
    raw?.defaultEffort != null && String(raw.defaultEffort).trim()
      ? String(raw.defaultEffort).trim()
      : undefined

  return {
    enabled,
    maxConcurrent,
    defaultModel,
    ...(defaultEffort ? { defaultEffort } : {}),
    maxSpawnDepth,
    overflow,
  }
}

export function clampSpawnDepth(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(MAX_SPAWN_DEPTH_CLAMP, Math.floor(n))
}

/**
 * 当前 loop 是否允许在工具表中保留 Agent。
 * - spawnDepth=0（主）：policy.enabled 即可
 * - spawnDepth>0：spawnDepth <= effectiveMax（def ?? policy），且 enabled
 */
export function canExposeAgentTool(opts: {
  spawnDepth: number
  policy?: AgentPolicy | null
  /** 当前 loop 的 agent 定义（主会话无） */
  def?: Pick<AgentDefinition, 'maxSpawnDepth'> | null
}): boolean {
  const policy = opts.policy ?? defaultAgentPolicy()
  if (!policy.enabled) return false
  const depth = Math.max(0, Math.floor(opts.spawnDepth || 0))
  if (depth === 0) return true
  const cap = clampSpawnDepth(
    opts.def?.maxSpawnDepth ?? policy.maxSpawnDepth ?? 0,
  )
  return depth <= cap
}

/**
 * model 解析：env 强制 → 工具参数 → def → policy.default → 父 → undefined
 * fork 时强制 inherit（用父 model）。
 */
export function resolveSubagentModel(opts: {
  fork?: boolean
  toolModel?: string | null
  defModel?: string | null
  policy?: AgentPolicy | null
  parentModel?: string | null
  env?: NodeJS.ProcessEnv
}): string | undefined {
  const env = opts.env ?? process.env
  const forced = env.BOLO_SUBAGENT_MODEL?.trim()
  if (forced) return forced

  if (opts.fork) {
    return pickInherit(opts.parentModel)
  }

  const fromTool = normalizeModelSpec(opts.toolModel)
  if (fromTool && fromTool !== 'inherit') return fromTool
  if (fromTool === 'inherit') return pickInherit(opts.parentModel)

  const fromDef = normalizeModelSpec(opts.defModel)
  if (fromDef && fromDef !== 'inherit') return fromDef
  if (fromDef === 'inherit') return pickInherit(opts.parentModel)

  const fromPolicy = normalizeModelSpec(opts.policy?.defaultModel)
  if (fromPolicy && fromPolicy !== 'inherit') return fromPolicy

  return pickInherit(opts.parentModel)
}

/**
 * effort 解析：env → 工具 → def → policy.defaultEffort → 父
 * fork 默认 inherit 父。
 */
export function resolveSubagentEffort(opts: {
  fork?: boolean
  toolEffort?: string | null
  defEffort?: string | null
  policy?: AgentPolicy | null
  parentEffort?: string | null
  env?: NodeJS.ProcessEnv
}): string | undefined {
  const env = opts.env ?? process.env
  const forced = env.BOLO_SUBAGENT_EFFORT?.trim()
  if (forced) return forced

  if (opts.fork) {
    const t = normalizeEffortSpec(opts.toolEffort)
    if (t && t !== 'inherit') return t
    const d = normalizeEffortSpec(opts.defEffort)
    if (d && d !== 'inherit') return d
    return pickInherit(opts.parentEffort)
  }

  const fromTool = normalizeEffortSpec(opts.toolEffort)
  if (fromTool && fromTool !== 'inherit') return fromTool
  if (fromTool === 'inherit') return pickInherit(opts.parentEffort)

  const fromDef = normalizeEffortSpec(opts.defEffort)
  if (fromDef && fromDef !== 'inherit') return fromDef
  if (fromDef === 'inherit') return pickInherit(opts.parentEffort)

  const fromPolicy = normalizeEffortSpec(opts.policy?.defaultEffort)
  if (fromPolicy && fromPolicy !== 'inherit') return fromPolicy
  if (fromPolicy === 'inherit') return pickInherit(opts.parentEffort)

  return pickInherit(opts.parentEffort)
}

function normalizeModelSpec(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined
  const t = String(raw).trim()
  if (!t) return undefined
  if (t.toLowerCase() === 'inherit') return 'inherit'
  return t
}

function normalizeEffortSpec(
  raw: string | null | undefined,
): string | undefined {
  if (raw == null) return undefined
  const t = String(raw).trim().toLowerCase()
  if (!t) return undefined
  if (t === 'inherit') return 'inherit'
  // Codex aliases → Bolo
  if (t === 'xhigh' || t === 'ultra') return 'max'
  return t
}

function pickInherit(parent: string | null | undefined): string | undefined {
  if (parent == null) return undefined
  const t = String(parent).trim()
  return t || undefined
}

/** read-only sandbox：只保留读工具 */
const READ_ONLY_TOOL_NAMES = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'Skill',
  'ListMcpResources',
  'ReadMcpResource',
])

export function applySandboxToolFilter(
  tools: readonly BoloTool[],
  sandbox?: AgentDefinition['sandbox'],
): BoloTool[] {
  if (sandbox !== 'read-only') return [...tools]
  return tools.filter(
    (t) => READ_ONLY_TOOL_NAMES.has(t.name) || t.name.startsWith('mcp__'),
  )
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
  maxSpawnDepth: 0,
  model: 'inherit',
  effort: 'medium',
}

export const GENERAL_AGENT: AgentDefinition = {
  agentType: 'general',
  description:
    'General-purpose subagent for multi-step tasks. Cannot spawn further agents by default.',
  whenToUse:
    'Multi-step implementation or investigation that should not pollute the parent context. Full tools except nested Agent (unless maxSpawnDepth allows).',
  tools: '*',
  disallowedTools: ['Agent'],
  systemPrompt: `You are a general-purpose subagent for Bolo.
Complete the task with the tools you have. Do not spawn nested agents unless your tool list includes Agent.
When done, reply with a concise report of what you did and key findings.`,
  source: 'builtin',
  maxSpawnDepth: 0,
  model: 'inherit',
  effort: 'inherit',
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
  maxSpawnDepth: 0,
  model: 'inherit',
  effort: 'high',
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
  maxSpawnDepth: 0,
  model: 'inherit',
  effort: 'inherit',
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

  let model: string | undefined
  if (meta.model != null && String(meta.model).trim()) {
    model = String(meta.model).trim()
  }

  let effort: string | undefined
  if (meta.effort != null && String(meta.effort).trim()) {
    effort = String(meta.effort).trim()
  } else if (
    meta.model_reasoning_effort != null &&
    String(meta.model_reasoning_effort).trim()
  ) {
    // Codex alias
    effort = String(meta.model_reasoning_effort).trim()
  }

  let maxSpawnDepth: number | undefined
  const depthRaw =
    meta.maxspawndepth ?? meta.max_spawn_depth ?? meta.spawn_depth
  if (depthRaw != null && depthRaw !== '') {
    const n = Number(depthRaw)
    if (Number.isFinite(n) && n >= 0) maxSpawnDepth = clampSpawnDepth(n)
  }

  let sandbox: AgentDefinition['sandbox'] | undefined
  if (meta.sandbox != null && String(meta.sandbox).trim()) {
    const s = String(meta.sandbox).trim().toLowerCase()
    if (s === 'read-only' || s === 'readonly' || s === 'read_only') {
      sandbox = 'read-only'
    } else if (s === 'workspace-write' || s === 'workspace_write') {
      sandbox = 'workspace-write'
    } else if (s === 'none' || s === 'off') {
      sandbox = 'none'
    }
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

  // sandbox: read-only 语法糖 — 未显式写 tools 时收紧
  if (sandbox === 'read-only' && tools === '*') {
    tools = ['Read', 'Glob', 'Grep', 'WebFetch']
    if (!disallowedTools) {
      disallowedTools = ['Write', 'Edit', 'ApplyPatch', 'Bash', 'Agent']
    }
  }

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
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(maxSpawnDepth !== undefined ? { maxSpawnDepth } : {}),
    ...(sandbox ? { sandbox } : {}),
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
  /** 是否因 depth/policy 强制去掉 Agent */
  agentToolAllowed: boolean
}

/**
 * 按 AgentDefinition 裁剪工具。
 * Agent 工具：仅当 opts.allowAgentTool === true 且未被 disallowed 时保留
 * （默认 false = 与历史「子 agent 无 Agent」兼容）。
 * 支持 disallowedTools 二次剔除（HC loadAgentsDir 语义）。
 */
export function resolveAgentTools(
  def: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'sandbox'>,
  allTools: readonly BoloTool[],
  opts?: {
    allowAgentTool?: boolean
  },
): ResolveAgentToolsResult {
  const allowAgent = opts?.allowAgentTool === true
  const basePool = allowAgent
    ? [...allTools]
    : allTools.filter((t) => t.name !== AGENT_TOOL_NAME)

  const hasWildcard =
    def.tools === '*' ||
    (Array.isArray(def.tools) && def.tools.includes('*'))

  let resolvedTools: BoloTool[]
  const invalidTools: string[] = []

  if (hasWildcard) {
    resolvedTools = [...basePool]
  } else {
    const allow = new Set(
      (def.tools as string[]).map((n) => n.trim()).filter(Boolean),
    )
    if (!allowAgent) allow.delete(AGENT_TOOL_NAME)
    const byName = new Map(basePool.map((t) => [t.name, t]))
    resolvedTools = []
    for (const name of allow) {
      if (name === AGENT_TOOL_NAME && !allowAgent) continue
      const t = byName.get(name)
      if (t) resolvedTools.push(t)
      else invalidTools.push(name)
    }
  }

  if (def.disallowedTools?.length) {
    const ban = new Set(
      def.disallowedTools.map((n) => n.trim()).filter(Boolean),
    )
    if (!allowAgent) ban.add(AGENT_TOOL_NAME)
    resolvedTools = resolvedTools.filter((t) => !ban.has(t.name))
  } else if (!allowAgent) {
    resolvedTools = resolvedTools.filter((t) => t.name !== AGENT_TOOL_NAME)
  }

  resolvedTools = applySandboxToolFilter(resolvedTools, def.sandbox)

  // sandbox 后再确保 Agent 策略
  if (!allowAgent) {
    resolvedTools = resolvedTools.filter((t) => t.name !== AGENT_TOOL_NAME)
  }

  return {
    resolvedTools,
    invalidTools,
    hasWildcard,
    agentToolAllowed: allowAgent,
  }
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
  /** 父侧全量工具（含 Agent）；内部按 depth/policy resolve */
  allTools?: readonly BoloTool[]
  skills?: LoadedSkill[]
  maxTurns?: number
  signal?: AbortSignal
  onEvent?: (e: QueryLoopEvent) => void
  /**
   * 结束后写侧链 transcript。
   * - true：用户级 workspace sessions 下的 `agent-{id}.jsonl`
   * - string：sessions 目录（写 `agent-{id}.jsonl`）
   * - 默认 false
   */
  writeTranscript?: boolean | string
  /** 可选固定 agent id（后台启动时先占位再跑） */
  agentId?: string
  /**
   * S12 fork：子 messages = 父 messages 浅拷贝 + 新 user 任务。
   * 工具 = 父 allTools 按 depth 处理 Agent；system 优先用父 sections。
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
   */
  parentUsage?: import('./sessionUsage.ts').SessionUsage
  /** 父会话 model（inherit 与 usage 标签） */
  parentModel?: string
  /** 父会话 effort */
  parentEffort?: string
  /**
   * 解析后的子 model / effort（若已在 Agent 工具侧算好可直接传）。
   * 未传则用 resolveSubagentModel/Effort。
   */
  model?: string
  effort?: string
  /** 全局策略 */
  agentPolicy?: AgentPolicy
  /**
   * 本子 agent 的 spawnDepth（主 spawn 的子 = 1）。
   * 默认 1。
   */
  spawnDepth?: number
  /** 活跃类型表（嵌套 Agent resolve） */
  agentDefinitions?: ActiveAgentDefinitions
  /**
   * worktree 结束后是否清理（默认 true）。
   */
  cleanupWorktree?: boolean
  /**
   * 短任务标签（对照 HC AgentTool description）。
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
  /** worktree 绝对路径（removed 后用于审计，retained 时用于恢复成果） */
  worktreePath?: string
  /** 自动清理的可观察结果；dirty/untracked 默认 retained */
  worktreeCleanup?: WorktreeCleanupResult
  /** 墙钟耗时 ms（对照 HC totalDurationMs） */
  totalDurationMs?: number
  /** 子消息中 tool_calls 总数 */
  totalToolUseCount?: number
  /** 入参 description 回传 */
  description?: string
}

/** 后台 subagent 状态（S12 最小 async） */
export type BackgroundAgentStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'aborted'
  | 'interrupted'

export type BackgroundAgentEntry = {
  agentId: string
  agentType: string
  prompt: string
  status: BackgroundAgentStatus
  startedAt: string
  parentTurnId?: string
  finishedAt?: string
  summary?: string
  isError?: boolean
  agentTranscriptPath?: string
  /** 完成后的子 usage 快照（calls>0 时） */
  usage?: import('./sessionUsage.ts').SessionUsage
  description?: string
  totalDurationMs?: number
  totalToolUseCount?: number
  worktreePath?: string
}

export type BackgroundTaskAdmission = {
  taskId: string
  parentTurnId?: string
  agentType: string
  prompt: string
  description?: string
  isolation: DurableTaskIsolation
}

export type BackgroundTaskCompletion = {
  taskId: string
  agentType: string
  state: Extract<DurableTaskState, 'completed' | 'error' | 'aborted'>
  summary: string
  isError: boolean
  agentTranscriptPath?: string
  usage?: import('./sessionUsage.ts').SessionUsage
  totalDurationMs?: number
  totalToolUseCount?: number
  worktreePath?: string
  detail?: string
}

export type DurableBackgroundTaskLifecycle = {
  admit(input: BackgroundTaskAdmission): Promise<void>
  markRunning(input: {
    taskId: string
    agentType: string
  }): Promise<void>
  finish(input: BackgroundTaskCompletion): Promise<void>
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
  /** DR3B：纯数据 FIFO 视图；可执行 closure 只保存在 WeakMap runtime。 */
  queuedAgentIds: string[]
  /** 已 durable terminal、等待父 safe boundary promotion 的 task ids。 */
  resultPromotionQueue: string[]
  /**
   * 并发上限（P-SA-CAP）。未设则用 getDefaultMaxBackgroundAgents()。
   */
  maxConcurrent?: number
  /** DR3A：createSession 绑定的 durable lifecycle；纯内存 embedding 可省略。 */
  durableLifecycle?: DurableBackgroundTaskLifecycle
}

type BackgroundAgentQueueRuntime = {
  draining: boolean
  jobs: Array<{
    taskId: string
    start(): Promise<void>
    onStartError(error: unknown): void
  }>
}

const backgroundAgentQueueRuntimes = new WeakMap<
  BackgroundAgentStore,
  BackgroundAgentQueueRuntime
>()

function getBackgroundAgentQueueRuntime(
  store: BackgroundAgentStore,
): BackgroundAgentQueueRuntime {
  let runtime = backgroundAgentQueueRuntimes.get(store)
  if (!runtime) {
    runtime = { draining: false, jobs: [] }
    backgroundAgentQueueRuntimes.set(store, runtime)
  }
  return runtime
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
 * - queue：DR3B 先 durable admitted，再交给 store FIFO 自动取得 slot。
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
          ? `background agent capacity full (${running}/${max}); enqueue for FIFO start`
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
    queuedAgentIds: [],
    resultPromotionQueue: [],
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
    parentTurnId?: string
  },
): BackgroundAgentEntry {
  const row: BackgroundAgentEntry = {
    agentId: entry.agentId,
    agentType: entry.agentType,
    prompt: entry.prompt,
    status: 'running',
    startedAt: entry.startedAt ?? nowIso(),
    ...(entry.parentTurnId
      ? { parentTurnId: entry.parentTurnId }
      : {}),
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
  > & {
    prompt?: string
    startedAt?: string
    parentTurnId?: string
    worktreePath?: string
    status?: Extract<BackgroundAgentStatus, 'done' | 'error' | 'aborted'>
  },
): BackgroundAgentEntry {
  const prev = store.pendingAgents[result.agentId]
  const row: BackgroundAgentEntry = {
    agentId: result.agentId,
    agentType: result.agentType,
    prompt: result.prompt ?? prev?.prompt ?? '',
    status: result.status ?? (result.isError ? 'error' : 'done'),
    startedAt: result.startedAt ?? prev?.startedAt ?? nowIso(),
    ...(result.parentTurnId ?? prev?.parentTurnId
      ? { parentTurnId: result.parentTurnId ?? prev?.parentTurnId }
      : {}),
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
    ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
  }
  store.pendingAgents[result.agentId] = row
  store.backgroundAgentResults[result.agentId] = row
  return row
}

export function enqueueBackgroundAgent(
  store: BackgroundAgentStore,
  input: {
    taskId: string
    agentType: string
    prompt: string
    parentTurnId?: string
    description?: string
    admittedAt?: string
    start(): Promise<void>
    onStartError(error: unknown): void
  },
): BackgroundAgentEntry {
  if (store.pendingAgents[input.taskId]) {
    throw new Error(`background task "${input.taskId}" already exists`)
  }
  const row: BackgroundAgentEntry = {
    agentId: input.taskId,
    agentType: input.agentType,
    prompt: input.prompt,
    status: 'queued',
    startedAt: input.admittedAt ?? nowIso(),
    ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
    ...(input.description?.trim()
      ? { description: input.description.trim() }
      : {}),
  }
  store.pendingAgents[input.taskId] = row
  store.queuedAgentIds.push(input.taskId)
  getBackgroundAgentQueueRuntime(store).jobs.push({
    taskId: input.taskId,
    start: input.start,
    onStartError: input.onStartError,
  })
  return row
}

export async function pumpBackgroundAgentQueue(
  store: BackgroundAgentStore,
): Promise<void> {
  const runtime = getBackgroundAgentQueueRuntime(store)
  if (runtime.draining) return
  runtime.draining = true
  try {
    const max =
      store.maxConcurrent ?? getDefaultMaxBackgroundAgents()
    while (
      countRunningBackgroundAgents(store) < max &&
      runtime.jobs.length > 0
    ) {
      const job = runtime.jobs.shift()
      if (!job) break
      store.queuedAgentIds = store.queuedAgentIds.filter(
        (taskId) => taskId !== job.taskId,
      )
      const queued = store.pendingAgents[job.taskId]
      if (queued?.status !== 'queued') continue
      // 同步占住 slot 并关闭 queued-cancel 窗口；worker 仍须等 running 落盘。
      store.pendingAgents[job.taskId] = {
        ...queued,
        status: 'running',
      }
      try {
        await job.start()
      } catch (error) {
        job.onStartError(error)
      }
    }
  } finally {
    runtime.draining = false
  }
}

export type CancelQueuedBackgroundAgentResult =
  | {
      ok: true
      task: BackgroundAgentEntry
      persistenceWarning?: string
    }
  | {
      ok: false
      code: 'task_not_found' | 'task_not_queued'
      detail: string
    }

export async function cancelQueuedBackgroundAgent(
  store: BackgroundAgentStore,
  rawTaskId: string,
): Promise<CancelQueuedBackgroundAgentResult> {
  const taskId = rawTaskId.trim()
  const row = store.pendingAgents[taskId]
  if (!row) {
    return {
      ok: false,
      code: 'task_not_found',
      detail: `background task "${taskId}" not found`,
    }
  }
  if (row.status !== 'queued') {
    return {
      ok: false,
      code: 'task_not_queued',
      detail: `background task "${taskId}" is ${row.status}, not queued`,
    }
  }

  const runtime = getBackgroundAgentQueueRuntime(store)
  runtime.jobs = runtime.jobs.filter((job) => job.taskId !== taskId)
  store.queuedAgentIds = store.queuedAgentIds.filter(
    (queuedId) => queuedId !== taskId,
  )

  const summary = 'Background task cancelled before start'
  let persistenceWarning: string | undefined
  try {
    await store.durableLifecycle?.finish({
      taskId,
      agentType: row.agentType,
      state: 'aborted',
      summary,
      isError: true,
      detail: 'cancelled_while_queued',
    })
  } catch (error) {
    persistenceWarning =
      `background task cancellation persistence failed: ` +
      `${error instanceof Error ? error.message : String(error)}`
  }
  const task = markBackgroundAgentFinished(store, {
    agentId: taskId,
    agentType: row.agentType,
    summary: persistenceWarning
      ? `${summary}; ${persistenceWarning}`
      : summary,
    isError: true,
    prompt: row.prompt,
    startedAt: row.startedAt,
    parentTurnId: row.parentTurnId,
    description: row.description,
    status: 'aborted',
  })
  if (!persistenceWarning) {
    queueBackgroundAgentResultForPromotion(store, taskId)
  }
  return {
    ok: true,
    task,
    ...(persistenceWarning ? { persistenceWarning } : {}),
  }
}

export function queueBackgroundAgentResultForPromotion(
  store: BackgroundAgentStore,
  taskId: string,
): void {
  if (!store.backgroundAgentResults[taskId]) return
  if (!store.resultPromotionQueue.includes(taskId)) {
    store.resultPromotionQueue.push(taskId)
  }
}

export function takeBackgroundAgentResultsForPromotion(
  store: BackgroundAgentStore,
): BackgroundAgentEntry[] {
  const ids = store.resultPromotionQueue.splice(
    0,
    store.resultPromotionQueue.length,
  )
  const rows: BackgroundAgentEntry[] = []
  for (const taskId of ids) {
    const row = store.backgroundAgentResults[taskId]
    if (row) rows.push({ ...row })
  }
  return rows
}

/** resume 只恢复诊断状态，不重启任何 worker。 */
export function restoreBackgroundAgentStoreFromDurableTasks(
  store: BackgroundAgentStore,
  tasks: readonly DurableTaskRecord[],
): void {
  backgroundAgentQueueRuntimes.delete(store)
  store.pendingAgents = {}
  store.backgroundAgentResults = {}
  store.queuedAgentIds = []
  store.resultPromotionQueue = []
  for (const task of tasks) {
    const status: BackgroundAgentStatus =
      task.state === 'completed'
        ? 'done'
        : task.state === 'aborted'
          ? 'aborted'
          : task.state === 'interrupted'
            ? 'interrupted'
            : task.state === 'error'
              ? 'error'
              : 'interrupted'
    const row: BackgroundAgentEntry = {
      agentId: task.taskId,
      agentType: task.agentType,
      prompt: task.prompt ?? '',
      status,
      startedAt: task.admittedAt,
      finishedAt: task.updatedAt,
      ...(task.parentTurnId ? { parentTurnId: task.parentTurnId } : {}),
      ...(task.result?.summary ? { summary: task.result.summary } : {}),
      ...(task.result ? { isError: task.result.isError } : {}),
      ...(task.result?.agentTranscriptPath
        ? { agentTranscriptPath: task.result.agentTranscriptPath }
        : {}),
      ...(task.result?.usage ? { usage: task.result.usage } : {}),
      ...(task.description ? { description: task.description } : {}),
      ...(task.result?.totalDurationMs != null
        ? { totalDurationMs: task.result.totalDurationMs }
        : {}),
      ...(task.result?.totalToolUseCount != null
        ? { totalToolUseCount: task.result.totalToolUseCount }
        : {}),
      ...(task.result?.worktreePath
        ? { worktreePath: task.result.worktreePath }
        : {}),
    }
    store.pendingAgents[task.taskId] = row
    if (
      status === 'done' ||
      status === 'error' ||
      status === 'aborted'
    ) {
      store.backgroundAgentResults[task.taskId] = row
    }
  }
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
  const nQueued = rows.filter((r) => r.status === 'queued').length
  const nDone = rows.filter((r) => r.status === 'done').length
  const nErr = rows.filter((r) => r.status === 'error').length
  const nAborted = rows.filter((r) => r.status === 'aborted').length
  const nInterrupted = rows.filter((r) => r.status === 'interrupted').length
  const max =
    store.maxConcurrent ?? getDefaultMaxBackgroundAgents()
  const lines: string[] = [
    `Background agents: total=${rows.length}  queued=${nQueued}  running=${nRun}/${max}  done=${nDone}  error=${nErr}  aborted=${nAborted}  interrupted=${nInterrupted}`,
    '',
  ]
  for (const r of rows) {
    const tag =
      r.status === 'queued'
        ? 'QUEUED'
        : r.status === 'running'
          ? 'RUNNING'
        : r.status === 'error'
          ? 'ERROR'
          : r.status === 'aborted'
            ? 'ABORTED'
            : r.status === 'interrupted'
              ? 'INTERRUPTED'
              : 'DONE'
    const desc = r.description?.trim() ? `  · ${r.description.trim()}` : ''
    lines.push(`  ${r.agentId}  [${tag}]  type=${r.agentType}${desc}`)
    if (r.status === 'queued' || r.status === 'running') {
      lines.push(`    prompt:  ${truncateOneLine(r.prompt, 80)}`)
      lines.push(
        `    ${r.status === 'queued' ? 'queued' : 'started'}: ${r.startedAt}`,
      )
    } else {
      const sum = (r.summary ?? '').trim() || '(no summary)'
      lines.push(`    summary: ${truncateOneLine(sum, 120)}`)
      if (r.finishedAt) lines.push(`    finished: ${r.finishedAt}`)
      if (r.agentTranscriptPath) {
        lines.push(`    transcript: ${r.agentTranscriptPath}`)
      }
      if (r.worktreePath) {
        lines.push(`    worktree: ${r.worktreePath}`)
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
      : getWorkspaceSessionsDir(opts.cwd)
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
 * fork 时 messages = 父浅拷贝 + directive；tools 按 spawnDepth/policy 处理 Agent。
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
  const policy = params.agentPolicy ?? defaultAgentPolicy()
  // 子 agent 默认 depth=1（由主会话 spawn）
  const spawnDepth = Math.max(
    1,
    Math.floor(params.spawnDepth ?? 1),
  )
  // 子能否再暴露 Agent：看「子作为父」时 depth 规则
  // 即子 loop 的 spawnDepth 是否仍允许带 Agent
  const allowAgentTool = canExposeAgentTool({
    spawnDepth,
    policy,
    def: params.def,
  })

  const allTools =
    params.allTools ??
    createDefaultTools(undefined, { agentPolicy: policy })

  let resolvedTools: BoloTool[]
  if (isFork) {
    // fork：父工具集，再按 allowAgentTool / sandbox
    let tools = allowAgentTool
      ? [...allTools]
      : allTools.filter((t) => t.name !== AGENT_TOOL_NAME)
    tools = applySandboxToolFilter(tools, params.def.sandbox)
    if (!allowAgentTool) {
      tools = tools.filter((t) => t.name !== AGENT_TOOL_NAME)
    }
    // fork 定义级 disallowed
    if (params.def.disallowedTools?.length) {
      const ban = new Set(params.def.disallowedTools)
      tools = tools.filter((t) => !ban.has(t.name))
    }
    resolvedTools = tools
  } else {
    resolvedTools = resolveAgentTools(params.def, allTools, {
      allowAgentTool,
    }).resolvedTools
  }

  const resolvedModel =
    params.model ??
    resolveSubagentModel({
      fork: isFork,
      defModel: params.def.model,
      policy,
      parentModel: params.parentModel,
    })
  const resolvedEffort =
    params.effort ??
    resolveSubagentEffort({
      fork: isFork,
      defEffort: params.def.effort,
      policy,
      parentEffort: params.parentEffort,
    })

  const messages: ChatMessage[] = isFork
    ? [
        ...(params.parentMessages ?? []).map((m) => ({ ...m })),
        { role: 'user', content: params.prompt },
      ]
    : [{ role: 'user', content: params.prompt }]
  let systemPromptSections =
    isFork &&
    params.parentSystemPromptSections &&
    params.parentSystemPromptSections.length > 0
      ? [...params.parentSystemPromptSections]
      : [params.def.systemPrompt]
  const permissionMode = resolveSubagentPermissionMode(
    params.permissionMode,
    params.def.permissionMode,
  )
  const requestedIsolation = params.isolation ?? params.def.isolation
  const envRequestsWorktree =
    requestedIsolation === undefined && isWorktreeEnabled()
  const wantWorktree =
    requestedIsolation === 'worktree' || envRequestsWorktree
  let cwd = params.cwd
  let isolationUsed: 'none' | 'worktree' = 'none'
  let worktreePath: string | undefined
  let worktreeCreated = false
  if (wantWorktree) {
    const { tryCreateSubagentWorktree } = await import('./worktree.ts')
    const wt = await tryCreateSubagentWorktree({
      parentCwd: params.cwd,
      agentId,
      force: requestedIsolation === 'worktree',
    })
    if (wt.ok) {
      cwd = wt.cwd
      isolationUsed = 'worktree'
      worktreePath = wt.path
      worktreeCreated = wt.created
    } else {
      const detail = `worktree isolation failed: ${wt.reason}`
      return {
        agentId,
        agentType,
        summary: `Subagent ${agentType} ${detail}`,
        isError: true,
        terminal: { reason: 'error', detail },
        messages,
        cwd: params.cwd,
        isolation: 'none',
        totalDurationMs: Math.max(0, Date.now() - startTimeMs),
        totalToolUseCount: 0,
        ...(taskDescription ? { description: taskDescription } : {}),
      }
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

  const startHook = await runHooks(
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
  // H3：exit 0 stdout 注入子代理 system 段
  if (startHook.injectText?.trim()) {
    systemPromptSections = [
      ...systemPromptSections,
      startHook.injectText.trim(),
    ]
  }

  let terminal: Terminal = { reason: 'completed' }
  /** SubagentStop exit 2 续跑预算 */
  let subStopContinuations = 0
  const maxSubStopContinuations = 3

  const runChildLoop = async (): Promise<Terminal> => {
    try {
      return await queryLoop({
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
        // 子 loop 内主 Stop 不续跑；由 SubagentStop 控制
        maxStopContinuations: 0,
        querySource: `subagent:${agentType}`,
        signal: params.signal,
        onEvent: params.onEvent,
        usage: childUsage,
        model: resolvedModel,
        effortLevel: resolvedEffort,
        agentDefinitions: params.agentDefinitions,
        agentPolicy: policy,
        spawnDepth,
      })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      return { reason: 'error', detail }
    }
  }

  terminal = await runChildLoop()

  // 父会话 usage 先不 merge；worktree 先不删——可能 SubagentStop 续跑
  // 循环：跑完 → SubagentStop(含 stats) → exit2 则再跑 → 再 Stop…
  let agentTranscriptPath: string | undefined
  let summary = ''
  let isError = false
  let stats = finalizeSubagentStats({
    messages,
    startTimeMs,
    usage: childUsage,
  })

  for (;;) {
    stats = finalizeSubagentStats({
      messages,
      startTimeMs,
      usage: childUsage,
    })
    const summaryText = lastAssistantText(messages)
    const failed =
      terminal.reason === 'error' ||
      terminal.reason === 'aborted' ||
      terminal.reason === 'user_prompt_blocked'
    isError = failed || !summaryText
    summary = isError
      ? summaryText ||
        `Subagent ${agentType} ended: ${terminal.reason}${terminal.detail ? ` (${terminal.detail})` : ''}`
      : summaryText

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
          cwd,
          messages,
        })
        agentTranscriptPath = sidePath
      } catch {
        /* 侧链失败不阻断 */
      }
    }

    const stopHook = await runHooks(
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

    const cont = (
      stopHook.continuationText ||
      stopHook.blockReason ||
      ''
    ).trim()
    if (
      stopHook.blocked &&
      cont &&
      subStopContinuations < maxSubStopContinuations &&
      terminal.reason === 'completed'
    ) {
      subStopContinuations += 1
      messages.push({
        role: 'user',
        content: `[SubagentStop hook continuation]\n${cont}`,
      })
      terminal = await runChildLoop()
      continue
    }
    break
  }

  // 父会话 usage 回卷
  if (params.parentUsage && childUsage) {
    const { mergeSessionUsage } = await import('./sessionUsage.ts')
    mergeSessionUsage(params.parentUsage, childUsage)
  }

  // worktree 清理：只删除本次创建且 clean 的 worktree；其它一律显式保留。
  let worktreeCleanup: WorktreeCleanupResult | undefined
  if (isolationUsed === 'worktree' && worktreePath) {
    if (params.cleanupWorktree === false) {
      worktreeCleanup = {
        status: 'retained',
        path: worktreePath,
        reason: 'automatic cleanup disabled',
      }
    } else if (!worktreeCreated) {
      worktreeCleanup = {
        status: 'retained',
        path: worktreePath,
        reason: 'pre-existing worktree is not owned by this subagent run',
      }
    } else {
      try {
        const { removeSubagentWorktree } = await import('./worktree.ts')
        worktreeCleanup = await removeSubagentWorktree({
          parentCwd: params.cwd,
          worktreePath,
        })
      } catch (error) {
        worktreeCleanup = {
          status: 'retained',
          path: worktreePath,
          reason:
            error instanceof Error
              ? `worktree cleanup failed: ${error.message}`
              : `worktree cleanup failed: ${String(error)}`,
        }
      }
    }
    if (worktreeCleanup.status === 'retained') {
      summary +=
        `\n\n[worktree retained] ${worktreeCleanup.path}` +
        ` (${worktreeCleanup.reason})`
    }
  }

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
    ...(worktreePath ? { worktreePath } : {}),
    ...(worktreeCleanup ? { worktreeCleanup } : {}),
    totalDurationMs: stats.totalDurationMs,
    totalToolUseCount: stats.totalToolUseCount,
    ...(taskDescription ? { description: taskDescription } : {}),
  }
}

export type SubagentParentContext = {
  parentSessionId: string
  /** DR3A：产品主路径透传当前 durable turn；embedding 可省略。 */
  parentTurnId?: string
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
   * fork 时的父消息输入源。
   * background completion 绝不异步修改此数组；结果只进入 durable/store，
   * DR3B 再由父 turn safe boundary promotion。
   */
  parentMessages?: ChatMessage[]
  /** fork 时继承的父 system 段 */
  parentSystemPromptSections?: readonly string[]
  /** 父会话 model 标签；inherit + usage.byModel */
  model?: string
  /** 父会话 effort */
  effort?: string
  /**
   * 父会话 usage 引用；子完成后 merge 回卷（同步 + 后台均生效）。
   */
  parentUsage?: import('./sessionUsage.ts').SessionUsage
  /** 全局策略 */
  agentPolicy?: AgentPolicy
  /** 父 loop 的 spawnDepth（主=0） */
  spawnDepth?: number
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
    'Poll background runs with /agents status or /bg; cancel queued work with /bg cancel <taskId>. Nested Agent is disabled in children.',
    typeLines ? `Available types:\n${typeLines}` : 'Types: explore|general|plan|fork',
  ].join(' ')
}

function launchBackgroundAgentWorker(input: {
  store: BackgroundAgentStore
  runParams: RunSubagentParams
  agentId: string
  agentType: string
  prompt: string
  parentTurnId?: string
  description?: string
}): void {
  const {
    store,
    runParams,
    agentId,
    agentType,
    prompt,
    parentTurnId,
    description,
  } = input
  void (async () => {
    try {
      let result: RunSubagentResult
      try {
        result = await runSubagent({ ...runParams, agentId })
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error)
        let durable = true
        try {
          await store.durableLifecycle?.finish({
            taskId: agentId,
            agentType,
            state: 'error',
            summary: `Background subagent failed: ${detail}`,
            isError: true,
            detail,
          })
        } catch {
          durable = false
          // durable error 写失败时磁盘保持 running，resume 投影 interrupted。
        }
        markBackgroundAgentFinished(store, {
          agentId,
          agentType,
          summary: `Background subagent failed: ${detail}`,
          isError: true,
          description,
          prompt,
          parentTurnId,
        })
        if (durable) {
          queueBackgroundAgentResultForPromotion(store, agentId)
        }
        return
      }

      try {
        const taskState: BackgroundTaskCompletion['state'] =
          result.terminal.reason === 'aborted'
            ? 'aborted'
            : result.isError
              ? 'error'
              : 'completed'
        await store.durableLifecycle?.finish({
          taskId: result.agentId,
          agentType: result.agentType,
          state: taskState,
          summary: result.summary,
          isError: result.isError,
          agentTranscriptPath: result.agentTranscriptPath,
          usage: result.usage,
          totalDurationMs: result.totalDurationMs,
          totalToolUseCount: result.totalToolUseCount,
          worktreePath: result.worktreePath,
        })
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error)
        markBackgroundAgentFinished(store, {
          agentId,
          agentType,
          summary:
            `Background task result persistence failed: ${detail}`,
          isError: true,
          description,
          prompt,
          parentTurnId,
        })
        return
      }

      markBackgroundAgentFinished(store, {
        agentId: result.agentId,
        agentType: result.agentType,
        summary: result.summary,
        isError: result.isError,
        agentTranscriptPath: result.agentTranscriptPath,
        usage: result.usage,
        totalDurationMs: result.totalDurationMs,
        totalToolUseCount: result.totalToolUseCount,
        description: result.description ?? description,
        prompt,
        parentTurnId,
        worktreePath: result.worktreePath,
        status:
          result.terminal.reason === 'aborted'
            ? 'aborted'
            : result.isError
              ? 'error'
              : 'done',
      })
      queueBackgroundAgentResultForPromotion(store, result.agentId)
    } finally {
      await pumpBackgroundAgentQueue(store)
    }
  })()
}

/**
 * 主会话 Agent 工具。须在 tool.call 的 extras.subagentParent 注入父上下文。
 */
export function createAgentTool(
  activeAgents?: ActiveAgentDefinitions | null,
  activePolicy?: AgentPolicy | null,
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
        model: {
          type: 'string',
          description:
            'Model override for this spawn (or "inherit"). Precedence over agent def / config default.',
        },
        effort: {
          type: 'string',
          description:
            'Effort override (low|medium|high|max|inherit). Precedence over agent def / config default.',
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

      const policy =
        parent.agentPolicy ?? activePolicy ?? defaultAgentPolicy()
      if (!policy.enabled) {
        return {
          ok: false,
          isError: true,
          output: 'Subagent tools disabled (config.agents.enabled=false)',
          errorCode: 'agents_disabled',
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

      const parentDepth = Math.max(0, Math.floor(parent.spawnDepth ?? 0))
      const childDepth = parentDepth + 1

      const toolModel =
        input.model != null && String(input.model).trim()
          ? String(input.model).trim()
          : undefined
      const toolEffort =
        input.effort != null && String(input.effort).trim()
          ? String(input.effort).trim()
          : undefined

      const resolvedModel = resolveSubagentModel({
        fork: useFork,
        toolModel,
        defModel: def.model,
        policy,
        parentModel: parent.model,
      })
      const resolvedEffort = resolveSubagentEffort({
        fork: useFork,
        toolEffort,
        defEffort: def.effort,
        policy,
        parentEffort: parent.effort,
      })

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
        parentModel: parent.model,
        parentEffort: parent.effort,
        parentUsage: parent.parentUsage,
        agentPolicy: policy,
        spawnDepth: childDepth,
        model: resolvedModel,
        effort: resolvedEffort,
        agentDefinitions: active,
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
        if (store.maxConcurrent === undefined) {
          store.maxConcurrent = policy.maxConcurrent
        }
        const cap = canStartBackgroundAgent(store, {
          maxConcurrent: store.maxConcurrent ?? policy.maxConcurrent,
          policy: policy.overflow,
        })
        if (!cap.ok && cap.policy !== 'queue') {
          return {
            ok: false,
            isError: true,
            output: cap.reason,
            errorCode: 'background_limit',
          }
        }
        const agentId = newId('agent')
        const durableIsolation: DurableTaskIsolation =
          isolationOverride ??
          def.isolation ??
          (isWorktreeEnabled() ? 'worktree' : 'none')
        try {
          await store.durableLifecycle?.admit({
            taskId: agentId,
            parentTurnId: parent.parentTurnId,
            agentType: def.agentType,
            prompt,
            description: taskDescription,
            isolation: durableIsolation,
          })
        } catch (error) {
          return {
            ok: false,
            isError: true,
            output:
              `background task durable admission failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            errorCode: 'background_persistence',
          }
        }

        const label = taskDescription ? ` (${taskDescription})` : ''
        const startTask = async (): Promise<void> => {
          await store.durableLifecycle?.markRunning({
            taskId: agentId,
            agentType: def.agentType,
          })
          markBackgroundAgentRunning(store, {
            agentId,
            agentType: def.agentType,
            prompt,
            parentTurnId: parent.parentTurnId,
            ...(taskDescription
              ? { description: taskDescription }
              : {}),
          })
          launchBackgroundAgentWorker({
            store,
            runParams,
            agentId,
            agentType: def.agentType,
            prompt,
            parentTurnId: parent.parentTurnId,
            description: taskDescription,
          })
        }
        const markStartFailure = (error: unknown): void => {
          const detail =
            error instanceof Error ? error.message : String(error)
          markBackgroundAgentFinished(store, {
            agentId,
            agentType: def.agentType,
            summary:
              `Background task durable start failed: ${detail}`,
            isError: true,
            prompt,
            parentTurnId: parent.parentTurnId,
            description: taskDescription,
          })
        }

        if (!cap.ok) {
          enqueueBackgroundAgent(store, {
            taskId: agentId,
            agentType: def.agentType,
            prompt,
            parentTurnId: parent.parentTurnId,
            description: taskDescription,
            start: startTask,
            onStartError: markStartFailure,
          })
          const position = store.queuedAgentIds.indexOf(agentId) + 1
          void pumpBackgroundAgentQueue(store)
          return {
            ok: true,
            output:
              `queued agent ${agentId}${label} at position ${position}; ` +
              `poll with /agents status or /bg`,
          }
        }

        try {
          await startTask()
        } catch (error) {
          markStartFailure(error)
          return {
            ok: false,
            isError: true,
            output:
              `background task durable start failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            errorCode: 'background_persistence',
          }
        }
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

/** 主会话默认工具集：内置 +（可选）Agent */
export function createDefaultTools(
  activeAgents?: ActiveAgentDefinitions | null,
  opts?: { agentPolicy?: AgentPolicy | null; includeAgent?: boolean },
): BoloTool[] {
  const policy = opts?.agentPolicy ?? defaultAgentPolicy()
  const include =
    opts?.includeAgent !== undefined
      ? opts.includeAgent
      : policy.enabled
  const builtins = createBuiltinTools()
  if (!include) return [...builtins]
  return [...builtins, createAgentTool(activeAgents, policy)]
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
    agentPolicy?: AgentPolicy
    model?: string
    effortLevel?: string
    onEvent?: (e: QueryLoopEvent) => void
  },
  agentType: string,
  prompt?: string,
): Promise<RunSubagentResult> {
  const def = getAgentDefinition(agentType, parent.agentDefinitions)
  const policy = parent.agentPolicy ?? defaultAgentPolicy()
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
    allTools: createDefaultTools(parent.agentDefinitions, {
      agentPolicy: policy,
    }),
    skills: parent.skills,
    onEvent: parent.onEvent,
    agentPolicy: policy,
    parentModel: parent.model,
    parentEffort: parent.effortLevel,
    spawnDepth: 1,
  })
}

/** @deprecated 使用 spawnSubagent / runSubagent；保留别名避免外部 import 断裂 */
export const spawnSubagentStub = spawnSubagent
