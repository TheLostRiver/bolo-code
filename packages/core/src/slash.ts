/**
 * 斜杠命令总线（最小）
 * 对照 HC：行首 `/` 为命令；`//` 不当命令；不调 LLM。
 * 无遥测。不依赖 core/index 顶层导入（避免循环）。
 */

import { existsSync } from 'node:fs'
import { getBoloHomeDir } from '../../config/src/paths.ts'
import {
  ensureAllLayouts,
  ensureProjectLayout,
} from '../../config/src/ensure.ts'
import {
  addAlwaysAllowBashPrefix,
  addAlwaysAllowPathGlob,
  addAlwaysAllowToolName,
  createEmptyPermissionRules,
  isPermissionMode,
  PERMISSION_MODES,
  PERMISSION_MODE_META,
  type PermissionMode,
  type SessionPermissionRules,
} from '../../permissions/src/index.ts'
import type { ChatMessage, HooksConfig, HookEvent } from '../../shared/src/index.ts'
import { HOOK_EVENTS } from '../../shared/src/index.ts'
import {
  estimateSystemSectionsTokens,
  estimateTokens,
  getContextPressure,
  type CompactSummarizer,
} from '../../compact/src/index.ts'
import {
  findSkillById,
  formatSkillBodyForInjection,
  type LoadedSkill,
} from '../../skills/src/index.ts'
import type { Terminal } from './queryLoop.ts'
import {
  formatSessionUsage,
  formatUsageOneLiner,
  type SessionUsage,
} from './sessionUsage.ts'

/** slash 需要的会话切片（与 BoloSession 兼容） */
export type SlashSession = {
  id: string
  cwd: string
  messages: ChatMessage[]
  systemPromptSections: string[]
  permissionMode: PermissionMode
  /** 会话 Always-allow；/allow 读写 */
  permissionRules?: SessionPermissionRules
  model?: string
  effortLevel?: string
  compactSummarizer?: CompactSummarizer
  /** 会话 skill 全文表；供 /skills 与 /<skill-id> 回落 */
  skills?: LoadedSkill[]
  /** 活跃 subagent 定义；供 /agents · /doctor */
  agentDefinitions?: import('./subagent.ts').ActiveAgentDefinitions
  /** 后台 subagent 表；/agents status · /bg */
  backgroundAgents?: import('./subagent.ts').BackgroundAgentStore
  /** 本地 usage 累计；/cost · /context · /doctor */
  usage?: SessionUsage
  /** 会话工具表；/doctor 计数 */
  tools?: { name: string }[]
  /** provider id；/doctor */
  provider?: { id?: string }
  /** auto compact 开关；/doctor · /context */
  autoCompactEnabled?: boolean
  /** 上下文窗口（token 粗估基准）；/context 压力 */
  contextWindowTokens?: number
  /** PTL 重试上限；/doctor */
  maxPtlRetries?: number
  /** 已连接 MCP；/doctor · /mcp */
  mcpConnections?: Array<{
    name: string
    /** stdio | http | sse */
    transport?: string
    /** connected | error | closed */
    status?: string
    tools?: Array<{ name: string; description?: string }>
    resources?: Array<{
      uri: string
      name?: string
      description?: string
      mimeType?: string
    }>
    prompts?: Array<{
      name: string
      description?: string
      arguments?: Array<{ name: string; required?: boolean }>
    }>
    capabilities?: {
      tools?: boolean
      resources?: boolean
      prompts?: boolean
    }
  }>
  /** workspace 插件；/plugins · /doctor */
  plugins?: Array<{
    manifest: { id: string; name?: string; version?: string }
    root?: string
    scope?: string
  }>
  /** hooks 配置；/hooks */
  hooks?: HooksConfig
}

export type ParseSlashResult =
  | { kind: 'command'; name: string; args: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'empty' }

export type SlashDispatchResult = {
  message: string
  ok: boolean
}

export type SubmitUserInputResult =
  | { type: 'slash'; message: string }
  | { type: 'prompt'; terminal: Terminal }
  | { type: 'empty' }

/** /help 分组（展示顺序固定） */
export type SlashCommandGroup =
  | 'session'
  | 'model'
  | 'extensions'
  | 'diagnostics'
  | 'other'

export const SLASH_GROUP_LABELS: Record<SlashCommandGroup, string> = {
  session: 'Session',
  model: 'Model & permissions',
  extensions: 'Extensions',
  diagnostics: 'Diagnostics',
  other: 'Other',
}

export const SLASH_GROUP_ORDER: SlashCommandGroup[] = [
  'session',
  'model',
  'extensions',
  'diagnostics',
  'other',
]

export type SlashCommandDef = {
  name: string
  summary: string
  usage?: string
  /** /help 分组；缺省归 other */
  group?: SlashCommandGroup
  /** 隐藏别名不单独占 help 行（如 status→doctor）；仍可 dispatch */
  hidden?: boolean
  run: (
    session: SlashSession,
    args: string,
  ) => Promise<SlashDispatchResult> | SlashDispatchResult
}

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
  'auto',
] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v)
}

/**
 * 解析一行用户输入。
 * - 空 → empty
 * - 行首 `/` 且非 `//` → command
 * - 其余 → prompt（含 `//` 前缀）
 */
export function parseSlashLine(text: string): ParseSlashResult {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'empty' }

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    const body = trimmed.slice(1)
    const m = /^([^\s]+)(?:\s+(.*))?$/s.exec(body)
    if (!m || !m[1]) {
      return { kind: 'prompt', text: text }
    }
    const name = m[1].toLowerCase()
    const args = (m[2] ?? '').trim()
    return { kind: 'command', name, args }
  }

  return { kind: 'prompt', text: text }
}

function approxChars(session: SlashSession): number {
  let n = 0
  for (const msg of session.messages) {
    n += (msg.content ?? '').length
  }
  for (const s of session.systemPromptSections) {
    n += s.length
  }
  return n
}

/**
 * 粗算 token（本地估计，非计费真值）。
 * 与 compact `estimateTextTokens` 正文默认一致（≈chars/4）；
 * 完整 messages 请用 `estimateTokens`（含 tool_calls / 密文权重）。
 */
export function approxTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
}

/** 会话对话 + system 段 token 粗估（/context 真源） */
export function estimateSessionContextTokens(session: {
  messages: ChatMessage[]
  systemPromptSections: string[]
}): {
  messagesTokens: number
  systemTokens: number
  totalTokens: number
} {
  const messagesTokens = estimateTokens(session.messages)
  const systemTokens = estimateSystemSectionsTokens(session.systemPromptSections)
  return {
    messagesTokens,
    systemTokens,
    totalTokens: messagesTokens + systemTokens,
  }
}

/** section 首行标签（去 # 前缀），供 /context */
export function sectionLabel(section: string, maxLen = 48): string {
  const first = (section.split(/\r?\n/).find((l) => l.trim()) ?? '').trim()
  const bare = first.replace(/^#+\s*/, '')
  if (!bare) return '(empty)'
  return bare.length > maxLen ? `${bare.slice(0, maxLen - 1)}…` : bare
}

/** 编辑距离（小串；未知命令建议用） */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase()
  const t = b.toLowerCase()
  if (s === t) return 0
  if (!s.length) return t.length
  if (!t.length) return s.length
  const prev = new Array<number>(t.length + 1)
  const cur = new Array<number>(t.length + 1)
  for (let j = 0; j <= t.length; j++) prev[j] = j
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      )
    }
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j] ?? 0
  }
  return prev[t.length] ?? t.length
}

/** 为未知命令挑 1–3 个相近内置名（不含 hidden 别名重复感时可仍含） */
export function suggestSlashCommands(
  name: string,
  limit = 3,
): string[] {
  const needle = name.toLowerCase()
  const candidates = SLASH_COMMANDS.filter((c) => !c.hidden).map((c) => c.name)
  const scored = candidates
    .map((n) => {
      let score = editDistance(needle, n)
      if (n.startsWith(needle) || needle.startsWith(n)) score = Math.min(score, 1)
      if (n.includes(needle) || needle.includes(n)) score = Math.min(score, 2)
      return { n, score }
    })
    .filter((x) => x.score <= 3)
    .sort((a, b) => a.score - b.score || a.n.localeCompare(b.n))
  const out: string[] = []
  for (const x of scored) {
    if (out.includes(x.n)) continue
    out.push(x.n)
    if (out.length >= limit) break
  }
  return out
}

function formatUnknownCommand(name: string): string {
  const tips = [
    `Unknown command /${name}.`,
    'Type /help for grouped list, or /skills for skill ids.',
  ]
  const suggestions = suggestSlashCommands(name)
  if (suggestions.length) {
    tips.push(`Did you mean: ${suggestions.map((s) => `/${s}`).join(', ')}?`)
  }
  return tips.join(' ')
}

function formatHelp(): string {
  const visible = SLASH_COMMANDS.filter((c) => !c.hidden)
  const byGroup = new Map<SlashCommandGroup, SlashCommandDef[]>()
  for (const g of SLASH_GROUP_ORDER) byGroup.set(g, [])
  for (const c of visible) {
    const g = c.group ?? 'other'
    const list = byGroup.get(g) ?? []
    list.push(c)
    byGroup.set(g, list)
  }

  const lines = ['Slash commands:', '']
  for (const g of SLASH_GROUP_ORDER) {
    const list = byGroup.get(g) ?? []
    if (!list.length) continue
    lines.push(`${SLASH_GROUP_LABELS[g]}:`)
    for (const c of list) {
      const usage = c.usage ? ` ${c.usage}` : ''
      lines.push(`  /${c.name}${usage}`)
      lines.push(`    ${c.summary}`)
    }
    lines.push('')
  }
  lines.push('Aliases: /status → /doctor · /usage → /cost')
  lines.push('Tip: lines starting with // are normal prompts, not commands.')
  lines.push('Skills: /skills · invoke /<skill-id> or /skill <id>')
  return lines.join('\n')
}

async function cmdHelp(
  _session: SlashSession,
  _args: string,
): Promise<SlashDispatchResult> {
  return { ok: true, message: formatHelp() }
}

function cmdClear(session: SlashSession, _args: string): SlashDispatchResult {
  const n = session.messages.length
  session.messages.length = 0
  return {
    ok: true,
    message: `Cleared ${n} conversation message(s). Session id/cwd/config and system prompt sections kept.`,
  }
}

async function cmdCompact(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  if (!session.compactSummarizer) {
    return {
      ok: false,
      message:
        'compact failed: no summarizer on session (inject CompactSummarizer; see docs/COMPACTION.md).',
    }
  }
  const before = estimateSessionContextTokens(session)
  // 延迟导入，避免与 core/index 循环依赖
  const { compactSession } = await import('./index.ts')
  const note = args.trim() || undefined
  const r = await compactSession(session as Parameters<typeof compactSession>[0], {
    trigger: 'manual',
    customInstructions: note,
  })
  if (!r.ok) {
    return {
      ok: false,
      message: `compact failed: ${r.reason ?? 'unknown'}`,
    }
  }
  const after = estimateSessionContextTokens(session)
  const saved = Math.max(0, before.messagesTokens - after.messagesTokens)
  const notePart = note ? ` note=${JSON.stringify(note)}` : ''
  return {
    ok: true,
    message: [
      `Compacted conversation.${notePart}`,
      `messages tokens: ~${before.messagesTokens} → ~${after.messagesTokens} (saved ~${saved})`,
      `system tokens:   ~${after.systemTokens} (unchanged by compact)`,
      `total est:       ~${after.totalTokens}  (local heuristic; not billing)`,
    ].join('\n'),
  }
}

function cmdContext(session: SlashSession, _args: string): SlashDispatchResult {
  const chars = approxChars(session)
  const est = estimateSessionContextTokens(session)
  const window =
    typeof session.contextWindowTokens === 'number' &&
    session.contextWindowTokens > 0
      ? session.contextWindowTokens
      : 128_000
  const pressure = getContextPressure({
    tokenCount: est.totalTokens,
    contextWindowTokens: window,
  })
  const autoOn = session.autoCompactEnabled === true
  const sections = session.systemPromptSections
  const lines = [
    `id:              ${session.id}`,
    `cwd:             ${session.cwd}`,
    `messages:        ${session.messages.length}`,
    `chars (approx):  ${chars}`,
    `tokens (est):    ~${est.totalTokens}  (messages ~${est.messagesTokens} + system ~${est.systemTokens})`,
    `  heuristic:     text≈chars/4; dense JSON≈chars/2; tool_calls counted (local only, not billing)`,
    `window:          ${window}  (effective ~${pressure.effectiveWindow}; auto threshold ~${pressure.autoThreshold})`,
    `pressure:        ${pressure.level}  (~${pressure.percentOfWindow}% of window; ~${pressure.percentOfThreshold}% of auto threshold)`,
    `autoCompact:     ${autoOn ? 'on' : 'off'}${autoOn && pressure.aboveAutoThreshold ? '  (would trigger on next prepare)' : ''}`,
    `permissionMode:  ${session.permissionMode}`,
    `model:           ${session.model ?? '(unset)'}`,
    `effort:          ${session.effortLevel ?? 'auto'}`,
    `system sections: ${sections.length}`,
  ]
  if (sections.length) {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i] ?? ''
      const secTok = estimateSystemSectionsTokens([s])
      lines.push(
        `  [${i + 1}] ${sectionLabel(s)}  (${s.length} chars, ~${secTok} tok)`,
      )
    }
  }
  lines.push(
    'cache:           stable system prefix first; providers may send cache_control / prompt_cache_key (see docs/PROMPT_CACHE.md)',
    'prepare order:   microcompact → auto full compact → callModel (PTL truncate is fallback)',
    formatUsageOneLiner(session.usage),
  )
  return { ok: true, message: lines.join('\n') }
}

/**
 * 极简本地诊断（对照 HC /doctor · /status）。
 * 无 Electron、无遥测；只读会话与本机环境。
 */
function cmdDoctor(session: SlashSession, _args: string): SlashDispatchResult {
  const boloHome = getBoloHomeDir()
  const boloHomeExists = existsSync(boloHome)
  const toolsCount = session.tools?.length ?? 0
  const skillsCount = session.skills?.length ?? 0
  const agentTypesCount = session.agentDefinitions
    ? Object.keys(session.agentDefinitions).length
    : 0
  const mcpCount = session.mcpConnections?.length ?? 0
  const pluginsCount = session.plugins?.length ?? 0
  const autoCompact =
    session.autoCompactEnabled === true ? 'on' : 'off'
  const maxPtl =
    session.maxPtlRetries === undefined
      ? '(unset)'
      : String(session.maxPtlRetries)

  const lines = [
    `node:            ${process.version}`,
    `platform:        ${process.platform}`,
    `cwd:             ${session.cwd}`,
    `session id:      ${session.id}`,
    `provider:        ${session.provider?.id ?? '(unset)'}`,
    `permissionMode:  ${session.permissionMode}`,
    `model:           ${session.model ?? '(unset)'}`,
    `effort:          ${session.effortLevel ?? 'auto'}`,
    `messages:        ${session.messages.length}`,
    `system sections: ${session.systemPromptSections.length}`,
    `tools:           ${toolsCount}`,
    `skills:          ${skillsCount}`,
    `agent types:     ${agentTypesCount}`,
    `plugins:         ${pluginsCount}`,
  ]
  lines.push(`mcp connections: ${mcpCount}`)
  lines.push(
    formatUsageOneLiner(session.usage),
    `autoCompact:     ${autoCompact}`,
    `maxPtlRetries:   ${maxPtl}`,
    `~/.bolo:         ${boloHome} (${boloHomeExists ? 'exists' : 'missing'})`,
    'Tip: /context for token estimate + section labels; /help for commands.',
  )
  return { ok: true, message: lines.join('\n') }
}

function cmdMcp(session: SlashSession, args: string): SlashDispatchResult {
  const conns = session.mcpConnections ?? []
  const sub = args.trim().toLowerCase()
  if (!conns.length) {
    return {
      ok: true,
      message:
        'mcp: (none connected)\nConfigure ~/.bolo/mcp.json or .bolo/mcp.json and createSessionFromWorkspace({ connectMcp: true }).',
    }
  }
  if (sub === 'tools' || sub.startsWith('tools ')) {
    const lines: string[] = [`mcp tools (${conns.length} server(s)):`]
    for (const s of conns) {
      const tools = s.tools ?? []
      if (!tools.length) {
        lines.push(`  ${s.name}: (no tools listed)`)
        continue
      }
      for (const t of tools) {
        const desc = t.description ? ` — ${t.description.slice(0, 60)}` : ''
        lines.push(`  mcp__${s.name}__${t.name}${desc}`)
      }
    }
    return { ok: true, message: lines.join('\n') }
  }
  if (sub === 'resources' || sub.startsWith('resources ')) {
    const lines: string[] = [`mcp resources (${conns.length} server(s)):`]
    let any = false
    for (const s of conns) {
      const resources = s.resources ?? []
      if (!resources.length) {
        const cap = s.capabilities?.resources ? 'none listed' : 'not supported'
        lines.push(`  ${s.name}: (${cap})`)
        continue
      }
      any = true
      for (const r of resources) {
        const label = r.name ? `${r.name} ` : ''
        const mime = r.mimeType ? ` [${r.mimeType}]` : ''
        lines.push(`  ${s.name}  ${label}${r.uri}${mime}`)
      }
    }
    if (!any) {
      lines.push(
        'Tip: servers without resources still may expose tools; use ListMcpResources tool when connected.',
      )
    } else {
      lines.push('Read via tool ReadMcpResource { server, uri }.')
    }
    return { ok: true, message: lines.join('\n') }
  }
  if (sub === 'prompts' || sub.startsWith('prompts ')) {
    const lines: string[] = [`mcp prompts (${conns.length} server(s)):`]
    let any = false
    for (const s of conns) {
      const prompts = s.prompts ?? []
      if (!prompts.length) {
        const cap = s.capabilities?.prompts ? 'none listed' : 'not supported'
        lines.push(`  ${s.name}: (${cap})`)
        continue
      }
      any = true
      for (const p of prompts) {
        const desc = p.description ? ` — ${p.description.slice(0, 50)}` : ''
        const argsHint =
          p.arguments?.length
            ? ` (args: ${p.arguments.map((a) => a.name).join(', ')})`
            : ''
        lines.push(`  ${s.name}/${p.name}${argsHint}${desc}`)
      }
    }
    if (any) {
      lines.push('Fetch via tool GetMcpPrompt { server, name, arguments? }.')
    }
    return { ok: true, message: lines.join('\n') }
  }
  const lines = [`mcp servers (${conns.length}):`]
  for (const s of conns) {
    const n = s.tools?.length ?? 0
    const nr = s.resources?.length ?? 0
    const np = s.prompts?.length ?? 0
    const caps: string[] = []
    if (s.capabilities?.tools || n > 0) caps.push('tools')
    if (s.capabilities?.resources) caps.push('resources')
    if (s.capabilities?.prompts) caps.push('prompts')
    const capStr = caps.length ? caps.join('+') : 'unknown'
    const transport = s.transport ?? 'stdio'
    const status = s.status ?? 'connected'
    lines.push(
      `  ${s.name}  transport=${transport}  status=${status}  tools=${n} resources=${nr} prompts=${np}  [${capStr}]`,
    )
  }
  lines.push(
    'Use /mcp tools | /mcp resources | /mcp prompts for details.',
  )
  return { ok: true, message: lines.join('\n') }
}

function cmdPlugins(session: SlashSession, _args: string): SlashDispatchResult {
  const plugins = session.plugins ?? []
  if (!plugins.length) {
    return {
      ok: true,
      message:
        'plugins: (none loaded)\nPlace plugins under ~/.bolo/plugins/<id>/ or .bolo/plugins/<id>/ with bolo.plugin.json (PL1 local only; no marketplace).',
    }
  }
  const lines = [`plugins (${plugins.length}):`]
  for (const p of plugins) {
    const id = p.manifest?.id ?? '(unknown)'
    const name = p.manifest?.name ? ` — ${p.manifest.name}` : ''
    const ver = p.manifest?.version ? ` v${p.manifest.version}` : ''
    const scope = p.scope ? ` [${p.scope}]` : ''
    lines.push(`  ${id}${ver}${scope}${name}`)
  }
  return { ok: true, message: lines.join('\n') }
}

/**
 * 列出会话 hooks 配置（只读）。
 * 无参：各事件 matcher 组数 / command 数；有参：该事件详情。
 */
function cmdHooks(session: SlashSession, args: string): SlashDispatchResult {
  const hooks: HooksConfig = session.hooks ?? {}
  const want = args.trim()
  if (want) {
    const event = HOOK_EVENTS.find(
      (e) => e.toLowerCase() === want.toLowerCase(),
    ) as HookEvent | undefined
    if (!event) {
      return {
        ok: false,
        message: `Unknown hook event "${want}". Known: ${HOOK_EVENTS.join(', ')}`,
      }
    }
    const groups = hooks[event] ?? []
    if (!groups.length) {
      return { ok: true, message: `${event}: (no handlers configured)` }
    }
    const lines = [`${event} (${groups.length} matcher group(s)):`]
    groups.forEach((g, i) => {
      const matcher = g.matcher ? `matcher=${JSON.stringify(g.matcher)}` : 'matcher=*'
      lines.push(`  [${i}] ${matcher}`)
      for (const h of g.hooks ?? []) {
        const t = h.timeout != null ? ` timeout=${h.timeout}` : ''
        const a = h.async ? ' async' : ''
        lines.push(`      - ${h.type}: ${h.command}${t}${a}`)
      }
    })
    return { ok: true, message: lines.join('\n') }
  }

  let totalCmds = 0
  const lines = ['hooks (configured events):']
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event] ?? []
    if (!groups.length) continue
    let cmds = 0
    for (const g of groups) cmds += g.hooks?.length ?? 0
    totalCmds += cmds
    lines.push(`  ${event}: ${groups.length} group(s), ${cmds} command(s)`)
  }
  if (totalCmds === 0) {
    return {
      ok: true,
      message:
        'hooks: (none configured)\nConfigure ~/.bolo/hooks.json or .bolo/hooks.json. Use /hooks <EventName> for details.',
    }
  }
  lines.push(`total commands: ${totalCmds}`)
  lines.push('Use /hooks <EventName> for matchers and commands.')
  return { ok: true, message: lines.join('\n') }
}

/**
 * 初始化 ~/.bolo + 项目 .bolo 布局（对照 HC /init 脚手架语义，仅布局不写 CLAUDE 长文）。
 * `user` = 仅用户布局；`project` = 仅项目；默认两者。
 */
async function cmdInit(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const mode = args.trim().toLowerCase() || 'all'
  const lines: string[] = []
  try {
    if (mode === 'user') {
      const { ensureUserLayout } = await import('../../config/src/ensure.ts')
      const r = await ensureUserLayout({ writeDefaults: true })
      lines.push(`user layout: ${getBoloHomeDir()}`)
      if (r.created.length) {
        lines.push(`created (${r.created.length}):`)
        for (const f of r.created) lines.push(`  + ${f}`)
      } else {
        lines.push('created: (already present)')
      }
    } else if (mode === 'project') {
      const r = await ensureProjectLayout(session.cwd, { writeDefaults: true })
      lines.push(`project layout: ${r.layout.root}`)
      if (r.created.length) {
        lines.push(`created (${r.created.length}):`)
        for (const f of r.created) lines.push(`  + ${f}`)
      } else {
        lines.push('created: (already present)')
      }
    } else if (mode === 'all' || mode === '') {
      const r = await ensureAllLayouts(session.cwd, { writeDefaults: true })
      lines.push(`user:    ${r.user.layout.root}`)
      lines.push(`project: ${r.project.layout.root}`)
      const created = [...r.user.created, ...r.project.created]
      if (created.length) {
        lines.push(`created (${created.length}):`)
        for (const f of created) lines.push(`  + ${f}`)
      } else {
        lines.push('created: (all defaults already present)')
      }
    } else {
      return {
        ok: false,
        message: 'Usage: /init [all|user|project]',
      }
    }
    lines.push('Dirs include skills/, plugins/, sessions/, rules/, agents/.')
    lines.push('See docs/CONFIG.md')
    return { ok: true, message: lines.join('\n') }
  } catch (e) {
    return {
      ok: false,
      message: `init failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

function cmdCost(session: SlashSession, _args: string): SlashDispatchResult {
  return { ok: true, message: formatSessionUsage(session.usage) }
}

function cmdModel(session: SlashSession, args: string): SlashDispatchResult {
  const name = args.trim()
  if (!name) {
    return {
      ok: true,
      message: `model: ${session.model ?? '(unset)'}`,
    }
  }
  session.model = name
  return { ok: true, message: `model set to ${name}` }
}

function cmdEffort(session: SlashSession, args: string): SlashDispatchResult {
  const raw = args.trim().toLowerCase()
  if (!raw) {
    return {
      ok: true,
      message: `effort: ${session.effortLevel ?? 'auto'} (maps to max_tokens via mapEffort)`,
    }
  }
  if (!isEffortLevel(raw)) {
    return {
      ok: false,
      message: `Invalid effort "${args.trim()}". Usage: /effort [low|medium|high|max|auto]`,
    }
  }
  if (raw === 'auto') {
    session.effortLevel = undefined
    return { ok: true, message: 'effort set to auto (cleared session override)' }
  }
  session.effortLevel = raw
  return { ok: true, message: `effort set to ${raw}` }
}

function cmdPlan(session: SlashSession, _args: string): SlashDispatchResult {
  session.permissionMode = 'plan'
  return { ok: true, message: 'permissionMode set to plan' }
}

function cmdPermissions(
  session: SlashSession,
  args: string,
): SlashDispatchResult {
  const raw = args.trim()
  if (!raw) {
    const list = PERMISSION_MODES.map((m) => {
      const meta = PERMISSION_MODE_META[m]
      const mark = m === session.permissionMode ? ' *' : ''
      return `  ${m}${mark} — ${meta.userLabel}`
    }).join('\n')
    return {
      ok: true,
      message: `permissionMode: ${session.permissionMode}\nmodes:\n${list}`,
    }
  }
  if (!isPermissionMode(raw)) {
    return {
      ok: false,
      message: `Invalid mode "${raw}". Usage: /permissions [${PERMISSION_MODES.join('|')}]`,
    }
  }
  session.permissionMode = raw
  return { ok: true, message: `permissionMode set to ${raw}` }
}

function ensurePermissionRules(session: SlashSession): SessionPermissionRules {
  if (!session.permissionRules) {
    session.permissionRules = createEmptyPermissionRules()
  }
  return session.permissionRules
}

/**
 * /allow [ToolName | path:glob | bash:prefix] — 会话 always-allow
 * - 无参：列出当前规则
 * - ToolName：精确工具名
 * - path:GLOB：路径 glob（相对 cwd）
 * - bash:PREFIX：Bash 命令前缀
 */
function cmdAllow(session: SlashSession, args: string): SlashDispatchResult {
  const rules = ensurePermissionRules(session)
  const raw = args.trim()
  if (!raw) {
    const names = rules.alwaysAllowToolNames
    const prefixes = rules.alwaysAllowPrefixes ?? []
    const pathGlobs = rules.alwaysAllowPathGlobs ?? []
    const bashPrefs = rules.alwaysAllowBashPrefixes ?? []
    if (
      !names.length &&
      !prefixes.length &&
      !pathGlobs.length &&
      !bashPrefs.length
    ) {
      return {
        ok: true,
        message:
          'Session always-allow: (empty)\n' +
          'Usage:\n' +
          '  /allow ToolName\n' +
          '  /allow path:src' +
          '/**\n' +
          '  /allow bash:git\n' +
          'Tip: at permission prompt, answer a = allow always this tool name this session.',
      }
    }
    const lines = ['Session always-allow:']
    if (names.length) lines.push(`  tools: ${names.join(', ')}`)
    if (prefixes.length) lines.push(`  tool-prefixes: ${prefixes.join(', ')}`)
    if (pathGlobs.length) lines.push(`  paths: ${pathGlobs.join(', ')}`)
    if (bashPrefs.length) lines.push(`  bash: ${bashPrefs.join(', ')}`)
    lines.push(
      'Add: /allow ToolName | /allow path:GLOB | /allow bash:PREFIX',
    )
    return { ok: true, message: lines.join('\n') }
  }

  const lower = raw.toLowerCase()
  if (lower.startsWith('path:')) {
    const glob = raw.slice(5).trim()
    if (!glob) {
      return {
        ok: false,
        message: 'Usage: /allow path:<glob>  (path glob relative to cwd)',
      }
    }
    addAlwaysAllowPathGlob(rules, glob)
    return {
      ok: true,
      message: `always-allow path glob: ${glob}\ncurrent paths: ${(rules.alwaysAllowPathGlobs ?? []).join(', ')}`,
    }
  }
  if (lower.startsWith('bash:')) {
    const pref = raw.slice(5).trim()
    if (!pref) {
      return {
        ok: false,
        message: 'Usage: /allow bash:git  (command prefix after bash:)',
      }
    }
    addAlwaysAllowBashPrefix(rules, pref)
    return {
      ok: true,
      message: `always-allow bash prefix: ${pref}\ncurrent bash: ${(rules.alwaysAllowBashPrefixes ?? []).join(', ')}`,
    }
  }

  addAlwaysAllowToolName(rules, raw)
  return {
    ok: true,
    message: `always-allow added for this session: ${raw}\ncurrent tools: ${rules.alwaysAllowToolNames.join(', ')}`,
  }
}

async function cmdRules(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const { loadBoloRules } = await import('./rules.ts')
  const loaded = await loadBoloRules({ cwd: session.cwd })
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? 'list').toLowerCase()

  if (sub === 'list' || sub === '') {
    if (!loaded.sources.length) {
      return {
        ok: true,
        message:
          'No rules loaded.\nPlace markdown under .bolo/rules/ (or ~/.bolo/rules/).\nSee docs/RULES.md.',
      }
    }
    const lines = [
      `Loaded ${loaded.sources.length} rule file(s) into system prompt:`,
      '',
      ...loaded.sources.map(
        (s, i) =>
          `  ${i + 1}. ${s.label}  (${s.chars} chars${s.truncated ? ', truncated' : ''})`,
      ),
      '',
      'Tip: /rules show <name>  ·  dirs: .bolo/rules/  ~/.bolo/rules/',
    ]
    return { ok: true, message: lines.join('\n') }
  }

  if (sub === 'show') {
    const name = parts.slice(1).join(' ').trim()
    if (!name) {
      return {
        ok: false,
        message: 'Usage: /rules show <name>  (basename or path fragment)',
      }
    }
    const needle = name.replace(/\\/g, '/').toLowerCase()
    const hit =
      loaded.sources.find((s) => s.label.toLowerCase() === needle) ??
      loaded.sources.find((s) =>
        s.label.toLowerCase().endsWith('/' + needle),
      ) ??
      loaded.sources.find((s) => s.label.toLowerCase().includes(needle))
    if (!hit) {
      return {
        ok: false,
        message: `No loaded rule matching "${name}". Try /rules list.`,
      }
    }
    // 从 system sections 抽对应 ### 块；找不到则只回 label
    const section = session.systemPromptSections.find((s) =>
      s.includes('# Project rules'),
    )
    if (section) {
      const marker = `### ${hit.label}`
      const idx = section.indexOf(marker)
      if (idx !== -1) {
        const rest = section.slice(idx)
        const next = rest.indexOf('\n### ', marker.length)
        const body = (next === -1 ? rest : rest.slice(0, next)).trim()
        return { ok: true, message: body }
      }
    }
    return {
      ok: true,
      message: `${hit.label}\n(${hit.chars} chars, scope=${hit.scope})`,
    }
  }

  return {
    ok: false,
    message: `Unknown /rules subcommand "${sub}". Use: list | show <name>`,
  }
}

function sessionSkills(session: SlashSession): LoadedSkill[] {
  return session.skills ?? []
}

async function cmdAgents(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const sub = args.trim().toLowerCase()
  if (sub === 'status' || sub === 'bg' || sub.startsWith('status ')) {
    const { formatBackgroundAgentsStatus } = await import('./subagent.ts')
    return {
      ok: true,
      message: formatBackgroundAgentsStatus(session.backgroundAgents),
    }
  }

  const { listActiveAgents, loadAgentsDir, builtinAgentMap } = await import(
    './subagent.ts'
  )
  let active = session.agentDefinitions
  if (!active || !Object.keys(active).length) {
    const loaded = await loadAgentsDir({ cwd: session.cwd })
    active = loaded.active
  }
  const agents = listActiveAgents(active ?? builtinAgentMap())
  if (!agents.length) {
    return {
      ok: true,
      message:
        'No agent types.\nPlace markdown under .bolo/agents/ (or ~/.bolo/agents/).\nSee docs/SUBAGENT.md.',
    }
  }
  const lines = [
    `Active subagent types (${agents.length}):`,
    '',
    ...agents.map((a) => {
      const src = a.source ?? 'builtin'
      const tools =
        a.tools === '*'
          ? '*'
          : Array.isArray(a.tools)
            ? a.tools.join(', ')
            : String(a.tools)
      const mode = a.permissionMode ? ` mode=${a.permissionMode}` : ''
      return `  ${a.agentType}  [${src}]${mode}\n    ${a.description}\n    tools: ${tools}`
    }),
    '',
    'Dirs: .bolo/agents/*.md  ·  ~/.bolo/agents/*.md  ·  project overrides builtin',
    'Agent tool: subagent_type=<name> · run_in_background=true',
    'Background: /agents status  ·  /bg',
  ]
  return { ok: true, message: lines.join('\n') }
}

async function cmdBg(session: SlashSession): Promise<SlashDispatchResult> {
  const { formatBackgroundAgentsStatus } = await import('./subagent.ts')
  return {
    ok: true,
    message: formatBackgroundAgentsStatus(session.backgroundAgents),
  }
}

function cmdSkills(session: SlashSession, args: string): SlashDispatchResult {
  const skills = sessionSkills(session)
  const filter = args.trim().toLowerCase()
  const list = filter
    ? skills.filter(
        (s) =>
          s.meta.id.toLowerCase().includes(filter) ||
          s.meta.name.toLowerCase().includes(filter),
      )
    : skills

  if (!list.length) {
    return {
      ok: true,
      message: filter
        ? `No skills matching "${args.trim()}".`
        : 'No skills loaded. Place SKILL.md under .bolo/skills/<id>/ or use bundled creators.',
    }
  }

  const lines = ['Skills (catalog):', '']
  for (const s of list) {
    const inv =
      s.meta.userInvocable === false ? ' [not user-invocable]' : ''
    const desc = s.meta.description ?? '(no description)'
    lines.push(`  /${s.meta.id}  [${s.source}]${inv}`)
    lines.push(`    ${desc}`)
  }
  lines.push('')
  lines.push('Invoke: /<skill-id>  or  /skill <id>')
  return { ok: true, message: lines.join('\n') }
}

function cmdSkill(session: SlashSession, args: string): SlashDispatchResult {
  const id = args.trim()
  if (!id) {
    return {
      ok: false,
      message: 'Usage: /skill <id>  (or /skills to list)',
    }
  }
  return invokeSkillBySlash(session, id)
}

/**
 * 用户 slash 调 skill：注入全文到 messages（不调 LLM）。
 * 尊重 user-invocable: false。
 */
export function invokeSkillBySlash(
  session: SlashSession,
  idOrName: string,
): SlashDispatchResult {
  const skills = sessionSkills(session)
  const found = findSkillById(skills, idOrName)
  if (!found) {
    const ids = skills.map((s) => s.meta.id).join(', ') || '(none)'
    return {
      ok: false,
      message: `Unknown skill "${idOrName}". Known: ${ids}. Try /skills.`,
    }
  }
  if (found.meta.userInvocable === false) {
    return {
      ok: false,
      message: `Skill "${found.meta.id}" is not user-invocable (user-invocable: false).`,
    }
  }
  const body = formatSkillBodyForInjection(found)
  session.messages.push({
    role: 'user',
    content: `[Skill: ${found.meta.id}]\n\n${body}`,
  })
  return {
    ok: true,
    message: `Loaded skill "${found.meta.id}" [${found.source}] into conversation (${body.length} chars). Continue with a prompt or let the agent use these instructions.`,
  }
}

/** 内置注册表（组内顺序即 /help 组内列表顺序） */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'help',
    summary: 'List slash commands (grouped)',
    group: 'diagnostics',
    run: cmdHelp,
  },
  {
    name: 'clear',
    summary: 'Clear conversation messages (keep id/cwd/system)',
    group: 'session',
    run: cmdClear,
  },
  {
    name: 'compact',
    summary: 'Summarize conversation (needs CompactSummarizer)',
    usage: '[note]',
    group: 'session',
    run: cmdCompact,
  },
  {
    name: 'context',
    summary: 'Context stats: msgs, chars, token est, sections, cache tip, usage',
    group: 'session',
    run: cmdContext,
  },
  {
    name: 'cost',
    summary: 'Show session token usage (local only)',
    group: 'session',
    run: cmdCost,
  },
  {
    name: 'usage',
    summary: 'Alias of /cost',
    group: 'session',
    hidden: true,
    run: cmdCost,
  },
  {
    name: 'doctor',
    summary: 'Local diagnostics (node, cwd, mode, tools, usage, ~/.bolo)',
    group: 'diagnostics',
    run: cmdDoctor,
  },
  {
    name: 'status',
    summary: 'Alias of /doctor',
    group: 'diagnostics',
    hidden: true,
    run: cmdDoctor,
  },
  {
    name: 'mcp',
    summary: 'List connected MCP servers, tools, resources, or prompts',
    usage: '[tools|resources|prompts]',
    group: 'extensions',
    run: cmdMcp,
  },
  {
    name: 'plugins',
    summary: 'List loaded local plugins (PL1)',
    group: 'extensions',
    run: cmdPlugins,
  },
  {
    name: 'hooks',
    summary: 'List configured hooks or details for one event',
    usage: '[EventName]',
    group: 'extensions',
    run: cmdHooks,
  },
  {
    name: 'init',
    summary: 'Ensure ~/.bolo and project .bolo layout (scaffold)',
    usage: '[all|user|project]',
    group: 'diagnostics',
    run: cmdInit,
  },
  {
    name: 'model',
    summary: 'Show or set session.model',
    usage: '[name]',
    group: 'model',
    run: cmdModel,
  },
  {
    name: 'effort',
    summary: 'Show or set session effortLevel',
    usage: '[low|medium|high|max|auto]',
    group: 'model',
    run: cmdEffort,
  },
  {
    name: 'plan',
    summary: 'Set permissionMode to plan',
    group: 'model',
    run: cmdPlan,
  },
  {
    name: 'permissions',
    summary: 'Show or set permission mode (four tiers)',
    usage: '[mode]',
    group: 'model',
    run: cmdPermissions,
  },
  {
    name: 'allow',
    summary: 'List or add session always-allow (tool / path:glob / bash:prefix)',
    usage: '[ToolName | path:GLOB | bash:PREFIX]',
    group: 'model',
    run: cmdAllow,
  },
  {
    name: 'rules',
    summary: 'List or show loaded .bolo/rules',
    usage: '[list|show <name>]',
    group: 'extensions',
    run: cmdRules,
  },
  {
    name: 'skills',
    summary: 'List loaded skills (catalog)',
    usage: '[filter]',
    group: 'extensions',
    run: cmdSkills,
  },
  {
    name: 'agents',
    summary: 'List active subagent types; status for background runs',
    usage: '[status]',
    group: 'extensions',
    run: cmdAgents,
  },
  {
    name: 'bg',
    summary: 'List background subagent running/done results',
    group: 'extensions',
    run: (session) => cmdBg(session),
  },
  {
    name: 'skill',
    summary: 'Load a skill body into the conversation by id',
    usage: '<id>',
    group: 'extensions',
    run: cmdSkill,
  },
]

const COMMAND_MAP = new Map(SLASH_COMMANDS.map((c) => [c.name, c]))

export function getSlashCommand(name: string): SlashCommandDef | undefined {
  return COMMAND_MAP.get(name.toLowerCase())
}

export async function dispatchSlashCommand(
  session: SlashSession,
  name: string,
  args: string,
): Promise<SlashDispatchResult> {
  const cmd = getSlashCommand(name)
  if (cmd) {
    return await cmd.run(session, args)
  }

  // 回落：/<skill-id> 或 /skill-creator（user-invocable skill）
  const skills = sessionSkills(session)
  if (skills.length && findSkillById(skills, name)) {
    return invokeSkillBySlash(session, name)
  }

  return {
    ok: false,
    message: formatUnknownCommand(name),
  }
}

/**
 * 用户输入入口：slash → 本地执行；否则 submitPrompt。
 */
export async function submitUserInput(
  session: SlashSession,
  text: string,
  options?: { maxTurns?: number; querySource?: string },
): Promise<SubmitUserInputResult> {
  const parsed = parseSlashLine(text)
  if (parsed.kind === 'empty') return { type: 'empty' }

  if (parsed.kind === 'command') {
    const r = await dispatchSlashCommand(session, parsed.name, parsed.args)
    return { type: 'slash', message: r.message }
  }

  const { submitPrompt } = await import('./index.ts')
  const terminal = await submitPrompt(
    session as Parameters<typeof submitPrompt>[0],
    parsed.text,
    options,
  )
  return { type: 'prompt', terminal }
}