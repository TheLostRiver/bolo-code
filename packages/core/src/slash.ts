/**
 * 斜杠命令总线（最小）
 * 对照 HC：行首 `/` 为命令；`//` 不当命令；不调 LLM。
 * 无遥测。不依赖 core/index 顶层导入（避免循环）。
 */

import {
  addAlwaysAllowToolName,
  createEmptyPermissionRules,
  isPermissionMode,
  PERMISSION_MODES,
  PERMISSION_MODE_META,
  type PermissionMode,
  type SessionPermissionRules,
} from '../../permissions/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { CompactSummarizer } from '../../compact/src/index.ts'
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
  /** 活跃 subagent 定义；供 /agents */
  agentDefinitions?: import('./subagent.ts').ActiveAgentDefinitions
  /** 后台 subagent 表；/agents status · /bg */
  backgroundAgents?: import('./subagent.ts').BackgroundAgentStore
  /** 本地 usage 累计；/cost · /context */
  usage?: SessionUsage
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

export type SlashCommandDef = {
  name: string
  summary: string
  usage?: string
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

function formatHelp(): string {
  const lines = ['Slash commands:', '']
  for (const c of SLASH_COMMANDS) {
    const usage = c.usage ? ` ${c.usage}` : ''
    lines.push(`  /${c.name}${usage}`)
    lines.push(`    ${c.summary}`)
  }
  lines.push('')
  lines.push('Tip: lines starting with // are normal prompts, not commands.')
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
  return {
    ok: true,
    message: note
      ? `Compacted conversation (note: ${note}).`
      : 'Compacted conversation.',
  }
}

function cmdContext(session: SlashSession, _args: string): SlashDispatchResult {
  const lines = [
    `id:              ${session.id}`,
    `cwd:             ${session.cwd}`,
    `messages:        ${session.messages.length}`,
    `chars (approx):  ${approxChars(session)}`,
    `permissionMode:  ${session.permissionMode}`,
    `model:           ${session.model ?? '(unset)'}`,
    `effort:          ${session.effortLevel ?? 'auto'}`,
    `system sections: ${session.systemPromptSections.length}`,
    formatUsageOneLiner(session.usage),
  ]
  return { ok: true, message: lines.join('\n') }
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
      message: `unknown effort "${args.trim()}". Use: ${EFFORT_LEVELS.join('|')}`,
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
      message: `unknown mode "${raw}". Use: ${PERMISSION_MODES.join('|')}`,
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
 * /allow [ToolName] — 列出会话 always-allow，或添加工具名
 */
function cmdAllow(session: SlashSession, args: string): SlashDispatchResult {
  const rules = ensurePermissionRules(session)
  const name = args.trim()
  if (!name) {
    const names = rules.alwaysAllowToolNames
    const prefixes = rules.alwaysAllowPrefixes ?? []
    if (!names.length && !prefixes.length) {
      return {
        ok: true,
        message:
          'Session always-allow: (empty)\nUsage: /allow ToolName\nTip: at permission prompt, answer a = allow always this session.',
      }
    }
    const lines = ['Session always-allow:']
    if (names.length) {
      lines.push(`  tools: ${names.join(', ')}`)
    }
    if (prefixes.length) {
      lines.push(`  prefixes: ${prefixes.join(', ')}`)
    }
    lines.push('Add: /allow ToolName')
    return { ok: true, message: lines.join('\n') }
  }
  addAlwaysAllowToolName(rules, name)
  return {
    ok: true,
    message: `always-allow added for this session: ${name}\ncurrent: ${rules.alwaysAllowToolNames.join(', ')}`,
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

/** 内置注册表（顺序即 /help 列表顺序） */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'help',
    summary: 'List slash commands',
    run: cmdHelp,
  },
  {
    name: 'clear',
    summary: 'Clear conversation messages (keep id/cwd/system)',
    run: cmdClear,
  },
  {
    name: 'compact',
    summary: 'Summarize conversation (needs CompactSummarizer)',
    usage: '[note]',
    run: cmdCompact,
  },
  {
    name: 'context',
    summary: 'Show message count, chars, mode, model, cwd, id, usage',
    run: cmdContext,
  },
  {
    name: 'cost',
    summary: 'Show session token usage (local only)',
    run: cmdCost,
  },
  {
    name: 'usage',
    summary: 'Alias of /cost',
    run: cmdCost,
  },
  {
    name: 'model',
    summary: 'Show or set session.model',
    usage: '[name]',
    run: cmdModel,
  },
  {
    name: 'effort',
    summary: 'Show or set session effortLevel',
    usage: '[low|medium|high|max|auto]',
    run: cmdEffort,
  },
  {
    name: 'plan',
    summary: 'Set permissionMode to plan',
    run: cmdPlan,
  },
  {
    name: 'permissions',
    summary: 'Show or set permission mode (four tiers)',
    usage: '[mode]',
    run: cmdPermissions,
  },
  {
    name: 'allow',
    summary: 'List or add session always-allow tool names',
    usage: '[ToolName]',
    run: cmdAllow,
  },
  {
    name: 'rules',
    summary: 'List or show loaded .bolo/rules',
    usage: '[list|show <name>]',
    run: cmdRules,
  },
  {
    name: 'skills',
    summary: 'List loaded skills (catalog)',
    usage: '[filter]',
    run: cmdSkills,
  },
  {
    name: 'agents',
    summary: 'List active subagent types; status for background runs',
    usage: '[status]',
    run: cmdAgents,
  },
  {
    name: 'bg',
    summary: 'List background subagent running/done results',
    run: (session) => cmdBg(session),
  },
  {
    name: 'skill',
    summary: 'Load a skill body into the conversation by id',
    usage: '<id>',
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
    message: `Unknown command /${name}. Type /help for list, or /skills for skill ids.`,
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