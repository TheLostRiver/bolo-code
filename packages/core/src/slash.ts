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
  addAlwaysDenyBashPrefix,
  addAlwaysDenyPathGlob,
  addAlwaysDenyPrefix,
  addAlwaysDenyToolName,
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
  formatSkillCatalogWithStats,
  formatSkillCatalogStatsLine,
  skillUserInvokeBlockReason,
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
  /**
   * 是否在 CLI 渲染思考链（默认 true）。
   * false 时仍解析 provider 事件，仅不显示。
   */
  showThinking?: boolean
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
    /** 脱敏 endpoint/command 摘要 */
    endpointSummary?: string
    lastError?: string
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
    /** live client 可选；slash 诊断用 isConnected */
    client?: { isConnected?: boolean; transport?: string }
  }>
  /**
   * M-GEN-2：连接失败项 + 配置层 warnings（供 /mcp · /doctor）。
   * 不阻断会话。
   */
  mcpDiagnostics?: {
    configWarnings?: string[]
    failures?: Array<{
      name: string
      transport?: string
      error: string
      endpointSummary?: string
    }>
  }
  /** workspace 插件；/plugins · /doctor */
  plugins?: Array<{
    manifest: { id: string; name?: string; version?: string }
    root?: string
    scope?: string
  }>
  /** 插件 slash 命令（PL2）；dispatch 回落 */
  pluginCommands?: Array<{
    name: string
    id: string
    pluginId: string
    description?: string
    body: string
    path?: string
    scope?: string
  }>
  /** 最近插件 merge 错误；/plugins reload */
  pluginMergeErrors?: string[]
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

/** CP-OBS：section 角色提示（只读展示；不改注入序） */
export function sectionRoleHint(section: string): string {
  const head = section.trim().slice(0, 120).toLowerCase()
  if (
    head.startsWith('# identity') ||
    head.startsWith('# system') ||
    head.startsWith('# task') ||
    head.startsWith('# tools')
  ) {
    return 'cache-stable'
  }
  if (head.includes('auto memory')) return 'memory·volatile'
  if (head.includes('project rules')) return 'rules·volatile'
  if (head.includes('available skills') || head.includes('skill catalog')) {
    return 'skills·volatile'
  }
  if (head.startsWith('# environment')) return 'env·volatile'
  return 'volatile'
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
  extraNames?: string[],
): string[] {
  const needle = name.toLowerCase()
  const candidates = [
    ...SLASH_COMMANDS.filter((c) => !c.hidden).map((c) => c.name),
    ...(extraNames ?? []),
  ]
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

function formatUnknownCommand(
  name: string,
  session?: SlashSession,
): string {
  const tips = [
    `Unknown command /${name}.`,
    'Type /help for grouped list, /skills for skill ids, or /plugins commands.',
  ]
  const extra = (session?.pluginCommands ?? []).map((c) => c.name)
  const suggestions = suggestSlashCommands(name, 3, extra)
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
  lines.push('Aliases: /status → /doctor · /usage → /cost · /reload-plugins → /plugins reload')
  lines.push('Tip: lines starting with // are normal prompts, not commands.')
  lines.push('Skills: /skills · invoke /<skill-id> or /skill <id>')
  lines.push('Plugins: /plugins · /plugins commands · /plugins reload (PL2 hot load)')
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

/**
 * `/title`：查看或设置会话标题（jsonl `title` entry，last-wins；不进模型链）。
 * 无参：读盘 last title；有参：append title。
 */
async function cmdTitle(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const text = args.trim()
  const {
    setSessionTitle,
    getSessionPersistMeta,
    resolveSessionFilePath,
  } = await import('./sessionPersist.ts')
  const {
    loadTranscriptMessages,
    resolveTranscriptPathFromJson,
    getTranscriptWriteState,
  } = await import('./sessionTranscript.ts')

  const meta = getSessionPersistMeta(session)
  const tw = getTranscriptWriteState(session)
  const saveOpts = {
    sessionsDir: meta?.sessionsDir,
    filePath: meta?.filePath ?? tw?.filePath,
    scope: meta?.scope,
  }

  if (!text) {
    try {
      const jsonSide =
        saveOpts.filePath ??
        resolveSessionFilePath(session.id, {
          scope: meta?.scope ?? 'project',
          cwd: session.cwd,
          sessionsDir: meta?.sessionsDir,
        })
      const tp = resolveTranscriptPathFromJson(jsonSide)
      const loaded = await loadTranscriptMessages(tp)
      if (loaded.title) {
        return {
          ok: true,
          message: `Title: ${loaded.title}`,
        }
      }
      return {
        ok: true,
        message:
          'No title set. Usage: /title <text>  (appends a title entry to transcript)',
      }
    } catch {
      return {
        ok: true,
        message:
          'No title set (no transcript yet). Usage: /title <text>',
      }
    }
  }

  try {
    const r = await setSessionTitle(
      session as Parameters<typeof setSessionTitle>[0],
      text,
      saveOpts,
    )
    return {
      ok: true,
      message: `Title set to "${r.title}"`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `title failed: ${msg}` }
  }
}

/**
 * `/note`：追加 system_note（不进模型链；rewrite 保留）。
 * 无参：列出最近若干条；有参：append。
 * 可选前缀 `kind:text`（如 `ptl:retried after truncate`）。
 */
async function cmdNote(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const raw = args.trim()
  const {
    appendSessionSystemNote,
    getSessionPersistMeta,
    resolveSessionFilePath,
  } = await import('./sessionPersist.ts')
  const {
    loadTranscriptFile,
    resolveTranscriptPathFromJson,
    getTranscriptWriteState,
    systemNotesFromTranscriptEntries,
  } = await import('./sessionTranscript.ts')

  const meta = getSessionPersistMeta(session)
  const tw = getTranscriptWriteState(session)
  const saveOpts = {
    sessionsDir: meta?.sessionsDir,
    filePath: meta?.filePath ?? tw?.filePath,
    scope: meta?.scope,
  }

  if (!raw) {
    try {
      const jsonSide =
        saveOpts.filePath ??
        resolveSessionFilePath(session.id, {
          scope: meta?.scope ?? 'project',
          cwd: session.cwd,
          sessionsDir: meta?.sessionsDir,
        })
      const tp = resolveTranscriptPathFromJson(jsonSide)
      const { entries } = await loadTranscriptFile(tp)
      const notes = systemNotesFromTranscriptEntries(entries)
      if (!notes.length) {
        return {
          ok: true,
          message:
            'No system notes. Usage: /note [kind:]text  (appends system_note; not model-visible)',
        }
      }
      const tail = notes.slice(-8)
      const lines = tail.map((n, i) => {
        const k = n.kind ? `[${n.kind}] ` : ''
        return `${notes.length - tail.length + i + 1}. ${k}${n.text}`
      })
      return {
        ok: true,
        message: `System notes (${notes.length}):\n${lines.join('\n')}`,
      }
    } catch {
      return {
        ok: true,
        message:
          'No system notes (no transcript yet). Usage: /note [kind:]text',
      }
    }
  }

  let kind: string | undefined
  let text = raw
  const colon = raw.indexOf(':')
  if (colon > 0 && colon < 32) {
    const maybeKind = raw.slice(0, colon).trim()
    const rest = raw.slice(colon + 1).trim()
    // 仅当 kind 像标签（无空格）且 rest 非空
    if (maybeKind && !/\s/.test(maybeKind) && rest) {
      kind = maybeKind
      text = rest
    }
  }

  try {
    const r = await appendSessionSystemNote(
      session as Parameters<typeof appendSessionSystemNote>[0],
      text,
      { ...saveOpts, kind },
    )
    const k = r.kind ? ` [${r.kind}]` : ''
    return {
      ok: true,
      message: `Note appended${k}: ${r.text}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `note failed: ${msg}` }
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
  // 延迟读 env，避免循环依赖；compact 包为纯函数
  let envDisabled = false
  try {
    // sync require 不可用（ESM）；用已导出的同步路径：从 process 直接判断
    const v1 = process.env.BOLO_DISABLE_AUTO_COMPACT
    const v2 = process.env.BOLO_DISABLE_COMPACT
    const truthy = (v: string | undefined) => {
      if (!v) return false
      const t = v.trim().toLowerCase()
      return t === '1' || t === 'true' || t === 'yes' || t === 'on'
    }
    envDisabled = truthy(v1) || truthy(v2)
  } catch {
    envDisabled = false
  }
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
    `autoCompact:     ${autoOn ? 'on' : 'off'}${autoOn && pressure.aboveAutoThreshold && !envDisabled ? '  (would trigger on next prepare)' : ''}${envDisabled ? '  (env-disabled)' : ''}`,
    `permissionMode:  ${session.permissionMode}`,
    `model:           ${session.model ?? '(unset)'}`,
    `effort:          ${session.effortLevel ?? 'auto'}`,
    `thinking:        ${session.showThinking === false ? 'off' : 'on'}  (/thinking; persist=${session.persistReasoning === true ? 'on' : 'off'})`,
    `system sections: ${sections.length}`,
  ]
  if (sections.length) {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i] ?? ''
      const secTok = estimateSystemSectionsTokens([s])
      const role = sectionRoleHint(s)
      lines.push(
        `  [${i + 1}] ${sectionLabel(s)}  (${s.length} chars, ~${secTok} tok, ${role})`,
      )
    }
  }
  // S-PORT-5：skill catalog 预算可观测
  const skills = session.skills ?? []
  if (skills.length) {
    const { stats } = formatSkillCatalogWithStats(skills, {
      contextWindowTokens: window,
    })
    lines.push(formatSkillCatalogStatsLine(stats))
  } else {
    lines.push('skill catalog:     (no skills loaded)')
  }
  // CP-OBS：memory 预算提示（不读盘大文件；只提示路径与 cap 常量）
  lines.push(
    'memory:          user ~/.bolo/memory + project .bolo/memory · index caps 200 lines / 25k chars · /memory',
  )
  lines.push(
    'cache:           stable system prefix first; providers may send cache_control / prompt_cache_key (see docs/PROMPT_CACHE.md)',
    'prepare order:   snip → microcompact → auto full compact → callModel (PTL truncate is fallback)',
    'toggle:          /autocompact [on|off]',
    formatUsageOneLiner(session.usage),
  )
  return { ok: true, message: lines.join('\n') }
}

/**
 * /autocompact [on|off] — 会话级 auto compact 开关（对照参考 settings.autoCompactEnabled）。
 * 无参：显示当前 on/off + 环境熔断 + 是否有 summarizer。
 * 环境 BOLO_DISABLE_AUTO_COMPACT / BOLO_DISABLE_COMPACT 仍挡 auto；manual /compact 不受影响。
 */
async function cmdAutocompact(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const raw = args.trim().toLowerCase()
  const { isAutoCompactEnvDisabled } = await import('../../compact/src/index.ts')
  const envDisabled = isAutoCompactEnvDisabled()
  const hasSum = typeof session.compactSummarizer === 'function'
  const cur = session.autoCompactEnabled === true

  if (!raw) {
    const lines = [
      `autoCompact:     ${cur ? 'on' : 'off'}`,
      `summarizer:      ${hasSum ? 'yes' : 'no (auto will not run without CompactSummarizer)'}`,
      `env disabled:    ${envDisabled ? 'yes (BOLO_DISABLE_AUTO_COMPACT or BOLO_DISABLE_COMPACT)' : 'no'}`,
      'Usage: /autocompact [on|off]',
      'Note: manual /compact always available when summarizer is present.',
    ]
    return { ok: true, message: lines.join('\n') }
  }

  if (raw !== 'on' && raw !== 'off') {
    return {
      ok: false,
      message: `Invalid autocompact mode "${args.trim()}". Usage: /autocompact [on|off]`,
    }
  }

  const enabled = raw === 'on'
  const { setSessionAutoCompact } = await import('./index.ts')
  const r = setSessionAutoCompact(
    session as Parameters<typeof setSessionAutoCompact>[0],
    enabled,
  )
  const effective =
    r.autoCompactEnabled && hasSum && !r.envDisabled
      ? 'armed (will run when over threshold)'
      : r.autoCompactEnabled && !hasSum
        ? 'session on but no summarizer — auto idle'
        : r.autoCompactEnabled && r.envDisabled
          ? 'session on but env-disabled — auto idle'
          : 'off'
  return {
    ok: true,
    message: [
      `autoCompact: ${r.autoCompactEnabled ? 'on' : 'off'}`,
      `effective:   ${effective}`,
      r.envDisabled
        ? 'env: BOLO_DISABLE_AUTO_COMPACT / BOLO_DISABLE_COMPACT is set (auto blocked).'
        : 'env: no disable flag',
    ].join('\n'),
  }
}

/**
 * 极简本地诊断（对照参考 /doctor · /status）。
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
  const conns = session.mcpConnections ?? []
  const mcpCount = conns.length
  const mcpFail = session.mcpDiagnostics?.failures?.length ?? 0
  const mcpCfgW = session.mcpDiagnostics?.configWarnings?.length ?? 0
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
    `thinking:        ${session.showThinking === false ? 'off' : 'on'}`,
    `messages:        ${session.messages.length}`,
    `system sections: ${session.systemPromptSections.length}`,
    `tools:           ${toolsCount}`,
    `skills:          ${skillsCount}`,
    `agent types:     ${agentTypesCount}`,
    `plugins:         ${pluginsCount}`,
  ]
  lines.push(
    `mcp connections: ${mcpCount}` +
      (mcpFail ? `  failures=${mcpFail}` : '') +
      (mcpCfgW ? `  configWarnings=${mcpCfgW}` : ''),
  )
  if (conns.length) {
    for (const s of conns.slice(0, 8)) {
      const live =
        s.client && typeof s.client.isConnected === 'boolean'
          ? s.client.isConnected
            ? 'live'
            : 'dead'
          : s.status ?? '?'
      lines.push(
        `  · ${s.name}  ${s.transport ?? '?'}  ${live}` +
          `  t=${s.tools?.length ?? 0} r=${s.resources?.length ?? 0} p=${s.prompts?.length ?? 0}`,
      )
    }
    if (conns.length > 8) lines.push(`  · … +${conns.length - 8} more`)
  }
  if (mcpFail) {
    for (const f of (session.mcpDiagnostics?.failures ?? []).slice(0, 5)) {
      const err =
        f.error.length > 80 ? f.error.slice(0, 79) + '…' : f.error
      lines.push(`  ✗ ${f.name}: ${err}`)
    }
  }
  lines.push(
    formatUsageOneLiner(session.usage),
    `autoCompact:     ${autoCompact}`,
    `maxPtlRetries:   ${maxPtl}`,
    `~/.bolo:         ${boloHome} (${boloHomeExists ? 'exists' : 'missing'})`,
    'Tip: /mcp for MCP detail; /memory for long-term memory; /context for tokens; /help for commands.',
  )
  return { ok: true, message: lines.join('\n') }
}

function cmdMcp(session: SlashSession, args: string): SlashDispatchResult {
  const conns = session.mcpConnections ?? []
  const diag = session.mcpDiagnostics
  const failures = diag?.failures ?? []
  const configWarnings = diag?.configWarnings ?? []
  const sub = args.trim().toLowerCase()

  if (!conns.length && !failures.length && !configWarnings.length) {
    return {
      ok: true,
      message:
        'mcp: (none connected)\nConfigure ~/.bolo/mcp.json or .bolo/mcp.json and createSessionFromWorkspace({ connectMcp: true }).\nTip: /mcp status for diagnostics when partially failed.',
    }
  }

  if (sub === 'status' || sub === 'diag' || sub === 'diagnostics') {
    const lines: string[] = ['mcp status:']
    lines.push(
      `  connected: ${conns.length}  failures: ${failures.length}  configWarnings: ${configWarnings.length}`,
    )
    for (const s of conns) {
      const live =
        s.client && typeof s.client.isConnected === 'boolean'
          ? s.client.isConnected
            ? 'live'
            : 'dead'
          : s.status ?? 'connected'
      const n = s.tools?.length ?? 0
      const nr = s.resources?.length ?? 0
      const np = s.prompts?.length ?? 0
      const caps: string[] = []
      if (s.capabilities?.tools || n > 0) caps.push('tools')
      if (s.capabilities?.resources) caps.push('resources')
      if (s.capabilities?.prompts) caps.push('prompts')
      lines.push(
        `  ✓ ${s.name}  transport=${s.transport ?? '?'}  status=${s.status ?? 'connected'}  live=${live}`,
      )
      lines.push(
        `      tools=${n} resources=${nr} prompts=${np}  caps=[${caps.join('+') || '—'}]`,
      )
      if (s.endpointSummary) {
        lines.push(`      ${s.endpointSummary}`)
      }
      if (s.lastError) {
        lines.push(`      lastError: ${s.lastError}`)
      }
    }
    for (const f of failures) {
      lines.push(
        `  ✗ ${f.name}  transport=${f.transport ?? '?'}  FAILED`,
      )
      lines.push(`      error: ${f.error}`)
      if (f.endpointSummary) lines.push(`      ${f.endpointSummary}`)
    }
    if (configWarnings.length) {
      lines.push('  config warnings:')
      for (const w of configWarnings.slice(0, 12)) {
        lines.push(`    · ${w}`)
      }
      if (configWarnings.length > 12) {
        lines.push(`    · … +${configWarnings.length - 12} more`)
      }
    }
    if (!conns.length && !failures.length) {
      lines.push('  (no servers attempted this session)')
    }
    return { ok: true, message: lines.join('\n') }
  }

  if (sub === 'tools' || sub.startsWith('tools ')) {
    if (!conns.length) {
      return {
        ok: true,
        message:
          'mcp tools: (no connected servers)\nUse /mcp status if connections failed.',
      }
    }
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
    if (!conns.length) {
      return {
        ok: true,
        message: 'mcp resources: (no connected servers)',
      }
    }
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
    if (!conns.length) {
      return {
        ok: true,
        message: 'mcp prompts: (no connected servers)',
      }
    }
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

  // default list
  const lines = [
    `mcp servers: connected=${conns.length} failures=${failures.length}`,
  ]
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
    const live =
      s.client && typeof s.client.isConnected === 'boolean'
        ? s.client.isConnected
          ? 'live'
          : 'dead'
        : status
    lines.push(
      `  ✓ ${s.name}  transport=${transport}  status=${status}  live=${live}  tools=${n} resources=${nr} prompts=${np}  [${capStr}]`,
    )
    if (s.endpointSummary) {
      lines.push(`      ${s.endpointSummary}`)
    }
  }
  for (const f of failures) {
    lines.push(`  ✗ ${f.name}  transport=${f.transport ?? '?'}  FAILED`)
    const err = f.error.length > 100 ? f.error.slice(0, 99) + '…' : f.error
    lines.push(`      ${err}`)
  }
  if (configWarnings.length && !failures.length) {
    lines.push(`  configWarnings: ${configWarnings.length} (see /mcp status)`)
  }
  lines.push(
    'Use /mcp status | tools | resources | prompts for details.',
  )
  return { ok: true, message: lines.join('\n') }
}

function cmdPlugins(session: SlashSession, args: string): Promise<SlashDispatchResult> | SlashDispatchResult {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? '').toLowerCase()

  if (sub === 'reload' || sub === 'refresh') {
    return cmdPluginsReload(session)
  }

  if (sub === 'commands' || sub === 'cmds') {
    const cmds = session.pluginCommands ?? []
    if (!cmds.length) {
      return {
        ok: true,
        message:
          'plugin commands: (none)\nAdd commands/*.md under a plugin (or contributes.commands), then /plugins reload.',
      }
    }
    const lines = [`plugin commands (${cmds.length}):`]
    for (const c of cmds) {
      const desc = c.description ? ` — ${c.description}` : ''
      lines.push(`  /${c.name}${desc}  [${c.pluginId}]`)
    }
    lines.push('Invoke: /<plugin-id>:<name>  (body injects into conversation as user message)')
    return { ok: true, message: lines.join('\n') }
  }

  if (sub === 'market' || sub === 'marketplace') {
    return cmdPluginsMarket(session, parts.slice(1))
  }

  if (sub === 'install') {
    return cmdPluginsInstall(session, parts.slice(1))
  }

  if (sub === 'uninstall' || sub === 'remove') {
    return cmdPluginsUninstall(session, parts.slice(1))
  }

  if (sub === 'search') {
    return cmdPluginsSearch(parts.slice(1).join(' '))
  }

  // list（默认）
  const plugins = session.plugins ?? []
  if (!plugins.length) {
    return {
      ok: true,
      message:
        'plugins: (none loaded)\nPlace plugins under ~/.bolo/plugins/<id>/ or .bolo/plugins/<id>/ with bolo.plugin.json.\nMarket: /plugins market add <path|url> · /plugins search · /plugins install <id>@<market>\nUse /plugins reload after adding files mid-session.',
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
  const cmdN = session.pluginCommands?.length ?? 0
  lines.push(`plugin commands: ${cmdN}  (see /plugins commands)`)
  lines.push(
    'Subcommands: list | commands | reload | market | search | install | uninstall',
  )
  return { ok: true, message: lines.join('\n') }
}

async function cmdPluginsMarket(
  session: SlashSession,
  parts: string[],
): Promise<SlashDispatchResult> {
  const {
    registerMarketplace,
    listKnownMarketplaces,
    loadCatalogForKnown,
  } = await import('../../plugins/src/marketplace.ts')
  const action = (parts[0] ?? 'list').toLowerCase()
  try {
    if (action === 'list' || action === '') {
      const known = await listKnownMarketplaces()
      if (!known.length) {
        return {
          ok: true,
          message:
            'marketplaces: (none)\nAdd: /plugins market add <local-path-or-https-url>',
        }
      }
      const lines = [`marketplaces (${known.length}):`]
      for (const k of known) {
        lines.push(`  ${k.name}  ← ${k.source}`)
      }
      lines.push('Search: /plugins search [query]  ·  Install: /plugins install <id>@<market>')
      return { ok: true, message: lines.join('\n') }
    }
    if (action === 'add' || action === 'register') {
      const source = parts.slice(1).join(' ').trim()
      if (!source) {
        return {
          ok: false,
          message: 'Usage: /plugins market add <path-or-url> [name]',
        }
      }
      // optional trailing name if last token has no / or :
      let name: string | undefined
      const tokens = parts.slice(1)
      if (
        tokens.length >= 2 &&
        !tokens[tokens.length - 1]!.includes('/') &&
        !tokens[tokens.length - 1]!.includes(':') &&
        !tokens[tokens.length - 1]!.includes('\\')
      ) {
        name = tokens.pop()
      }
      const src = tokens.join(' ').trim() || source
      const r = await registerMarketplace({ source: src, name })
      return {
        ok: true,
        message: `Registered marketplace "${r.known.name}" (${r.catalog.plugins.length} plugin(s))\nSource: ${r.known.source}\nNext: /plugins search  or  /plugins install <id>@${r.known.name}`,
      }
    }
    if (action === 'show' || action === 'info') {
      const name = parts[1]
      if (!name) {
        return { ok: false, message: 'Usage: /plugins market show <name>' }
      }
      const known = (await listKnownMarketplaces()).find((k) => k.name === name)
      if (!known) {
        return { ok: false, message: `Unknown marketplace: ${name}` }
      }
      const catalog = await loadCatalogForKnown(known)
      const lines = [
        `marketplace: ${known.name}`,
        `source: ${known.source}`,
        `plugins (${catalog.plugins.length}):`,
      ]
      for (const p of catalog.plugins.slice(0, 40)) {
        const ver = p.version ? ` v${p.version}` : ''
        const desc = p.description ? ` — ${p.description}` : ''
        lines.push(`  ${p.id}${ver}${desc}`)
      }
      if (catalog.plugins.length > 40) {
        lines.push(`  … +${catalog.plugins.length - 40} more`)
      }
      return { ok: true, message: lines.join('\n') }
    }
    return {
      ok: false,
      message:
        'Usage: /plugins market list | add <path|url> | show <name>',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `market failed: ${msg}` }
  }
}

async function cmdPluginsSearch(query: string): Promise<SlashDispatchResult> {
  const { searchMarketplacePlugins } = await import(
    '../../plugins/src/marketplace.ts'
  )
  try {
    const hits = await searchMarketplacePlugins({ query: query || undefined })
    if (!hits.length) {
      return {
        ok: true,
        message: query
          ? `No plugins matching "${query}". Register a market first: /plugins market add <path>`
          : 'No plugins in registered markets. /plugins market add <path>',
      }
    }
    const lines = [`search results (${hits.length}):`]
    for (const h of hits.slice(0, 30)) {
      const ver = h.entry.version ? ` v${h.entry.version}` : ''
      const desc = h.entry.description ? ` — ${h.entry.description}` : ''
      lines.push(`  ${h.entry.id}@${h.marketplace}${ver}${desc}`)
    }
    if (hits.length > 30) lines.push(`  … +${hits.length - 30} more`)
    lines.push('Install: /plugins install <id>@<marketplace>  then /plugins reload')
    return { ok: true, message: lines.join('\n') }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `search failed: ${msg}` }
  }
}

async function cmdPluginsInstall(
  session: SlashSession,
  parts: string[],
): Promise<SlashDispatchResult> {
  const {
    installPluginFromMarketplace,
    installPluginFromPath,
  } = await import('../../plugins/src/marketplace.ts')
  const raw = parts[0] ?? ''
  if (!raw) {
    return {
      ok: false,
      message:
        'Usage: /plugins install <id>@<marketplace> | /plugins install path:<dir>  [--project]',
    }
  }
  const scope = parts.includes('--project') ? 'project' : 'user'
  try {
    if (raw.startsWith('path:') || raw.startsWith('file:')) {
      const p = raw.replace(/^(path|file):/i, '')
      const rec = await installPluginFromPath({
        path: p,
        scope,
        cwd: session.cwd,
      })
      return {
        ok: true,
        message: `Installed ${rec.id} → ${rec.installPath}\nRun /plugins reload to activate.`,
      }
    }
    const at = raw.lastIndexOf('@')
    if (at <= 0) {
      return {
        ok: false,
        message:
          'Usage: /plugins install <id>@<marketplace>  or  path:<plugin-dir>',
      }
    }
    const pluginId = raw.slice(0, at)
    const marketplace = raw.slice(at + 1)
    const rec = await installPluginFromMarketplace({
      pluginId,
      marketplace,
      scope,
      cwd: session.cwd,
    })
    return {
      ok: true,
      message: `Installed ${rec.id}@${rec.marketplace} → ${rec.installPath}\nRun /plugins reload to activate.`,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `install failed: ${msg}` }
  }
}

async function cmdPluginsUninstall(
  session: SlashSession,
  parts: string[],
): Promise<SlashDispatchResult> {
  const { uninstallPlugin } = await import('../../plugins/src/marketplace.ts')
  const id = parts[0]
  if (!id) {
    return {
      ok: false,
      message: 'Usage: /plugins uninstall <id> [--project]',
    }
  }
  const scope = parts.includes('--project') ? 'project' : 'user'
  try {
    const r = await uninstallPlugin({
      id,
      scope,
      cwd: session.cwd,
    })
    return {
      ok: true,
      message: `Uninstalled ${id} (${r.removedPath})\nRun /plugins reload to drop from session.`,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `uninstall failed: ${msg}` }
  }
}

async function cmdPluginsReload(session: SlashSession): Promise<SlashDispatchResult> {
  const { reloadSessionPlugins } = await import('./index.ts')
  const r = await reloadSessionPlugins(session as Parameters<typeof reloadSessionPlugins>[0])
  const parts = [
    `${r.pluginCount} plugin(s)`,
    `${r.skillCount} skill(s)`,
    `${r.commandCount} command(s)`,
    `${r.hookEventCount} hook event(s)`,
    `${r.mcpConnectedCount}/${r.mcpServerCount} MCP connected`,
  ]
  const lines = [`Reloaded: ${parts.join(' · ')}`]
  if (r.errors.length) {
    lines.push(`${r.errors.length} merge note(s):`)
    for (const e of r.errors.slice(0, 5)) lines.push(`  - ${e}`)
    if (r.errors.length > 5) lines.push(`  … +${r.errors.length - 5} more`)
  }
  if (r.warnings.length) {
    lines.push(`${r.warnings.length} MCP warning(s):`)
    for (const w of r.warnings.slice(0, 3)) lines.push(`  - ${w}`)
  }
  lines.push('Skill catalog refreshed in system sections; messages history kept.')
  return { ok: true, message: lines.join('\n') }
}

/**
 * 插件命令：把 markdown body 注入为 user 消息（本地 slash，不调 LLM 直到用户再发）。
 * 对照 HC plugin command 注入 prompt 语义的最小版。
 */
function invokePluginCommand(
  session: SlashSession,
  name: string,
): SlashDispatchResult | null {
  const cmds = session.pluginCommands
  if (!cmds?.length) return null
  const n = name.toLowerCase()
  const hit =
    cmds.find((c) => c.name === n) ??
    cmds.find((c) => c.id === n) ??
    cmds.find((c) => c.name.endsWith(':' + n))
  if (!hit) return null
  const header = [
    `[plugin command /${hit.name} from ${hit.pluginId}]`,
    hit.description ? `Description: ${hit.description}` : '',
    '',
  ]
    .filter((x) => x !== undefined)
    .join('\n')
  const content = `${header}${hit.body}`.trim()
  session.messages.push({ role: 'user', content })
  return {
    ok: true,
    message: `Injected plugin command /${hit.name} (${content.length} chars). Continue with a normal prompt or wait for next turn.`,
  }
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

/**
 * /thinking [on|off] — CLI 是否渲染 reasoning。
 * /thinking persist [on|off] — 是否写入 assistant.reasoning_content（openai-compatible 回灌；默认 off）。
 */
function cmdThinking(session: SlashSession, args: string): SlashDispatchResult {
  const raw = args.trim().toLowerCase()
  if (!raw) {
    const on = session.showThinking !== false
    const persist = session.persistReasoning === true
    return {
      ok: true,
      message: `thinking display: ${on ? 'on' : 'off'}; persist: ${persist ? 'on' : 'off'} (persist=openai-compatible reasoning_content only)`,
    }
  }
  const parts = raw.split(/\s+/)
  if (parts[0] === 'persist') {
    const v = parts[1] ?? ''
    if (!v || v === 'status') {
      return {
        ok: true,
        message: `thinking persist: ${session.persistReasoning === true ? 'on' : 'off'} (default off)`,
      }
    }
    if (v === 'on' || v === 'true' || v === '1' || v === 'yes') {
      session.persistReasoning = true
      return {
        ok: true,
        message:
          'thinking persist: on (assistant.reasoning_content for openai-compatible; not for Anthropic signed blocks)',
      }
    }
    if (v === 'off' || v === 'false' || v === '0' || v === 'no') {
      session.persistReasoning = false
      return { ok: true, message: 'thinking persist: off' }
    }
    return {
      ok: false,
      message: `Invalid. Usage: /thinking persist [on|off]`,
    }
  }
  if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes') {
    session.showThinking = true
    return { ok: true, message: 'thinking display: on' }
  }
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') {
    session.showThinking = false
    return {
      ok: true,
      message: 'thinking display: off (events still parsed, not rendered)',
    }
  }
  return {
    ok: false,
    message: `Invalid thinking mode "${args.trim()}". Usage: /thinking [on|off] | /thinking persist [on|off]`,
  }
}

function cmdPlan(session: SlashSession, _args: string): SlashDispatchResult {
  session.permissionMode = 'plan'
  return { ok: true, message: 'permissionMode set to plan' }
}

async function cmdPermissions(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const raw = args.trim()
  if (!raw) {
    const list = PERMISSION_MODES.map((m) => {
      const meta = PERMISSION_MODE_META[m]
      const mark = m === session.permissionMode ? ' *' : ''
      return `  ${m}${mark} — ${meta.userLabel}`
    }).join('\n')
    const auto = session as {
      autoModeState?: { lastReason?: string; circuitBroken?: boolean }
    }
    let autoLine = ''
    if (session.permissionMode === 'auto' && auto.autoModeState) {
      autoLine =
        `\nauto: circuit=${auto.autoModeState.circuitBroken ? 'open' : 'ok'}` +
        (auto.autoModeState.lastReason
          ? ` last=${auto.autoModeState.lastReason}`
          : '')
    }
    return {
      ok: true,
      message: `permissionMode: ${session.permissionMode}\nmodes:\n${list}${autoLine}`,
    }
  }
  if (!isPermissionMode(raw)) {
    return {
      ok: false,
      message: `Invalid mode "${raw}". Usage: /permissions [${PERMISSION_MODES.join('|')}]`,
    }
  }
  // 走 setPermissionMode 逻辑（strip + auto state）
  const { setPermissionMode } = await import('./index.ts')
  setPermissionMode(
    session as Parameters<typeof setPermissionMode>[0],
    raw as PermissionMode,
  )
  let extra = ''
  if (raw === 'auto') {
    const st = (session as { autoModeState?: { lastReason?: string } })
      .autoModeState
    extra = st?.lastReason ? ` (${st.lastReason})` : ''
    extra +=
      ' — classifier will approve/deny non-allowlisted tools; expect extra model cost; failures deny.'
  }
  return { ok: true, message: `permissionMode set to ${raw}${extra}` }
}

function ensurePermissionRules(session: SlashSession): SessionPermissionRules {
  if (!session.permissionRules) {
    session.permissionRules = createEmptyPermissionRules()
  }
  return session.permissionRules
}

/**
 * /allow [ToolName | path:glob | bash:pattern] — 会话 always-allow
 * - 无参：列出当前规则
 * - ToolName：精确工具名
 * - path:GLOB：路径 glob（相对 cwd）
 * - bash:PATTERN：Bash 模式（前缀 / 通配 * / 遗留 :*）
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
          '  /allow bash:git *\n' +
          'Tip: at permission prompt, answer a = allow always this tool name this session.',
      }
    }
    const lines = ['Session always-allow:']
    if (names.length) lines.push(`  tools: ${names.join(', ')}`)
    if (prefixes.length) lines.push(`  tool-prefixes: ${prefixes.join(', ')}`)
    if (pathGlobs.length) lines.push(`  paths: ${pathGlobs.join(', ')}`)
    if (bashPrefs.length) lines.push(`  bash: ${bashPrefs.join(', ')}`)
    lines.push(
      'Add: /allow ToolName | /allow path:GLOB | /allow bash:PATTERN',
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
        message:
          'Usage: /allow bash:git  or  /allow bash:git *  (prefix / wildcard / foo:*)',
      }
    }
    addAlwaysAllowBashPrefix(rules, pref)
    return {
      ok: true,
      message: `always-allow bash pattern: ${pref}\ncurrent bash: ${(rules.alwaysAllowBashPrefixes ?? []).join(', ')}`,
    }
  }

  addAlwaysAllowToolName(rules, raw)
  return {
    ok: true,
    message: `always-allow added for this session: ${raw}\ncurrent tools: ${rules.alwaysAllowToolNames.join(', ')}`,
  }
}

/**
 * /deny [ToolName | path:glob | bash:pattern | prefix:pfx] — 会话 always-deny（硬规则）
 * 优先于 bypass / always-allow；可经快照 / JSONL meta 持久化。
 */
function cmdDeny(session: SlashSession, args: string): SlashDispatchResult {
  const rules = ensurePermissionRules(session)
  const raw = args.trim()
  if (!raw) {
    const names = rules.alwaysDenyToolNames ?? []
    const prefixes = rules.alwaysDenyPrefixes ?? []
    const pathGlobs = rules.alwaysDenyPathGlobs ?? []
    const bashPrefs = rules.alwaysDenyBashPrefixes ?? []
    if (
      !names.length &&
      !prefixes.length &&
      !pathGlobs.length &&
      !bashPrefs.length
    ) {
      return {
        ok: true,
        message:
          'Session always-deny: (empty)\n' +
          'Usage:\n' +
          '  /deny ToolName\n' +
          '  /deny path:secrets' +
          '/**\n' +
          '  /deny bash:rm\n' +
          '  /deny bash:rm *\n' +
          '  /deny prefix:mcp__untrusted\n' +
          'Hard deny wins over bypass and always-allow.',
      }
    }
    const lines = ['Session always-deny:']
    if (names.length) lines.push(`  tools: ${names.join(', ')}`)
    if (prefixes.length) lines.push(`  tool-prefixes: ${prefixes.join(', ')}`)
    if (pathGlobs.length) lines.push(`  paths: ${pathGlobs.join(', ')}`)
    if (bashPrefs.length) lines.push(`  bash: ${bashPrefs.join(', ')}`)
    lines.push(
      'Add: /deny ToolName | /deny path:GLOB | /deny bash:PATTERN | /deny prefix:PFX',
    )
    return { ok: true, message: lines.join('\n') }
  }

  const lower = raw.toLowerCase()
  if (lower.startsWith('path:')) {
    const glob = raw.slice(5).trim()
    if (!glob) {
      return {
        ok: false,
        message: 'Usage: /deny path:<glob>  (path glob relative to cwd)',
      }
    }
    addAlwaysDenyPathGlob(rules, glob)
    return {
      ok: true,
      message: `always-deny path glob: ${glob}\ncurrent deny paths: ${(rules.alwaysDenyPathGlobs ?? []).join(', ')}`,
    }
  }
  if (lower.startsWith('bash:')) {
    const pref = raw.slice(5).trim()
    if (!pref) {
      return {
        ok: false,
        message:
          'Usage: /deny bash:rm  or  /deny bash:rm *  (prefix / wildcard / foo:*)',
      }
    }
    addAlwaysDenyBashPrefix(rules, pref)
    return {
      ok: true,
      message: `always-deny bash pattern: ${pref}\ncurrent deny bash: ${(rules.alwaysDenyBashPrefixes ?? []).join(', ')}`,
    }
  }
  if (lower.startsWith('prefix:')) {
    const pfx = raw.slice(7).trim()
    if (!pfx) {
      return {
        ok: false,
        message: 'Usage: /deny prefix:mcp__untrusted  (tool name prefix)',
      }
    }
    addAlwaysDenyPrefix(rules, pfx)
    return {
      ok: true,
      message: `always-deny tool prefix: ${pfx}\ncurrent deny prefixes: ${(rules.alwaysDenyPrefixes ?? []).join(', ')}`,
    }
  }

  addAlwaysDenyToolName(rules, raw)
  return {
    ok: true,
    message: `always-deny added for this session: ${raw}\ncurrent deny tools: ${(rules.alwaysDenyToolNames ?? []).join(', ')}`,
  }
}

/**
 * 跨会话 MEMORY.md 状态（对照 HC memdir 可见性）。
 * 不改会话消息；只读路径 + 预览 / topics。
 */
async function cmdMemory(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const {
    loadMemoryEntrypoint,
    loadProjectMemoryEntrypoint,
    formatMemoryStatus,
    formatMemoryTopicsList,
    isMemoryDisabled,
    getMemoryDir,
    getMemoryEntrypoint,
    getProjectMemoryDir,
    getProjectMemoryEntrypoint,
    scanMemoryTopics,
  } = await import('./memory.ts')

  const sub = args.trim().toLowerCase()
  if (sub === 'path') {
    return {
      ok: true,
      message: [
        `user dir:        ${getMemoryDir()}`,
        `user entry:      ${getMemoryEntrypoint()}`,
        `project dir:     ${getProjectMemoryDir({ cwd: session.cwd })}`,
        `project entry:   ${getProjectMemoryEntrypoint({ cwd: session.cwd })}`,
      ].join('\n'),
    }
  }
  if (sub === 'topics') {
    const userDir = getMemoryDir()
    const projectDir = getProjectMemoryDir({ cwd: session.cwd })
    const topics = [
      ...(await scanMemoryTopics(userDir, { scope: 'user' })),
      ...(await scanMemoryTopics(projectDir, { scope: 'project' })),
    ]
    return {
      ok: true,
      message: [
        `user dir:    ${userDir}`,
        `project dir: ${projectDir}`,
        formatMemoryTopicsList(topics),
      ].join('\n'),
    }
  }
  if (sub && sub !== 'status' && sub !== 'show') {
    return {
      ok: false,
      message: 'Usage: /memory [path|status|topics]',
    }
  }

  const loaded = await loadMemoryEntrypoint({ scope: 'user' })
  const project = await loadProjectMemoryEntrypoint({ cwd: session.cwd })
  const topics = [
    ...(await scanMemoryTopics(loaded.dir, { scope: 'user' })),
    ...(await scanMemoryTopics(project.dir, { scope: 'project' })),
  ]
  return {
    ok: true,
    message: formatMemoryStatus(loaded, {
      disabled: isMemoryDisabled(),
      project,
      topics,
    }),
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

  const window =
    typeof session.contextWindowTokens === 'number' &&
    session.contextWindowTokens > 0
      ? session.contextWindowTokens
      : 128_000
  // 统计用全表；列表可按 filter 缩小显示
  const { stats } = formatSkillCatalogWithStats(skills, {
    contextWindowTokens: window,
  })

  const lines = ['Skills (catalog):', '']
  for (const s of list) {
    const flags: string[] = []
    if (s.meta.disableModelInvocation === true) {
      flags.push('no-model')
    }
    if (s.meta.userInvocable === false) {
      flags.push('no-user')
    }
    const flagStr = flags.length ? ` [${flags.join(',')}]` : ''
    const desc = s.meta.description ?? '(no description)'
    const when = s.meta.whenToUse ? ` · when: ${s.meta.whenToUse}` : ''
    lines.push(`  /${s.meta.id}  [${s.source}]${flagStr}`)
    lines.push(`    ${desc}${when}`)
  }
  lines.push('')
  lines.push(formatSkillCatalogStatsLine(stats))
  lines.push(
    'Flags: no-model = disable-model-invocation; no-user = user-invocable:false',
  )
  lines.push(
    `Source precedence (later wins): ${['bundled', 'extra', 'user', 'project', 'plugin'].join(' → ')}`,
  )
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
      message:
        skillUserInvokeBlockReason(found) ??
        `Skill "${found.meta.id}" is not user-invocable (user-invocable: false).`,
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
    name: 'title',
    summary: 'Show or set session title (jsonl title entry; not model-visible)',
    usage: '[text]',
    group: 'session',
    run: cmdTitle,
  },
  {
    name: 'note',
    summary:
      'List or append system_note (jsonl; not model-visible; rewrite keeps notes)',
    usage: '[[kind:]text]',
    group: 'session',
    run: cmdNote,
  },
  {
    name: 'compact',
    summary: 'Summarize conversation (needs CompactSummarizer)',
    usage: '[note]',
    group: 'session',
    run: cmdCompact,
  },
  {
    name: 'autocompact',
    summary: 'Show or set session auto compact (on/off)',
    usage: '[on|off]',
    group: 'session',
    run: cmdAutocompact,
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
    name: 'memory',
    summary: 'Long-term MEMORY.md path, status, topics, preview',
    usage: '[path|status|topics]',
    group: 'session',
    run: cmdMemory,
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
    summary: 'List MCP servers, status/diagnostics, tools, resources, prompts',
    usage: '[status|tools|resources|prompts]',
    group: 'extensions',
    run: cmdMcp,
  },
  {
    name: 'plugins',
    summary:
      'Plugins + minimal marketplace (list/reload/market/search/install)',
    usage:
      '[list|commands|reload|market|search|install|uninstall]',
    group: 'extensions',
    run: cmdPlugins,
  },
  {
    name: 'reload-plugins',
    summary: 'Alias of /plugins reload',
    group: 'extensions',
    hidden: true,
    run: (session) => cmdPluginsReload(session),
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
    name: 'thinking',
    summary:
      'Show/hide thinking display; /thinking persist on|off for openai-compatible refeed',
    usage: '[on|off] | persist [on|off]',
    group: 'model',
    run: cmdThinking,
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
    summary: 'List or add session always-allow (tool / path:glob / bash:pattern)',
    usage: '[ToolName | path:GLOB | bash:PATTERN]',
    group: 'model',
    run: cmdAllow,
  },
  {
    name: 'deny',
    summary:
      'List or add session always-deny (hard; wins over bypass / allow)',
    usage: '[ToolName | path:GLOB | bash:PATTERN | prefix:PFX]',
    group: 'model',
    run: cmdDeny,
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

  // 回落：插件 contributes.commands（PL2）
  const pluginHit = invokePluginCommand(session, name)
  if (pluginHit) return pluginHit

  // 回落：/<skill-id> 或 /skill-creator（user-invocable skill）
  const skills = sessionSkills(session)
  if (skills.length && findSkillById(skills, name)) {
    return invokeSkillBySlash(session, name)
  }

  return {
    ok: false,
    message: formatUnknownCommand(name, session),
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