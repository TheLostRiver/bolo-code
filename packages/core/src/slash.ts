/**
 * 斜杠命令总线（最小）
 * 对照 HC：行首 `/` 为命令；`//` 不当命令；不调 LLM。
 * 无遥测。不依赖 core/index 顶层导入（避免循环）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getBoloHomeDir } from '../../config/src/paths.ts'
import {
  detectWebSearchDialectId,
  resolveWebSearchPlan,
} from '../../providers/src/index.ts'
import {
  ensureAllLayouts,
  ensureProjectLayout,
} from '../../config/src/ensure.ts'
import {
  formatModelMetadataLines,
  type ModelMetadataView,
} from '../../config/src/modelMetadataView.ts'
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
import {
  HOOK_EVENTS,
  RUNTIME_PROTOCOL_VERSION,
  isRuntimeQueryEntity,
  queryRuntimeSnapshot,
  formatBackgroundShellStatusLine,
  listBackgroundShells,
  type ChatMessage,
  type HooksConfig,
  type HookEvent,
  type RuntimeCommand,
  type RuntimeCommandResult,
  TUI_THEME_IDS,
  isTuiThemeId,
  tuiThemeLabel,
  type TuiThemeId,
} from '../../shared/src/index.ts'
import {
  estimateSystemSectionsTokens,
  estimateTokens,
  getContextPressure,
  isAutoCompactEnvDisabled,
  resolveAutoCompactTokenCount,
  type CompactSummarizer,
} from '../../compact/src/index.ts'
import {
  findSkillById,
  formatSkillBodyForInjection,
  formatSkillCatalogWithStats,
  formatSkillCatalogStatsLine,
  isSkillUserInvocable,
  skillUserInvokeBlockReason,
  type LoadedSkill,
  type SkillCatalogStats,
} from '../../skills/src/index.ts'
import type { Terminal } from './queryLoop.ts'
import {
  formatSessionUsage,
  formatUsageOneLiner,
  type SessionUsage,
} from './sessionUsage.ts'
import { formatPromptCacheSessionLine } from '../../compact/src/index.ts'
import { formatDurationMs } from './modelCost.ts'
import { formatDiffSlash } from './fileDiffLog.ts'
import { renderRuntimeText } from './runtimeTextView.ts'
import {
  switchSessionProvider,
  switchSessionModel,
  formatSessionProvidersSlash,
  listSessionProviders,
  buildProviderPickerItems,
  activeProviderPickerIndex,
  getSessionModelMetadataView,
  type SwitchableProviderSession,
} from './sessionProvider.ts'
import { clampEffortForSession } from './effortClamp.ts'
import {
  formatUltrathinkStatus,
  normalizeUltrathinkMode,
  resolveUltrathinkMode,
  type UltrathinkMode,
} from './ultrathink.ts'
import { suggestModelsForSession } from './sessionModelEffortSettings.ts'
import {
  formatEffortStatusLine,
  formatEffortCapabilityStatus,
  assertEffortChoosable,
  buildEffortPickerItems,
  activeEffortPickerIndex,
  detectEffortDialectId,
  listEffortChoosable,
} from '../../providers/src/effortDialect.ts'
import {
  cancelSessionControl,
  requestSessionControl,
  type SessionControlRuntimeSession,
} from './sessionControlRuntime.ts'
import {
  executeRuntimeCommand,
  type RuntimeCommandSession,
} from './runtimeCommand.ts'

/** slash 需要的会话切片（与 BoloSession 兼容） */
export type SlashSession = {
  id: string
  cwd: string
  phase?: import('../../shared/src/index.ts').SessionPhase
  messages: ChatMessage[]
  systemPromptSections: string[]
  permissionMode: PermissionMode
  /** DR2：/turn 只消费 core coordinator，不在 CLI 维护第二套状态。 */
  coordinator?: import('./sessionCoordinator.ts').SessionCoordinator
  /** 会话 Always-allow；/allow 读写 */
  permissionRules?: SessionPermissionRules
  model?: string
  effortLevel?: string
  /** Web search 意图（on|off|auto）；/websearch 读写 */
  webSearch?: import('../../providers/src/index.ts').WebSearchIntent
  /**
   * CX8 ultrathink 会话覆盖（off|tip|turn）；默认 off。
   */
  ultrathinkMode?: UltrathinkMode
  /**
   * 是否在 CLI 渲染思考链（默认 true）。
   * false 时仍解析 provider 事件，仅不显示。
   */
  showThinking?: boolean
  /** 是否把 reasoning_content 写入 assistant history */
  persistReasoning?: boolean
  compactSummarizer?: CompactSummarizer
  /** HKP-3：plan 正交开关（/plan 激活，ExitPlanMode 关闭） */
  planMode?: boolean
  /** ROB-3：后台 shell store（/bg 展示；Bash run_in_background 写入） */
  backgroundShells?: import('../../shared/src/index.ts').BackgroundShellStore
  /** 会话 skill 全文表；供 /skills 与 /<skill-id> 回落 */
  skills?: LoadedSkill[]
  /** 活跃 subagent 定义；供 /agents · /doctor */
  agentDefinitions?: import('./subagent.ts').ActiveAgentDefinitions
  /** Subagent 全局策略；/agents · /doctor */
  agentPolicy?: import('./subagent.ts').AgentPolicy
  /** 后台 subagent 表；/agents status · /bg */
  backgroundAgents?: import('./subagent.ts').BackgroundAgentStore
  /** DR4 runtime protocol projection inputs. */
  durableTurns?: import('./durableTurn.ts').DurableTurnRecord[]
  durableControls?: import('./durableControl.ts').DurableControlRecord[]
  durableTasks?: import('./durableTask.ts').DurableTaskRecord[]
  durableResolutions?: import('./durableResolution.ts').DurableResolutionRecord[]
  /** 本地 usage 累计；/cost · /context · /doctor */
  usage?: SessionUsage
  /** 本地 prompt-cache 观测；/cost */
  promptCacheState?: import('../../compact/src/index.ts').PromptCacheSessionState
  /** 会话墙钟起点 ms；/cost wall duration */
  sessionStartedAtMs?: number
  /** 文件改动 log；/diff */
  fileDiffLog?: import('./fileDiffLog.ts').FileChangeRecord[]
  /** 当前用户 turn；/diff last */
  diffTurn?: number
  /** 会话工具表；/doctor 计数 */
  tools?: { name: string }[]
  /** 协议 kind（LlmProvider.id）；/doctor */
  provider?: { id?: string }
  /**
   * P 轨：命名 profile id（config.providers 的 key）。
   * 与 provider.id（协议 kind）不同。
   */
  providerId?: string
  providerRegistry?: import('../../config/src/providerRegistry.ts').ProviderRegistry
  providerProfile?: import('../../config/src/providerRegistry.ts').ProviderProfile
  /** E 轨：当前后端 effort 方言 id 或内联（供 /effort 预览） */
  effortDialect?: string | Record<string, unknown>
  /** auto compact 开关；/doctor · /context */
  autoCompactEnabled?: boolean
  /** 上下文窗口（token 粗估基准）；/context 压力 */
  contextWindowTokens?: number
  /** CTX-2：active provider/model 的统一 runtime 元数据 */
  resolvedModel?: import('../../config/src/modelMetadata.ts').ResolvedModelMetadata
  /** C5：最近 compact 摘要；/context */
  lastCompact?: {
    at: string
    trigger: 'manual' | 'auto'
    summaryChars: number
    messagesAfter: number
  }
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

export type ContextUsageSource = 'actual' | 'estimated' | 'hybrid'

export type ContextUsageCategory = {
  id: 'messages' | 'system' | 'free'
  label: string
  tokens: number
  source: 'estimated' | 'derived'
}

export type ContextUsageSection = {
  index: number
  label: string
  chars: number
  tokens: number
  role: string
}

export type ContextUsageViewModel = {
  modelMetadata: ModelMetadataView
  session: {
    id: string
    cwd: string
    messageCount: number
    chars: number
    permissionMode: PermissionMode
    model?: string
    effort: string
    thinking: boolean
    persistReasoning: boolean
  }
  estimate: {
    messagesTokens: number
    systemTokens: number
    totalTokens: number
  }
  usage: {
    tokenCount: number
    windowTokens: number
    effectiveWindowTokens: number
    autoThresholdTokens: number
    freeTokens: number
    percentOfWindow: number
    percentOfThreshold: number
    level: 'ok' | 'warn' | 'critical' | 'over'
    source: ContextUsageSource
    resolutionSource: 'usage' | 'estimate' | 'hybrid'
    inputUsageTokens?: number
    anchorInputTokens?: number
    tailEstimatedTokens?: number
  }
  categories: ContextUsageCategory[]
  sections: ContextUsageSection[]
  skills: SkillCatalogStats
  autoCompact: {
    enabled: boolean
    envDisabled: boolean
    aboveThreshold: boolean
  }
  lastCompact?: {
    at: string
    trigger: 'manual' | 'auto'
    summaryChars: number
    messagesAfter: number
  }
  usageLine: string
  promptCacheLine?: string
}

export type SlashDisplayTone = 'info' | 'success' | 'warning' | 'error'

export type SlashOverlayItem = {
  readonly id: string
  readonly label: string
}

export type SlashOverlayViewModel =
  | {
      readonly kind: 'picker'
      readonly title: string
      readonly items: readonly SlashOverlayItem[]
      readonly emptyMessage?: string
    }
  | {
      readonly kind: 'action-picker'
      readonly action: 'provider' | 'effort' | 'theme'
      readonly title: string
      readonly items: readonly SlashOverlayItem[]
      readonly initialIndex?: number
    }
  | {
      readonly kind: 'diff'
      readonly mode: 'session' | 'last'
      readonly pathFilter?: string
    }

export type SlashDisplayPolicy =
  | {
      readonly surface: 'history'
      readonly tone: SlashDisplayTone
      /** Slash history is visible UI state, never model/session persistence. */
      readonly persistence: 'visual-only'
    }
  | {
      readonly surface: 'panel'
      readonly key: string
      readonly placement: 'below-composer'
      readonly dismissOnInput: boolean
      readonly dismissOnEscape: boolean
      readonly ttlMs?: number
      readonly overflow: 'compact' | 'pager'
    }
  | {
      readonly surface: 'toast'
      readonly key: string
      readonly tone: SlashDisplayTone
      readonly ttlMs: number
    }
  | {
      readonly surface: 'overlay'
      readonly key: string
      readonly view: 'picker' | 'pager' | 'diff'
    }

const SLASH_DISPLAY_TONES = new Set<SlashDisplayTone>([
  'info',
  'success',
  'warning',
  'error',
])
const SLASH_DISPLAY_KEY_RE = /^[a-z0-9][a-z0-9:._/-]*$/iu
const MAX_SLASH_DISPLAY_TTL_MS = 24 * 60 * 60 * 1000

function isSlashDisplayRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSlashDisplayTone(value: unknown): value is SlashDisplayTone {
  return (
    typeof value === 'string' &&
    SLASH_DISPLAY_TONES.has(value as SlashDisplayTone)
  )
}

function isSlashDisplayKey(value: unknown): value is string {
  return typeof value === 'string' && SLASH_DISPLAY_KEY_RE.test(value)
}

function isSlashDisplayTtl(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_SLASH_DISPLAY_TTL_MS
  )
}

export function isSlashDisplayPolicy(
  value: unknown,
): value is SlashDisplayPolicy {
  if (!isSlashDisplayRecord(value)) return false
  switch (value.surface) {
    case 'history':
      return (
        isSlashDisplayTone(value.tone) &&
        value.persistence === 'visual-only'
      )
    case 'panel':
      return (
        isSlashDisplayKey(value.key) &&
        value.placement === 'below-composer' &&
        typeof value.dismissOnInput === 'boolean' &&
        typeof value.dismissOnEscape === 'boolean' &&
        (value.ttlMs === undefined || isSlashDisplayTtl(value.ttlMs)) &&
        (value.overflow === 'compact' || value.overflow === 'pager')
      )
    case 'toast':
      return (
        isSlashDisplayKey(value.key) &&
        isSlashDisplayTone(value.tone) &&
        isSlashDisplayTtl(value.ttlMs)
      )
    case 'overlay':
      return (
        isSlashDisplayKey(value.key) &&
        (value.view === 'picker' ||
          value.view === 'pager' ||
          value.view === 'diff')
      )
    default:
      return false
  }
}

export function normalizeSlashDisplayPolicy(
  value: unknown,
  fallbackTone: SlashDisplayTone = 'info',
): SlashDisplayPolicy {
  if (isSlashDisplayPolicy(value)) return value
  return {
    surface: 'history',
    tone: isSlashDisplayTone(fallbackTone) ? fallbackTone : 'info',
    persistence: 'visual-only',
  }
}

export type SlashDispatchResult = {
  message: string
  ok: boolean
  /** Renderer-neutral display intent; dispatch fills this when handlers omit it. */
  display?: SlashDisplayPolicy
  /** Structured overlay content; terminal renderers must not parse message text. */
  overlayView?: SlashOverlayViewModel
  /** `/context` overview data; terminal renderers must not parse message text. */
  contextView?: ContextUsageViewModel
}

export type ResolvedSlashDispatchResult = SlashDispatchResult & {
  display: SlashDisplayPolicy
}

export type SubmitUserInputResult =
  | {
      type: 'slash'
      message: string
      display: SlashDisplayPolicy
      contextView?: ContextUsageViewModel
      overlayView?: SlashOverlayViewModel
    }
  | { type: 'prompt'; terminal: Terminal }
  | { type: 'empty' }

function asSwitchableSession(
  session: SlashSession,
): SwitchableProviderSession {
  return session as unknown as SwitchableProviderSession
}

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
  /** Stable UI policy or a resolver for argument/result-dependent commands. */
  display:
    | SlashDisplayPolicy
    | ((
        args: string,
        result: SlashDispatchResult,
      ) => SlashDisplayPolicy)
  run: (
    session: SlashSession,
    args: string,
  ) => Promise<SlashDispatchResult> | SlashDispatchResult
}

export function resolveSlashCommandDisplay(
  command: SlashCommandDef,
  args: string,
  result: SlashDispatchResult,
): SlashDisplayPolicy {
  let candidate: unknown = result.display
  if (candidate === undefined) {
    try {
      candidate =
        typeof command.display === 'function'
          ? command.display(args, result)
          : command.display
    } catch {
      candidate = undefined
    }
  }
  return normalizeSlashDisplayPolicy(
    candidate,
    result.ok ? 'info' : 'error',
  )
}

/** 产品超集（E 轨）；与 providers/effortDialect CANONICAL 对齐 */
export const EFFORT_LEVELS = [
  'auto',
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v.trim().toLowerCase())
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

async function cmdClear(
  session: SlashSession,
  _args: string,
): Promise<SlashDispatchResult> {
  // H0：/clear 前 SessionEnd(reason=clear)；不 ended、不关 MCP
  try {
    const { runSessionEndHooks } = await import('./index.ts')
    await runSessionEndHooks(session as never, { reason: 'clear' })
  } catch {
    /* hook 失败不挡 clear */
  }
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
          scope: meta?.scope ?? 'workspace',
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
          scope: meta?.scope ?? 'workspace',
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

function resolveContextUsageSource(
  session: SlashSession,
  resolutionSource: 'usage' | 'estimate' | 'hybrid',
): ContextUsageSource {
  if (resolutionSource === 'hybrid') return 'hybrid'
  if (resolutionSource === 'estimate') return 'estimated'
  const usageIsEstimated = session.usage?.lastCall
    ? session.usage.lastCall.estimated === true
    : session.usage?.estimated === true
  return usageIsEstimated ? 'estimated' : 'actual'
}

export function buildContextUsageViewModel(
  session: SlashSession,
): ContextUsageViewModel {
  const chars = approxChars(session)
  const est = estimateSessionContextTokens(session)
  const modelMetadata = getSessionModelMetadataView(
    asSwitchableSession(session),
  )
  const window = modelMetadata.context.tokens
  // C5：pressure 计数优先 usage；AR2A0a：有锚（真实 usage + 消息数快照）走混合
  const lastCall = session.usage?.lastCall
  const anchor =
    lastCall &&
    !lastCall.estimated &&
    lastCall.inputTokens > 0 &&
    lastCall.messageCountAtCall != null &&
    lastCall.messageCountAtCall > 0
      ? {
          anchorInputTokens: lastCall.inputTokens,
          anchoredMessageCount: lastCall.messageCountAtCall,
          ...(lastCall.messagePrefixFingerprint
            ? { fingerprint: lastCall.messagePrefixFingerprint }
            : {}),
        }
      : undefined
  const usageIn =
    session.usage?.lastCall?.inputTokens ??
    (session.usage && session.usage.inputTokens > 0
      ? session.usage.inputTokens
      : undefined)
  const resolved = resolveAutoCompactTokenCount({
    estimateTokens: est.totalTokens,
    usageInputTokens: usageIn,
    ...(anchor ? { anchor, messages: session.messages, pad: true } : {}),
  })
  const pressure = getContextPressure({
    tokenCount: resolved.tokenCount,
    contextWindowTokens: window,
  })
  const autoOn = session.autoCompactEnabled === true
  const envDisabled = isAutoCompactEnvDisabled(process.env)
  const sections = session.systemPromptSections.map((section, index) => ({
    index: index + 1,
    label: sectionLabel(section),
    chars: section.length,
    tokens: estimateSystemSectionsTokens([section]),
    role: sectionRoleHint(section),
  }))
  const { stats: skills } = formatSkillCatalogWithStats(session.skills ?? [], {
    contextWindowTokens: window,
  })
  const promptCacheLine = formatPromptCacheSessionLine(
    session.promptCacheState,
  )?.replace(/^\s*promptCache:\s*/, 'promptCache:     ')
  const source = resolveContextUsageSource(session, resolved.source)
  const freeTokens = Math.max(0, window - resolved.tokenCount)

  return {
    modelMetadata,
    session: {
      id: session.id,
      cwd: session.cwd,
      messageCount: session.messages.length,
      chars,
      permissionMode: session.permissionMode,
      ...(session.model ? { model: session.model } : {}),
      effort: session.effortLevel ?? 'auto',
      thinking: session.showThinking !== false,
      persistReasoning: session.persistReasoning === true,
    },
    estimate: est,
    usage: {
      tokenCount: resolved.tokenCount,
      windowTokens: window,
      effectiveWindowTokens: pressure.effectiveWindow,
      autoThresholdTokens: pressure.autoThreshold,
      freeTokens,
      percentOfWindow: pressure.percentOfWindow,
      percentOfThreshold: pressure.percentOfThreshold,
      level: pressure.level,
      source,
      resolutionSource: resolved.source,
      ...(usageIn != null ? { inputUsageTokens: usageIn } : {}),
      ...(resolved.source === 'hybrid' && anchor
        ? {
            anchorInputTokens: anchor.anchorInputTokens,
            tailEstimatedTokens: Math.max(
              0,
              resolved.tokenCount - anchor.anchorInputTokens,
            ),
          }
        : {}),
    },
    categories: [
      {
        id: 'messages',
        label: 'Messages',
        tokens: est.messagesTokens,
        source: 'estimated',
      },
      {
        id: 'system',
        label: 'System',
        tokens: est.systemTokens,
        source: 'estimated',
      },
      {
        id: 'free',
        label: 'Free',
        tokens: freeTokens,
        source: 'derived',
      },
    ],
    sections,
    skills,
    autoCompact: {
      enabled: autoOn,
      envDisabled,
      aboveThreshold: pressure.aboveAutoThreshold,
    },
    ...(session.lastCompact
      ? { lastCompact: { ...session.lastCompact } }
      : {}),
    usageLine: formatUsageOneLiner(session.usage),
    ...(promptCacheLine ? { promptCacheLine } : {}),
  }
}

export function formatContextUsagePlain(view: ContextUsageViewModel): string {
  const autoCompact = view.autoCompact.enabled
    ? view.autoCompact.envDisabled
      ? 'on (env-disabled)'
      : view.autoCompact.aboveThreshold
        ? 'on (threshold reached)'
        : 'on'
    : 'off'
  const metadataLines = formatModelMetadataLines(
    view.modelMetadata,
  ).filter(
    (line) =>
      line.startsWith('context:') || line.startsWith('max output:'),
  )
  return [
    `Context usage: ${view.usage.tokenCount} / ${view.usage.windowTokens} tokens (${view.usage.percentOfWindow}%; ${view.usage.source})`,
    `Breakdown (estimated): messages ~${view.estimate.messagesTokens} · system ~${view.estimate.systemTokens} · free ~${view.usage.freeTokens}`,
    `Pressure: ${view.usage.level} · auto threshold ~${view.usage.autoThresholdTokens} (${view.usage.percentOfThreshold}%)`,
    `Model: ${view.session.model ?? '(unset)'} · effort ${view.session.effort} · auto compact ${autoCompact}`,
    ...metadataLines,
    `Session: ${view.session.messageCount} messages · ${view.sections.length} system sections · ${view.skills.totalSkills} skills`,
    'Use /context details for sections, cache, memory, and compact diagnostics.',
  ].join('\n')
}

export function formatContextUsageDetails(view: ContextUsageViewModel): string {
  const sourceDetail =
    view.usage.source === 'hybrid' &&
    view.usage.anchorInputTokens != null &&
    view.usage.tailEstimatedTokens != null
      ? `  (anchor input ~${view.usage.anchorInputTokens} + tail est ~${view.usage.tailEstimatedTokens}, ×4/3 pad)`
      : view.usage.inputUsageTokens != null
        ? `  (usage input ~${view.usage.inputUsageTokens}${view.usage.source === 'estimated' ? '; provider marked estimated' : ''})`
        : ''
  const lines = [
    `id:              ${view.session.id}`,
    `cwd:             ${view.session.cwd}`,
    `messages:        ${view.session.messageCount}`,
    `chars (approx):  ${view.session.chars}`,
    `tokens (est):    ~${view.estimate.totalTokens}  (messages ~${view.estimate.messagesTokens} + system ~${view.estimate.systemTokens})`,
    `  heuristic:     text≈chars/4; dense JSON≈chars/2; tool_calls counted (local only, not billing)`,
    `pressure source: ${view.usage.source}${sourceDetail}`,
    `window:          ${view.usage.windowTokens}  (effective ~${view.usage.effectiveWindowTokens}; auto threshold ~${view.usage.autoThresholdTokens})`,
    `pressure:        ${view.usage.level}  (~${view.usage.percentOfWindow}% of window; ~${view.usage.percentOfThreshold}% of auto threshold)`,
    `autoCompact:     ${view.autoCompact.enabled ? 'on' : 'off'}${view.autoCompact.enabled && view.autoCompact.aboveThreshold && !view.autoCompact.envDisabled ? '  (would trigger on next prepare/mid-turn)' : ''}${view.autoCompact.envDisabled ? '  (env-disabled)' : ''}`,
    `keep policy:     user-turns (default smart; keepRecentUserTurns / keepRecentMessageCount)`,
    `permissionMode:  ${view.session.permissionMode}`,
    `model:           ${view.session.model ?? '(unset)'}`,
    ...formatModelMetadataLines(view.modelMetadata),
    `effort:          ${view.session.effort}`,
    `thinking:        ${view.session.thinking ? 'on' : 'off'}  (/thinking; persist=${view.session.persistReasoning ? 'on' : 'off'})`,
    `system sections: ${view.sections.length}`,
  ]
  if (view.lastCompact) {
    const lc = view.lastCompact
    lines.push(
      `last compact:    ${lc.trigger} @ ${lc.at}  summaryChars=${lc.summaryChars}  messagesAfter=${lc.messagesAfter}`,
    )
  }
  for (const section of view.sections) {
    lines.push(
      `  [${section.index}] ${section.label}  (${section.chars} chars, ~${section.tokens} tok, ${section.role})`,
    )
  }
  if (view.skills.totalSkills > 0) {
    lines.push(formatSkillCatalogStatsLine(view.skills))
  } else {
    lines.push('skill catalog:     (no skills loaded)')
  }
  lines.push(
    'memory:          user ~/.bolo/memory + project .bolo/memory · index caps 200 lines / 25k chars · /memory',
    'cache:           stable system prefix first; providers may send cache_control / prompt_cache_key (see docs/PROMPT_CACHE.md)',
  )
  if (view.promptCacheLine) {
    lines.push(view.promptCacheLine)
  }
  lines.push(
    'prepare order:   snip → microcompact → auto full compact → callModel; mid-turn after tools (C3); PTL truncate fallback',
    'toggle:          /autocompact [on|off]',
    view.usageLine,
  )
  return lines.join('\n')
}

function cmdContext(session: SlashSession, args: string): SlashDispatchResult {
  const raw = args.trim().toLowerCase()
  if (raw && raw !== 'details' && raw !== 'detail' && raw !== '--details') {
    return {
      ok: false,
      message: 'Usage: /context [details]',
    }
  }
  const view = buildContextUsageViewModel(session)
  if (raw) {
    return { ok: true, message: formatContextUsageDetails(view) }
  }
  return {
    ok: true,
    message: formatContextUsagePlain(view),
    contextView: view,
  }
}

function turnControlId(prefix: 'control' | 'turn'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function shortTurnPrompt(prompt: string | undefined): string {
  const value = (prompt ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  return value.length > 72 ? `${value.slice(0, 71)}…` : value
}

async function cmdTurn(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const coordinator = session.coordinator
  if (!coordinator) {
    return {
      ok: false,
      message: 'turn controls unavailable: session has no coordinator',
    }
  }

  const raw = args.trim()
  const firstSpace = raw.search(/\s/)
  const action = (
    raw
      ? firstSpace < 0
        ? raw
        : raw.slice(0, firstSpace)
      : 'status'
  ).toLowerCase()
  const rest =
    raw && firstSpace >= 0 ? raw.slice(firstSpace).trim() : ''
  const snapshot = coordinator.snapshot(session.id)
  const runtimeSession = session as unknown as SessionControlRuntimeSession

  if (action === 'status') {
    if (rest) {
      return {
        ok: false,
        message:
          'Usage: /turn status | steer <text> | interrupt | queue <text> | cancel <controlId>',
      }
    }
    const lines = [
      `Turn coordinator: ${snapshot.state}`,
      `session: ${snapshot.sessionId}`,
    ]
    if (snapshot.state === 'running') {
      lines.push(`active: ${snapshot.active.turnId}`)
      if (snapshot.active.querySource) {
        lines.push(`source: ${snapshot.active.querySource}`)
      }
    }
    if (!snapshot.controls.length) {
      lines.push('controls: (none)')
    } else {
      lines.push('controls:')
      for (const control of snapshot.controls) {
        lines.push(
          [
            `  ${control.controlId}`,
            `${control.kind}/${control.state}`,
            control.turnId ? `turn=${control.turnId}` : '',
            control.expectedTurnId
              ? `expected=${control.expectedTurnId}`
              : '',
            control.boundary ? `boundary=${control.boundary}` : '',
            control.prompt
              ? `prompt="${shortTurnPrompt(control.prompt)}"`
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
      }
    }
    return { ok: true, message: lines.join('\n') }
  }

  if (action === 'steer') {
    if (!rest) {
      return { ok: false, message: 'Usage: /turn steer <text>' }
    }
    if (snapshot.state !== 'running') {
      return { ok: false, message: 'turn steer rejected: no active turn' }
    }
    const result = await requestSessionControl(runtimeSession, {
      controlId: turnControlId('control'),
      kind: 'steer',
      sessionId: session.id,
      expectedTurnId: snapshot.active.turnId,
      prompt: rest,
    })
    return result.ok
      ? {
          ok: true,
          message:
            `turn steer ${result.control.state}: ${result.control.controlId}` +
            ` (expected ${snapshot.active.turnId})` +
            (result.persistenceWarning
              ? `\nwarning: ${result.persistenceWarning}`
              : ''),
        }
      : {
          ok: false,
          message: `turn steer rejected [${result.code}]: ${result.detail}`,
        }
  }

  if (action === 'interrupt') {
    if (rest) {
      return { ok: false, message: 'Usage: /turn interrupt' }
    }
    if (snapshot.state !== 'running') {
      return { ok: false, message: 'turn interrupt rejected: no active turn' }
    }
    const result = await requestSessionControl(runtimeSession, {
      controlId: turnControlId('control'),
      kind: 'interrupt',
      sessionId: session.id,
      expectedTurnId: snapshot.active.turnId,
    })
    return result.ok
      ? {
          ok: true,
          message:
            `turn interrupt ${result.control.state}: ` +
            `${result.control.controlId} (${snapshot.active.turnId})` +
            (result.persistenceWarning
              ? `\nwarning: ${result.persistenceWarning}`
              : ''),
        }
      : {
          ok: false,
          message: `turn interrupt rejected [${result.code}]: ${result.detail}`,
        }
  }

  if (action === 'queue') {
    if (!rest) {
      return { ok: false, message: 'Usage: /turn queue <text>' }
    }
    const result = await requestSessionControl(runtimeSession, {
      controlId: turnControlId('control'),
      kind: 'queue',
      sessionId: session.id,
      ...(snapshot.state === 'running'
        ? { expectedTurnId: snapshot.active.turnId }
        : {}),
      turnId: turnControlId('turn'),
      prompt: rest,
      querySource: 'cli_turn_queue',
    })
    return result.ok
      ? {
          ok: true,
          message:
            `turn queue ${result.control.state}: ${result.control.controlId}` +
            ` (turn ${result.control.turnId})` +
            (result.persistenceWarning
              ? `\nwarning: ${result.persistenceWarning}`
              : ''),
        }
      : {
          ok: false,
          message: `turn queue rejected [${result.code}]: ${result.detail}`,
        }
  }

  if (action === 'cancel') {
    if (!rest || /\s/.test(rest)) {
      return {
        ok: false,
        message: 'Usage: /turn cancel <controlId>',
      }
    }
    const result = await cancelSessionControl(runtimeSession, {
      controlId: rest,
    })
    return result.ok
      ? {
          ok: true,
          message:
            `turn control cancelled: ${result.control.controlId}` +
            (result.persistenceWarning
              ? `\nwarning: ${result.persistenceWarning}`
              : ''),
        }
      : {
          ok: false,
          message: `turn cancel rejected [${result.code}]: ${result.detail}`,
        }
  }

  return {
    ok: false,
    message:
      'Usage: /turn status | steer <text> | interrupt | queue <text> | cancel <controlId>',
  }
}

function runtimeCommandId(): string {
  return `runtime_${randomUUID().replaceAll('-', '')}`
}

function asRuntimeCommandSession(
  session: SlashSession,
): RuntimeCommandSession | null {
  if (
    !session.coordinator ||
    !session.phase ||
    !Array.isArray(session.durableTurns) ||
    !Array.isArray(session.durableControls) ||
    !Array.isArray(session.durableTasks) ||
    !Array.isArray(session.durableResolutions)
  ) {
    return null
  }
  return session as unknown as RuntimeCommandSession
}

function runtimeInspectCommand(sessionId: string): RuntimeCommand {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.command',
    requestId: runtimeCommandId(),
    action: 'runtime.inspect',
    target: { sessionId },
  }
}

function runtimeResultMessage(result: RuntimeCommandResult): string {
  if (!result.ok) {
    return `runtime command rejected [${result.code}]: ${result.detail}`
  }
  const lines = [`runtime command accepted: ${result.action}`]
  if (result.replacement) {
    lines.push(
      `replacement: control=${result.replacement.controlId} ` +
        `turn=${result.replacement.turnId} ` +
        `replaced=${result.replacement.replacedControlId}`,
    )
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`warning: ${warning}`)
  }
  return lines.join('\n')
}

async function cmdRuntime(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const runtimeSession = asRuntimeCommandSession(session)
  if (!runtimeSession) {
    return {
      ok: false,
      message: 'runtime protocol unavailable on this session',
    }
  }
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const action = (parts[0] ?? 'list').toLowerCase()
  const inspected = await executeRuntimeCommand(
    runtimeSession,
    runtimeInspectCommand(session.id),
  )
  if (!inspected.ok || !inspected.snapshot) {
    return { ok: false, message: runtimeResultMessage(inspected) }
  }
  const snapshot = inspected.snapshot

  if (action === 'list' || action === 'status') {
    const entity = parts[1]?.toLowerCase()
    if (
      parts.length > 2 ||
      (entity !== undefined && !isRuntimeQueryEntity(entity))
    ) {
      return {
        ok: false,
        message:
          'Usage: /runtime list [turn|control|task]',
      }
    }
    const queried = queryRuntimeSnapshot(snapshot, {
      action: 'list',
      ...(entity ? { entity } : {}),
    })
    if (!queried.ok || queried.view.kind !== 'runtime.list') {
      return {
        ok: false,
        message: queried.ok
          ? 'runtime list query returned an unexpected view'
          : queried.detail,
      }
    }
    return {
      ok: true,
      message: renderRuntimeText(queried.view, {
        columns: Number.MAX_SAFE_INTEGER,
        pageSize: Number.MAX_SAFE_INTEGER,
        color: false,
      }).text,
    }
  }
  if (action === 'json') {
    if (parts.length > 1) {
      return { ok: false, message: 'Usage: /runtime json' }
    }
    return { ok: true, message: JSON.stringify(snapshot, null, 2) }
  }
  if (action === 'inspect') {
    const entity = parts[1]?.toLowerCase()
    const id = parts[2]
    if (
      !id ||
      parts.length !== 3 ||
      !isRuntimeQueryEntity(entity)
    ) {
      return {
        ok: false,
        message:
          'Usage: /runtime inspect <turn|control|task> <id>',
      }
    }
    const queried = queryRuntimeSnapshot(snapshot, {
      action: 'inspect',
      entity,
      entityId: id,
    })
    if (!queried.ok) {
      return {
        ok: false,
        message: queried.detail,
      }
    }
    if (queried.view.kind !== 'runtime.inspect') {
      return {
        ok: false,
        message: 'runtime inspect query returned an unexpected view',
      }
    }
    return {
      ok: true,
      message: JSON.stringify(
        {
          ...queried.view.item.record,
          availableActions: queried.view.item.availableActions,
        },
        null,
        2,
      ),
    }
  }
  if (action === 'interrupt') {
    const turnId = parts[1]
    if (!turnId || parts.length !== 2) {
      return { ok: false, message: 'Usage: /runtime interrupt <turnId>' }
    }
    const result = await executeRuntimeCommand(runtimeSession, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command',
      requestId: runtimeCommandId(),
      action: 'turn.interrupt',
      target: {
        sessionId: session.id,
        turnId,
        expectedState: 'running',
      },
    })
    return { ok: result.ok, message: runtimeResultMessage(result) }
  }
  if (action === 'cancel') {
    const entity = parts[1]?.toLowerCase()
    const id = parts[2]
    if (!id || parts.length !== 3) {
      return {
        ok: false,
        message: 'Usage: /runtime cancel <control|task> <id>',
      }
    }
    let command: RuntimeCommand | undefined
    if (entity === 'control') {
      const control = snapshot.session.controls.find(
        (row) => row.controlId === id,
      )
      if (control?.state === 'pending' || control?.state === 'ready') {
        command = {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          kind: 'runtime.command',
          requestId: runtimeCommandId(),
          action: 'control.cancel',
          target: {
            sessionId: session.id,
            controlId: id,
            expectedState: control.state,
          },
        }
      }
    } else if (entity === 'task') {
      const task = snapshot.session.tasks.find((row) => row.taskId === id)
      if (task?.state === 'queued') {
        command = {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          kind: 'runtime.command',
          requestId: runtimeCommandId(),
          action: 'task.cancel',
          target: {
            sessionId: session.id,
            taskId: id,
            expectedState: 'queued',
          },
        }
      }
    }
    if (!command) {
      return {
        ok: false,
        message: `runtime ${entity ?? 'entity'} "${id}" is not cancellable`,
      }
    }
    const result = await executeRuntimeCommand(runtimeSession, command)
    return { ok: result.ok, message: runtimeResultMessage(result) }
  }
  if (action === 'edit') {
    const controlId = parts[1]
    const prompt = parts.slice(2).join(' ').trim()
    if (!controlId || !prompt) {
      return {
        ok: false,
        message: 'Usage: /runtime edit <controlId> <prompt>',
      }
    }
    const control = snapshot.session.controls.find(
      (row) => row.controlId === controlId,
    )
    if (
      control?.kind !== 'queue' ||
      (control.state !== 'pending' && control.state !== 'ready')
    ) {
      return {
        ok: false,
        message: `runtime control "${controlId}" is not editable`,
      }
    }
    const result = await executeRuntimeCommand(runtimeSession, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command',
      requestId: runtimeCommandId(),
      action: 'control.replace',
      target: {
        sessionId: session.id,
        controlId,
        expectedState: control.state,
      },
      replacement: {
        prompt,
        querySource: 'runtime_edit',
      },
    })
    return { ok: result.ok, message: runtimeResultMessage(result) }
  }
  if (action === 'remove') {
    const controlId = parts[1]
    if (!controlId || parts.length !== 2) {
      return {
        ok: false,
        message: 'Usage: /runtime remove <controlId>',
      }
    }
    const control = snapshot.session.controls.find(
      (row) => row.controlId === controlId,
    )
    if (
      control?.kind !== 'queue' ||
      (control.state !== 'pending' && control.state !== 'ready')
    ) {
      return {
        ok: false,
        message: `runtime control "${controlId}" is not removable`,
      }
    }
    const result = await executeRuntimeCommand(runtimeSession, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command',
      requestId: runtimeCommandId(),
      action: 'control.cancel',
      target: {
        sessionId: session.id,
        controlId,
        expectedState: control.state,
      },
    })
    return { ok: result.ok, message: runtimeResultMessage(result) }
  }
  if (action === 'discard' || action === 'retry-safe') {
    const entity = parts[1]?.toLowerCase()
    const id = parts[2]
    if (
      !id ||
      parts.length !== 3 ||
      (entity !== 'turn' &&
        entity !== 'control' &&
        entity !== 'task')
    ) {
      return {
        ok: false,
        message:
          `Usage: /runtime ${action} <turn|control|task> <id>`,
      }
    }
    const result = await executeRuntimeCommand(runtimeSession, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command',
      requestId: runtimeCommandId(),
      action:
        action === 'discard'
          ? 'runtime.discard'
          : 'runtime.retry-safe',
      target: {
        sessionId: session.id,
        entity,
        entityId: id,
        expectedState: 'interrupted',
      },
    })
    return { ok: result.ok, message: runtimeResultMessage(result) }
  }
  return {
    ok: false,
    message:
      'Usage: /runtime [list|json|inspect [turn|control|task] [id]|interrupt <turnId>|cancel <control|task> <id>|edit <controlId> <prompt>|remove <controlId>|discard <turn|control|task> <id>|retry-safe <turn|control|task> <id>]',
  }
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
 * P-DOC-HEALTH：memory 根、plugins、警告、autoCompact。
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
  const pluginMergeErrs =
    (session as { pluginMerge?: { errors?: string[] } }).pluginMerge?.errors
      ?.length ?? 0
  const autoCompact =
    session.autoCompactEnabled === true ? 'on' : 'off'
  const maxPtl =
    session.maxPtlRetries === undefined
      ? '(unset)'
      : String(session.maxPtlRetries)
  const modelMetadata = getSessionModelMetadataView(
    asSwitchableSession(session),
  )

  const memDisable = process.env.BOLO_DISABLE_MEMORY?.trim().toLowerCase()
  const memOff =
    memDisable === '1' ||
    memDisable === 'true' ||
    memDisable === 'yes' ||
    memDisable === 'on'
  const memoryUserDir =
    process.env.BOLO_MEMORY_DIR?.trim() ||
    path.join(boloHome, 'memory')
  const memoryProjectDir = path.join(session.cwd, '.bolo', 'memory')
  const memoryUser = `${memoryUserDir} (${existsSync(memoryUserDir) ? 'exists' : 'missing'}${memOff ? ', disabled' : ''})`
  const memoryProject = `${memoryProjectDir} (${existsSync(memoryProjectDir) ? 'exists' : 'missing'})`

  const lines = [
    `node:            ${process.version}`,
    `platform:        ${process.platform}`,
    `cwd:             ${session.cwd}`,
    `session id:      ${session.id}`,
    `provider:        ${session.providerId ? `${session.providerId} (kind=${session.provider?.id ?? '?'})` : (session.provider?.id ?? '(unset)')}`,
    `permissionMode:  ${session.permissionMode}`,
    `model:           ${session.model ?? '(unset)'}`,
    `context window:  ${modelMetadata.context.displayTokens} tokens (${modelMetadata.context.sourceLabel})`,
    `max output:      ${modelMetadata.maxOutput.displayTokens} tokens (${modelMetadata.maxOutput.sourceLabel})`,
    `metadata:        ${modelMetadata.status === 'warning' ? 'WARNING' : 'OK'}`,
    ...modelMetadata.warnings.map(
      (warning) => `metadata warning: ${warning}`,
    ),
    `effort:          ${session.effortLevel ?? 'auto'}`,
    `ultrathink:      ${resolveUltrathinkMode({ sessionMode: session.ultrathinkMode })}`,
    `thinking:        ${session.showThinking === false ? 'off' : 'on'}`,
    `messages:        ${session.messages.length}`,
    `system sections: ${session.systemPromptSections.length}`,
    `tools:           ${toolsCount}`,
    `skills:          ${skillsCount}`,
    `agent types:     ${agentTypesCount}`,
    `agents policy:   ${formatAgentsPolicyOneLiner(session.agentPolicy)}`,
    `plugins:         ${pluginsCount}` +
      (pluginMergeErrs ? `  warnings=${pluginMergeErrs}` : ''),
    `memory user:     ${memoryUser}`,
    `memory project:  ${memoryProject}`,
  ]
  // E9：effort 方言预览一行
  try {
    const d = resolveSessionEffortDialect(session)
    const one = formatEffortStatusLine({
      effortLevel: session.effortLevel,
      dialect: d as string | undefined,
      isAgent: true,
      model: session.model ?? session.providerProfile?.model,
    })
      .split('\n')
      .filter((l) => l.startsWith('wire:') || l.startsWith('dialect:'))
      .join(' · ')
    if (one) lines.push(`effort detail:   ${one}`)
  } catch {
    /* ignore */
  }
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
      const message =
        'plugin commands: (none)\nAdd commands/*.md under a plugin (or contributes.commands), then /plugins reload.'
      return {
        ok: true,
        message,
        overlayView: {
          kind: 'picker',
          title: 'Plugin commands',
          items: [],
          emptyMessage: message,
        },
      }
    }
    const lines = [`plugin commands (${cmds.length}):`]
    for (const c of cmds) {
      const desc = c.description ? ` — ${c.description}` : ''
      lines.push(`  /${c.name}${desc}  [${c.pluginId}]`)
    }
    lines.push('Invoke: /<plugin-id>:<name>  (body injects into conversation as user message)')
    return {
      ok: true,
      message: lines.join('\n'),
      overlayView: {
        kind: 'picker',
        title: 'Plugin commands',
        items: cmds.map((command) => ({
          id: command.name,
          label:
            `/${command.name}` +
            (command.description ? ` — ${command.description}` : '') +
            ` [${command.pluginId}]`,
        })),
      },
    }
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
    const message =
      'plugins: (none loaded)\nPlace plugins under ~/.bolo/plugins/<id>/ or .bolo/plugins/<id>/ with bolo.plugin.json.\nMarket: /plugins market add <path|url> · /plugins search · /plugins install <id>@<market>\nUse /plugins reload after adding files mid-session.'
    return {
      ok: true,
      message,
      overlayView: {
        kind: 'picker',
        title: 'Plugins',
        items: [],
        emptyMessage: message,
      },
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
  return {
    ok: true,
    message: lines.join('\n'),
    overlayView: {
      kind: 'picker',
      title: 'Plugins',
      items: plugins.map((plugin) => {
        const id = plugin.manifest?.id ?? '(unknown)'
        const version = plugin.manifest?.version
          ? ` v${plugin.manifest.version}`
          : ''
        const scope = plugin.scope ? ` [${plugin.scope}]` : ''
        const name = plugin.manifest?.name
          ? ` — ${plugin.manifest.name}`
          : ''
        return {
          id,
          label: `${id}${version}${scope}${name}`,
        }
      }),
    },
  }
}

async function cmdPluginsMarket(
  _session: SlashSession,
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
        const message =
          'marketplaces: (none)\nAdd: /plugins market add <local-path-or-https-url>'
        return {
          ok: true,
          message,
          overlayView: {
            kind: 'picker',
            title: 'Plugin marketplaces',
            items: [],
            emptyMessage: message,
          },
        }
      }
      const lines = [`marketplaces (${known.length}):`]
      for (const k of known) {
        lines.push(`  ${k.name}  ← ${k.source}`)
      }
      lines.push('Search: /plugins search [query]  ·  Install: /plugins install <id>@<market>')
      return {
        ok: true,
        message: lines.join('\n'),
        overlayView: {
          kind: 'picker',
          title: 'Plugin marketplaces',
          items: known.map((marketplace) => ({
            id: marketplace.name,
            label: `${marketplace.name} ← ${marketplace.source}`,
          })),
        },
      }
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
      return {
        ok: true,
        message: lines.join('\n'),
        overlayView: {
          kind: 'picker',
          title: `Marketplace ${known.name}`,
          items: catalog.plugins.slice(0, 40).map((plugin) => ({
            id: plugin.id,
            label:
              plugin.id +
              (plugin.version ? ` v${plugin.version}` : '') +
              (plugin.description ? ` — ${plugin.description}` : ''),
          })),
          ...(catalog.plugins.length
            ? {}
            : { emptyMessage: `No plugins in marketplace ${known.name}.` }),
        },
      }
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
      const message = query
        ? `No plugins matching "${query}". Register a market first: /plugins market add <path>`
        : 'No plugins in registered markets. /plugins market add <path>'
      return {
        ok: true,
        message,
        overlayView: {
          kind: 'picker',
          title: 'Plugin search',
          items: [],
          emptyMessage: message,
        },
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
    return {
      ok: true,
      message: lines.join('\n'),
      overlayView: {
        kind: 'picker',
        title: 'Plugin search',
        items: hits.slice(0, 30).map((hit) => ({
          id: `${hit.entry.id}@${hit.marketplace}`,
          label:
            `${hit.entry.id}@${hit.marketplace}` +
            (hit.entry.version ? ` v${hit.entry.version}` : '') +
            (hit.entry.description
              ? ` — ${hit.entry.description}`
              : ''),
        })),
      },
    }
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
    installPluginFromZip,
    installPluginFromUrl,
    looksLikeZipPath,
  } = await import('../../plugins/src/marketplace.ts')
  const raw = parts[0] ?? ''
  if (!raw) {
    return {
      ok: false,
      message:
        'Usage: /plugins install <id>@<marketplace> | path:<dir|zip> | zip:<file.zip> | url:<https://…/x.zip>  [--project]',
    }
  }
  const scope = parts.includes('--project') ? 'project' : 'user'
  try {
    if (/^https?:\/\//i.test(raw) || raw.startsWith('url:')) {
      const u = raw.replace(/^url:/i, '')
      const rec = await installPluginFromUrl({
        url: u,
        scope,
        cwd: session.cwd,
      })
      return {
        ok: true,
        message: `Installed ${rec.id} from url → ${rec.installPath}\nRun /plugins reload to activate.`,
      }
    }
    if (
      raw.startsWith('path:') ||
      raw.startsWith('file:') ||
      raw.startsWith('zip:')
    ) {
      const p = raw.replace(/^(path|file|zip):/i, '')
      const rec = looksLikeZipPath(p)
        ? await installPluginFromZip({
            zipPath: p,
            scope,
            cwd: session.cwd,
          })
        : await installPluginFromPath({
            path: p,
            scope,
            cwd: session.cwd,
          })
      return {
        ok: true,
        message: `Installed ${rec.id} → ${rec.installPath}\nRun /plugins reload to activate.`,
      }
    }
    if (looksLikeZipPath(raw)) {
      const rec = await installPluginFromZip({
        zipPath: raw,
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
          'Usage: /plugins install <id>@<marketplace>  or  path:<plugin-dir|zip>  or  url:<https zip>',
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
    return {
      ok: false,
      message: `install failed: ${msg}`,
      display: historyDisplay('error'),
    }
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
    return {
      ok: false,
      message: `uninstall failed: ${msg}`,
      display: historyDisplay('error'),
    }
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
  return {
    ok: true,
    message: lines.join('\n'),
    ...(r.errors.length || r.warnings.length
      ? {
          display: toastDisplay(
            'slash:plugins:reload',
            'warning',
            8_000,
          ),
        }
      : {}),
  }
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
 * 列出会话 hooks 配置（只读）+ 可选 recent 诊断。
 * 无参：各事件 matcher 组数 / command 数；
 * `recent` / `diag` / `failures`：最近失败/timeout/block；
 * 事件名：该事件配置详情。
 */
function cmdHooks(session: SlashSession, args: string): SlashDispatchResult {
  const hooks: HooksConfig = session.hooks ?? {}
  const want = args.trim()
  const wantLower = want.toLowerCase()

  if (
    wantLower === 'recent' ||
    wantLower === 'diag' ||
    wantLower === 'failures' ||
    wantLower === 'log'
  ) {
    const onlyProblems = wantLower === 'failures'
    const log = (session as { hookDiagLog?: unknown }).hookDiagLog
    return {
      ok: true,
      message: formatHookDiagRecentFromSession(log, {
        max: 16,
        onlyProblems,
      }),
    }
  }

  if (want) {
    const event = HOOK_EVENTS.find(
      (e) => e.toLowerCase() === want.toLowerCase(),
    ) as HookEvent | undefined
    if (!event) {
      return {
        ok: false,
        message: `Unknown hook event "${want}". Known: ${HOOK_EVENTS.join(', ')}. Or: /hooks recent`,
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
        'hooks: (none configured)\nConfigure ~/.bolo/hooks.json or .bolo/hooks.json. Use /hooks <EventName> or /hooks recent.',
    }
  }
  lines.push(`total commands: ${totalCmds}`)
  const diagLen =
    (session as { hookDiagLog?: { entries?: unknown[] } }).hookDiagLog?.entries
      ?.length ?? 0
  if (diagLen > 0) {
    lines.push(`recent diag entries: ${diagLen} (see /hooks recent)`)
  }
  lines.push('Use /hooks <EventName> · /hooks recent · /hooks failures')
  return { ok: true, message: lines.join('\n') }
}

function formatHookDiagRecentFromSession(
  log: unknown,
  opts?: { max?: number; onlyProblems?: boolean },
): string {
  const entries =
    (log as { entries?: Array<Record<string, unknown>> } | undefined)?.entries ??
    []
  const max = opts?.max ?? 12
  const onlyProblems = opts?.onlyProblems === true
  let rows = onlyProblems
    ? entries.filter(
        (e) =>
          e.exitCode !== 0 || e.blocked || e.timedOut || e.aborted,
      )
    : entries
  if (!rows.length) {
    return onlyProblems
      ? 'hooks recent: (no failures/timeouts in ring)'
      : 'hooks recent: (empty — run tools or prompts with hooks configured)'
  }
  rows = rows.slice(-max)
  const lines = [
    `hooks recent (last ${rows.length}${onlyProblems ? ', problems' : ''}):`,
  ]
  for (const e of rows) {
    const flags: string[] = []
    if (e.blocked) flags.push('blocked')
    if (e.timedOut) flags.push('timeout')
    if (e.aborted) flags.push('aborted')
    if (e.updatedInput) flags.push('updatedInput')
    const flag = flags.length ? ` [${flags.join(',')}]` : ''
    const det = e.detail ? ` — ${e.detail}` : ''
    lines.push(`  ${e.at}  ${e.event}  exit=${e.exitCode}${flag}${det}`)
  }
  return lines.join('\n')
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
  const promptCacheLine = formatPromptCacheSessionLine(session.promptCacheState)
  let wallLine: string | undefined
  if (
    session.sessionStartedAtMs != null &&
    Number.isFinite(session.sessionStartedAtMs)
  ) {
    const wall = Math.max(0, Date.now() - session.sessionStartedAtMs)
    wallLine = `  wall:          ${formatDurationMs(wall)} (session clock, local)`
  }
  let body = formatSessionUsage(session.usage, { promptCacheLine })
  if (wallLine) {
    const lines = body.split('\n')
    if (lines.length >= 2) {
      lines.splice(2, 0, wallLine)
      body = lines.join('\n')
    } else {
      body = `${body}\n${wallLine}`
    }
  }
  return { ok: true, message: body }
}

/**
 * `/diff`：会话文件改动（Edit/Write/apply_patch meta 侧信道）。
 * - 无参：累计
 * - last：最近用户 turn
 * - git [path]：工作区 git status / 单文件 diff
 * - <path>：该路径最近一次 structured 摘要
 */
async function cmdDiff(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const raw = args.trim()
  const log = session.fileDiffLog
  if (!raw) {
    return {
      ok: true,
      message: formatDiffSlash(log),
      overlayView: { kind: 'diff', mode: 'session' },
    }
  }
  if (raw === 'last' || raw === 'turn') {
    return {
      ok: true,
      message: formatDiffSlash(log, { lastTurn: true }),
      overlayView: { kind: 'diff', mode: 'last' },
    }
  }
  const gitMatch = raw.match(/^git(?:\s+(.+))?$/i)
  if (gitMatch) {
    const pathArg = gitMatch[1]?.trim()
    try {
      const {
        listGitStatus,
        formatGitStatusSlash,
        fetchSingleFileGitDiff,
        formatGitFileDiffSlash,
      } = await import('../../tools/src/gitDiff.ts')
      if (!pathArg) {
        const entries = await listGitStatus(session.cwd)
        return { ok: true, message: formatGitStatusSlash(entries) }
      }
      const d = await fetchSingleFileGitDiff(session.cwd, pathArg)
      return { ok: true, message: formatGitFileDiffSlash(d, pathArg) }
    } catch (e) {
      return {
        ok: false,
        message: `git diff failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
  // 单 path：仍给文本；TTY 面板可后接 pathFilter
  return {
    ok: true,
    message: formatDiffSlash(log, { pathFilter: raw }),
    overlayView: {
      kind: 'diff',
      mode: 'session',
      pathFilter: raw,
    },
  }
}

function cmdModel(session: SlashSession, args: string): SlashDispatchResult {
  const raw = args.trim()
  if (!raw) {
    const pid = session.providerId
    const kind = session.provider?.id
    const bits = [
      `model: ${session.model ?? '(unset)'}`,
      pid ? `provider: ${pid}` : null,
      kind ? `kind: ${kind}` : null,
    ].filter(Boolean)

    // CX5：建议模型列表（profile / preset）
    const suggestions = suggestModelsForSession(session)
    const modelMetadata = getSessionModelMetadataView(
      asSwitchableSession(session),
    )
    const lines = [
      bits.join('  |  '),
      ...formatModelMetadataLines(modelMetadata).filter(
        (line) =>
          line.startsWith('context:') ||
          line.startsWith('max output:') ||
          line.startsWith('metadata:') ||
          line.startsWith('warning:'),
      ),
    ]
    if (suggestions.length) {
      lines.push(`suggested: ${suggestions.join(', ')}`)
      lines.push('usage: /model <name>  ·  /model <providerId>/<name>')
    } else {
      lines.push('usage: /model <name>  ·  /model <providerId>/<name>')
    }

    // 附一行 effort wire 预览（CX4）
    try {
      const dialect = resolveSessionEffortDialect(session)
      const effortLine = formatEffortStatusLine({
        effortLevel: session.effortLevel,
        dialect: dialect as string | undefined,
        isAgent: true,
        model: session.model ?? session.providerProfile?.model,
      })
        .split('\n')
        .filter((l) => l.startsWith('wire:') || l.startsWith('dialect:'))
        .join(' · ')
      if (effortLine) lines.push(effortLine)
    } catch {
      /* ignore */
    }

    return { ok: true, message: lines.join('\n') }
  }

  // 糖：providerId/model 或 providerId:model
  const slash = raw.match(/^([^/:\s]+)[/:](.+)$/)
  if (slash) {
    const id = slash[1]!.trim()
    const model = slash[2]!.trim()
    if (session.providerRegistry) {
      const sw = switchSessionProvider(asSwitchableSession(session), id, {
        model,
      })
      if (!sw.ok) return { ok: false, message: sw.reason }
      return { ok: true, message: sw.message }
    }
    // 无 registry：仅设 model 名（兼容）
    const m = switchSessionModel(asSwitchableSession(session), model)
    if (!m.ok) return { ok: false, message: m.reason }
    return {
      ok: true,
      message: `${m.message} (no providers map; ignored provider id "${id}")`,
    }
  }

  const m = switchSessionModel(asSwitchableSession(session), raw)
  if (!m.ok) return { ok: false, message: m.reason }
  // 换 model 后 clamp effort（CX2/CX6）
  const clamp = clampEffortForSession(asSwitchableSession(session))
  if (clamp.warning) {
    return { ok: true, message: `${m.message}\n${clamp.warning}` }
  }
  return { ok: true, message: m.message }
}

/**
 * /provider — 无参：TTY 可 picker；list：仅文本；use <id>：热切；add：preset 写入 config。
 */
function cmdProvider(
  session: SlashSession,
  args: string,
): SlashDispatchResult | Promise<SlashDispatchResult> {
  const raw = args.trim()
  const textList = () =>
    formatSessionProvidersSlash(asSwitchableSession(session))

  // 强制文本（脚本 / 非交互）
  if (raw === 'list' || raw === 'show' || raw === 'ls') {
    return { ok: true, message: textList() }
  }

  // 无参：携带 renderer-neutral picker；非 TTY 仍只看 message。
  if (!raw) {
    const list = listSessionProviders(asSwitchableSession(session))
    if (!list.length) {
      return { ok: true, message: textList() }
    }
    return {
      ok: true,
      message: textList(),
      overlayView: {
        kind: 'action-picker',
        action: 'provider',
        title: 'Select provider',
        items: buildProviderPickerItems(asSwitchableSession(session)),
        initialIndex: activeProviderPickerIndex(
          asSwitchableSession(session),
        ),
      },
    }
  }

  const parts = raw.split(/\s+/).filter(Boolean)
  const head = parts[0]!.toLowerCase()
  if (head === 'use' || head === 'set' || head === 'switch') {
    const id = parts[1]
    if (!id) {
      return {
        ok: false,
        message: 'Usage: /provider use <id> [model]  ·  or bare /provider for TTY picker',
      }
    }
    const model = parts.slice(2).join(' ').trim() || undefined
    const sw = switchSessionProvider(asSwitchableSession(session), id, {
      model,
    })
    if (!sw.ok) return { ok: false, message: sw.reason }
    return { ok: true, message: sw.message }
  }

  // CX1：/provider add <preset> [as <id>] [overwrite]
  if (head === 'add' || head === 'new') {
    return cmdProviderAdd(session, parts.slice(1).join(' '))
  }

  if (head === 'help' || head === '?') {
    return {
      ok: true,
      message: [
        textList(),
        'usage: /provider          TTY → pick · else list',
        '       /provider list     text only',
        '       /provider use <id> [model]',
        '       /provider add <preset> [as <id>] [overwrite]',
        '       /provider add list',
      ].join('\n'),
    }
  }

  // 无子命令：第一词当 id（/provider deepseek）
  const id = parts[0]!
  const model = parts.slice(1).join(' ').trim() || undefined
  const sw = switchSessionProvider(asSwitchableSession(session), id, {
    model,
  })
  if (!sw.ok) {
    return {
      ok: false,
      message: `${sw.reason}\n${textList()}`,
    }
  }
  return { ok: true, message: sw.message }
}

/**
 * /provider add — 同步返回；写盘在 run 内 await 需改成 async 路径。
 * SlashCommandDef.run 支持 Promise，走 async IIFE 不方便 — 用同步阻塞不可取。
 * 改为：cmdProviderAdd 返回 Promise 兼容的 run（dispatch 已 await）。
 */
async function cmdProviderAdd(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const raw = args.trim()
  if (!raw || raw === 'list' || raw === 'ls' || raw === 'show') {
    const { formatProviderPresetsHelp } = await import(
      '../../config/src/providerPresets.ts'
    )
    return { ok: true, message: formatProviderPresetsHelp() }
  }

  const tokens = raw.split(/\s+/).filter(Boolean)
  let presetId = tokens[0]!
  let asId: string | undefined
  let overwrite = false
  let setDefault = false
  let scope: 'user' | 'project' = 'user'

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase()
    if (t === 'as' && tokens[i + 1]) {
      asId = tokens[++i]
      continue
    }
    if (t === 'overwrite' || t === '--overwrite' || t === '-f') {
      overwrite = true
      continue
    }
    if (t === 'default' || t === '--default') {
      setDefault = true
      continue
    }
    if (t === 'project' || t === '--project') {
      scope = 'project'
      continue
    }
    if (t === 'user' || t === '--user') {
      scope = 'user'
      continue
    }
  }

  const { addProviderProfileToConfigFile } = await import(
    '../../config/src/addProviderProfile.ts'
  )
  const { normalizeProviderRegistry } = await import(
    '../../config/src/providerRegistry.ts'
  )
  const { loadConfigJson, getUserLayout, getProjectLayout } = await import(
    '../../config/src/index.ts'
  )

  const added = await addProviderProfileToConfigFile({
    presetId,
    asId,
    overwrite,
    setDefault,
    scope,
    cwd: session.cwd,
  })
  if (!added.ok) {
    return { ok: false, message: added.reason }
  }

  // 热刷新 session.providerRegistry（合并 user+project 太重；至少把新 id 挂进当前 registry）
  try {
    const user = await loadConfigJson(getUserLayout())
    const project = await loadConfigJson(getProjectLayout(session.cwd))
    const { mergeConfigs } = await import('../../config/src/io.ts')
    const merged = mergeConfigs(user, project)
    const reg = normalizeProviderRegistry(merged)
    if (session.providerRegistry) {
      session.providerRegistry = reg
    } else {
      const { attachProviderRegistry } = await import('./sessionProvider.ts')
      attachProviderRegistry(asSwitchableSession(session), reg, session.providerId)
    }
  } catch {
    /* registry refresh best-effort */
  }

  return { ok: true, message: added.message }
}

type SlashEffortSession = Pick<
  SlashSession,
  'effortDialect' | 'providerProfile' | 'provider' | 'model'
>

function resolveSessionEffortDialect(session: SlashEffortSession) {
  return (
    session.effortDialect ??
    session.providerProfile?.effortDialect ??
    detectEffortDialectId({
      kind: session.provider?.id,
      baseUrl: session.providerProfile?.baseUrl,
      model: session.model ?? session.providerProfile?.model,
    })
  )
}

function cmdEffort(session: SlashSession, args: string): SlashDispatchResult {
  const dialect = resolveSessionEffortDialect(session)
  const model = session.model ?? session.providerProfile?.model
  const rawIn = args.trim()
  const raw = rawIn.toLowerCase()

  // 无参：能力视图 + renderer-neutral picker。
  if (!raw) {
    const message = formatEffortCapabilityStatus({
      effortLevel: session.effortLevel,
      dialect: dialect as string | undefined,
      isAgent: true,
      model,
    })
    const pickerOptions = {
      dialect: dialect as string | undefined,
      isAgent: true,
      model,
      effortLevel: session.effortLevel,
    }
    const items = buildEffortPickerItems(pickerOptions)
    return {
      ok: true,
      message,
      ...(items.length
        ? {
            overlayView: {
              kind: 'action-picker' as const,
              action: 'effort' as const,
              title: 'Select effort',
              items,
              initialIndex: activeEffortPickerIndex(pickerOptions),
            },
          }
        : {}),
    }
  }

  // list：仅文本，不开 picker
  if (raw === 'list' || raw === 'show' || raw === 'ls') {
    return {
      ok: true,
      message: formatEffortCapabilityStatus({
        effortLevel: session.effortLevel,
        dialect: dialect as string | undefined,
        isAgent: true,
        model,
      }),
    }
  }

  if (raw === 'auto') {
    session.effortLevel = undefined
    return {
      ok: true,
      message:
        'effort set to auto (cleared session override)\n' +
        formatEffortCapabilityStatus({
          effortLevel: 'auto',
          dialect: dialect as string | undefined,
          isAgent: true,
          model,
        }),
    }
  }

  // E6 strict choosable + E7 anthropic max gate
  const check = assertEffortChoosable(dialect as string | undefined, raw, {
    isAgent: true,
    model,
  })
  if (!check.ok) {
    return {
      ok: false,
      message:
        check.reason +
        '\n' +
        formatEffortCapabilityStatus({
          effortLevel: session.effortLevel,
          dialect: dialect as string | undefined,
          isAgent: true,
          model,
        }),
    }
  }

  // 兼容：仍要求是可识别 token（防止垃圾输入在 loose 下乱入）
  if (!isEffortLevel(raw) && !listEffortChoosable(dialect as string | undefined, { model }).includes(raw)) {
    return {
      ok: false,
      message:
        `Invalid effort "${rawIn}". Usage: /effort [list | auto|…] — see choosable below.\n` +
        formatEffortCapabilityStatus({
          effortLevel: session.effortLevel,
          dialect: dialect as string | undefined,
          isAgent: true,
          model,
        }),
    }
  }

  session.effortLevel = check.intent
  return {
    ok: true,
    message:
      `effort set to ${check.intent}\n` +
      formatEffortCapabilityStatus({
        effortLevel: check.intent,
        dialect: dialect as string | undefined,
        isAgent: true,
        model,
      }),
  }
}

/**
 * /ultrathink [off|tip|turn] — CX8 产品糖（默认 off）。
 * tip：检测关键词提示 /effort high；turn：本轮抬 high，不写 session.effortLevel。
 */
function cmdUltrathink(session: SlashSession, args: string): SlashDispatchResult {
  const raw = args.trim().toLowerCase()
  const effective = resolveUltrathinkMode({
    sessionMode: session.ultrathinkMode,
  })

  if (!raw || raw === 'status' || raw === 'show') {
    return {
      ok: true,
      message:
        formatUltrathinkStatus(effective) +
        (session.ultrathinkMode
          ? `\nsession override: ${session.ultrathinkMode}`
          : '\nsession override: (none — using env/config/default off)'),
    }
  }

  const next = normalizeUltrathinkMode(raw)
  if (!next) {
    return {
      ok: false,
      message:
        `Invalid ultrathink mode "${args.trim()}". Usage: /ultrathink [off|tip|turn]\n` +
        formatUltrathinkStatus(effective),
    }
  }

  if (next === 'off') {
    session.ultrathinkMode = undefined
  } else {
    session.ultrathinkMode = next
  }

  return {
    ok: true,
    message:
      `ultrathink set to ${next}` +
      (next === 'off' ? ' (session override cleared)' : '') +
      '\n' +
      formatUltrathinkStatus(next),
  }
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

function cmdWebSearch(
  session: SlashSession,
  args: string,
): SlashDispatchResult {
  const raw = args.trim().toLowerCase()
  const current = session.webSearch ?? 'auto'

  const dialectId = detectWebSearchDialectId({
    kind: session.providerProfile?.kind,
    baseUrl: session.providerProfile?.baseUrl,
    model: session.model,
  })
  const hasDirectSearch =
    session.tools?.some((tool) => tool.name === 'WebSearch') === true

  if (!raw) {
    const plan = resolveWebSearchPlan(dialectId, current, {
      model: session.model,
    })
    // 未配置不是故障；说清现状 + 一步怎么开
    const status = plan.enabled
      ? `on via ${plan.dialect.label}`
      : hasDirectSearch && current !== 'off'
        ? 'on via configured SearXNG direct JSON'
        : dialectId === 'off'
          ? `not set up on this endpoint — configure search.searxng or add a search MCP server`
        : `off (${plan.dialect.label})`
    return {
      ok: true,
      message: `websearch: intent=${current} · ${status}
Usage: /websearch [on|off|auto]`,
    }
  }

  if (raw !== 'on' && raw !== 'off' && raw !== 'auto') {
    return {
      ok: false,
      message: `Invalid web search mode "${args.trim()}". Usage: /websearch [on|off|auto]`,
    }
  }

  session.webSearch = raw
  const plan = resolveWebSearchPlan(dialectId, raw, { model: session.model })
  if (hasDirectSearch) {
    return {
      ok: true,
      message:
        raw === 'off'
          ? 'websearch set to off (configured SearXNG tool hidden)'
          : `websearch set to ${raw} (configured SearXNG direct JSON)`,
    }
  }
  if (raw === 'on' && !plan.enabled) {
    // 用户明确要开、这条线路给不了：说明原因，而不是假装设置成功了
    return {
      ok: true,
      message: `websearch: intent=on, but ${plan.unsupportedReason ?? 'this endpoint has no hosted web search'}`,
    }
  }
  return {
    ok: true,
    message: `websearch set to ${raw}${plan.enabled ? ` (${plan.dialect.label})` : ''}`,
  }
}

function cmdPlan(session: SlashSession, _args: string): SlashDispatchResult {
  // HKP-3：plan 正交开关——保持原权限模式，仅激活规划态（只读强制）
  session.planMode = true
  return { ok: true, message: 'plan mode activated (read-only; permission mode unchanged)' }
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

  const {
    listActiveAgents,
    loadAgentsDir,
    builtinAgentMap,
    defaultAgentPolicy,
  } = await import('./subagent.ts')
  let active = session.agentDefinitions
  if (!active || !Object.keys(active).length) {
    const loaded = await loadAgentsDir({ cwd: session.cwd })
    active = loaded.active
  }
  const agents = listActiveAgents(active ?? builtinAgentMap())
  const policy = session.agentPolicy ?? defaultAgentPolicy()
  if (!agents.length) {
    return {
      ok: true,
      message: [
        'No agent types.',
        'Place markdown under .bolo/agents/ (or ~/.bolo/agents/).',
        formatAgentsPolicyBlock(policy),
        'See docs/SUBAGENT.md · docs/SUBAGENT_SPEC.md.',
      ].join('\n'),
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
      const ban =
        a.disallowedTools?.length
          ? ` ban=${a.disallowedTools.join(',')}`
          : ''
      const mt = a.maxTurns != null ? ` maxTurns=${a.maxTurns}` : ''
      const msd =
        a.maxSpawnDepth != null ? ` maxSpawnDepth=${a.maxSpawnDepth}` : ''
      const mod = a.model?.trim() ? ` model=${a.model.trim()}` : ''
      const eft = a.effort?.trim() ? ` effort=${a.effort.trim()}` : ''
      const when = a.whenToUse?.trim()
        ? `\n    when: ${a.whenToUse.trim()}`
        : ''
      return `  ${a.agentType}  [${src}]${mode}${mt}${msd}${mod}${eft}${ban}\n    ${a.description}${when}\n    tools: ${tools}`
    }),
    '',
    formatAgentsPolicyBlock(policy),
    'Dirs: .bolo/agents/*.md  ·  ~/.bolo/agents/*.md  ·  project overrides builtin',
    'Agent tool: subagent_type · description · model · effort · max_turns · isolation · run_in_background',
    'Background: /agents status  ·  /bg',
    'Docs: docs/SUBAGENT_SPEC.md',
  ]
  return { ok: true, message: lines.join('\n') }
}

function formatAgentsPolicyOneLiner(
  policy?: import('./subagent.ts').AgentPolicy,
): string {
  if (!policy) return '(default: enabled maxSpawnDepth=0)'
  const on = policy.enabled ? 'on' : 'off'
  return `enabled=${on}  maxConcurrent=${policy.maxConcurrent}  maxSpawnDepth=${policy.maxSpawnDepth}  defaultModel=${policy.defaultModel}${policy.defaultEffort ? `  defaultEffort=${policy.defaultEffort}` : ''}  overflow=${policy.overflow}`
}

function formatAgentsPolicyBlock(
  policy: import('./subagent.ts').AgentPolicy,
): string {
  return [
    'Policy (config.agents):',
    `  enabled=${policy.enabled}  maxConcurrent=${policy.maxConcurrent}  maxSpawnDepth=${policy.maxSpawnDepth}`,
    `  defaultModel=${policy.defaultModel}${policy.defaultEffort ? `  defaultEffort=${policy.defaultEffort}` : ''}  overflow=${policy.overflow}`,
    '  note: maxSpawnDepth=0 → only primary may spawn; type frontmatter may raise per agent',
  ].join('\n')
}

async function cmdBg(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  const {
    cancelQueuedBackgroundAgent,
    formatBackgroundAgentsStatus,
  } = await import('./subagent.ts')
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts[0]?.toLowerCase() === 'cancel') {
    const taskId = parts[1]?.trim() ?? ''
    if (!taskId) {
      return {
        ok: false,
        message: 'Usage: /bg cancel <taskId>',
      }
    }
    if (!session.backgroundAgents) {
      return {
        ok: false,
        message: 'No background agent store on session.',
      }
    }
    const cancelled = await cancelQueuedBackgroundAgent(
      session.backgroundAgents,
      taskId,
    )
    if (!cancelled.ok) {
      return { ok: false, message: cancelled.detail }
    }
    return {
      ok: true,
      message:
        `Cancelled queued background task ${taskId}.` +
        (cancelled.persistenceWarning
          ? `\nWarning: ${cancelled.persistenceWarning}`
          : ''),
    }
  }
  if (parts.length > 0 && parts[0]?.toLowerCase() !== 'status') {
    return {
      ok: false,
      message: 'Usage: /bg [status] | /bg cancel <taskId>',
    }
  }
  const agentsStatus = formatBackgroundAgentsStatus(
    session.backgroundAgents,
  )
  const shellsStatus = formatBackgroundShellsStatus(session)
  return {
    ok: true,
    message: shellsStatus
      ? `${agentsStatus}${agentsStatus ? '\n' : ''}${shellsStatus}`
      : agentsStatus,
  }
}

/**
 * ROB-3：/bg 的 background shells 段——含 resume 投影的 interrupted（leftover）
 * 记录与输出路径，提醒用户处置；不自动重启任务。
 */
export function formatBackgroundShellsStatus(
  session: SlashSession,
): string {
  if (!session.backgroundShells) return ''
  const records = listBackgroundShells(session.backgroundShells)
  if (records.length === 0) return ''
  const lines = ['Background shells:']
  for (const record of records) {
    lines.push(`  ${formatBackgroundShellStatusLine(record)}`)
    if (record.status === 'interrupted') {
      lines.push(`    output: ${record.outputPath}`)
      lines.push(
        '    (leftover from a previous session; the process may still run — ' +
          'dispose of it or read its output)',
      )
    }
  }
  return lines.join('\n')
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
    const message = filter
      ? `No skills matching "${args.trim()}".`
      : 'No skills loaded. Place SKILL.md under .bolo/skills/<id>/ or use bundled creators.'
    return {
      ok: true,
      message,
      overlayView: {
        kind: 'picker',
        title: 'Skills',
        items: [],
        emptyMessage: message,
      },
    }
  }

  const window =
    typeof session.resolvedModel?.contextWindowTokens === 'number' &&
    session.resolvedModel.contextWindowTokens > 0
      ? session.resolvedModel.contextWindowTokens
      : typeof session.contextWindowTokens === 'number' &&
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
  return {
    ok: true,
    message: lines.join('\n'),
    overlayView: {
      kind: 'picker',
      title: filter ? `Skills matching "${args.trim()}"` : 'Skills',
      items: list.map((skill) => {
        const flags: string[] = []
        if (skill.meta.disableModelInvocation === true) {
          flags.push('no-model')
        }
        if (skill.meta.userInvocable === false) {
          flags.push('no-user')
        }
        const flagText = flags.length ? ` [${flags.join(',')}]` : ''
        const description = skill.meta.description
          ? ` — ${skill.meta.description}`
          : ''
        return {
          id: skill.meta.id,
          label:
            `/${skill.meta.id} [${skill.source}]${flagText}` +
            description,
        }
      }),
    },
  }
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

function historyDisplay(
  tone: SlashDisplayTone = 'info',
): SlashDisplayPolicy {
  return {
    surface: 'history',
    tone,
    persistence: 'visual-only',
  }
}

function panelDisplay(
  key: string,
  options: {
    ttlMs?: number
    overflow?: 'compact' | 'pager'
  } = {},
): SlashDisplayPolicy {
  return {
    surface: 'panel',
    key,
    placement: 'below-composer',
    dismissOnInput: true,
    dismissOnEscape: true,
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
    overflow: options.overflow ?? 'compact',
  }
}

function toastDisplay(
  key: string,
  tone: SlashDisplayTone = 'success',
  ttlMs = 5_000,
): SlashDisplayPolicy {
  return {
    surface: 'toast',
    key,
    tone,
    ttlMs,
  }
}

function overlayDisplay(
  key: string,
  view: 'picker' | 'pager' | 'diff',
): SlashDisplayPolicy {
  return {
    surface: 'overlay',
    key,
    view,
  }
}

function displayOnResult(
  success: SlashDisplayPolicy,
  errorKey: string,
): SlashCommandDef['display'] {
  return (_args, result) =>
    result.ok ? success : toastDisplay(errorKey, 'error', 8_000)
}

function displayShowOrUpdate(
  show: SlashDisplayPolicy,
  update: SlashDisplayPolicy,
  errorKey: string,
): SlashCommandDef['display'] {
  return (args, result) => {
    if (!result.ok) return toastDisplay(errorKey, 'error', 8_000)
    return args.trim() ? update : show
  }
}

const contextDisplay: SlashCommandDef['display'] = (args, result) => {
  if (!result.ok) return toastDisplay('slash:context:error', 'error', 8_000)
  const action = args.trim().toLowerCase()
  return (
    action === 'details' ||
    action === 'detail' ||
    action === '--details'
  )
    ? overlayDisplay('slash:context:details', 'pager')
    : panelDisplay('slash:context', { ttlMs: 12_000 })
}

const diffDisplay: SlashCommandDef['display'] = (_args, result) => {
  if (!result.ok) return toastDisplay('slash:diff:error', 'error', 8_000)
  return result.overlayView?.kind === 'diff'
    ? overlayDisplay('slash:diff', 'diff')
    : panelDisplay('slash:diff', { overflow: 'pager' })
}

const pluginsDisplay: SlashCommandDef['display'] = (args, result) => {
  if (!result.ok) return toastDisplay('slash:plugins:error', 'error', 8_000)
  const parts = args.trim().split(/\s+/u).filter(Boolean)
  const action = parts[0]?.toLowerCase() || 'list'
  const marketAction = parts[1]?.toLowerCase() || 'list'
  if (
    action === 'reload' ||
    action === 'refresh' ||
    action === 'install' ||
    action === 'uninstall' ||
    action === 'remove'
  ) {
    const canonicalAction =
      action === 'refresh'
        ? 'reload'
        : action === 'remove'
          ? 'uninstall'
          : action
    return toastDisplay(`slash:plugins:${canonicalAction}`)
  }
  if (
    (action === 'market' || action === 'marketplace') &&
    (marketAction === 'add' || marketAction === 'register')
  ) {
    return toastDisplay('slash:plugins:market:add')
  }
  if (action === 'commands' || action === 'cmds') {
    return overlayDisplay('slash:plugins:commands', 'picker')
  }
  if (action === 'search') {
    return overlayDisplay('slash:plugins:search', 'picker')
  }
  if (action === 'market' || action === 'marketplace') {
    return overlayDisplay('slash:plugins:market', 'picker')
  }
  return overlayDisplay('slash:plugins', 'picker')
}

const providerDisplay: SlashCommandDef['display'] = (args, result) => {
  if (!result.ok) return toastDisplay('slash:provider:error', 'error', 8_000)
  if (
    result.overlayView?.kind === 'action-picker' &&
    result.overlayView.action === 'provider'
  ) {
    return overlayDisplay('slash:provider', 'picker')
  }
  const parts = args.trim().split(/\s+/u).filter(Boolean)
  const action = parts[0]?.toLowerCase()
  const detail = parts[1]?.toLowerCase()
  const readOnly =
    !action ||
    action === 'list' ||
    action === 'show' ||
    action === 'ls' ||
    action === 'help' ||
    action === '?' ||
    ((action === 'add' || action === 'new') &&
      (!detail ||
        detail === 'list' ||
        detail === 'show' ||
        detail === 'ls'))
  return readOnly
    ? panelDisplay('slash:provider', { overflow: 'pager' })
    : toastDisplay('slash:provider:update')
}

const effortDisplay: SlashCommandDef['display'] = (args, result) => {
  if (!result.ok) return toastDisplay('slash:effort:error', 'error', 8_000)
  if (
    result.overlayView?.kind === 'action-picker' &&
    result.overlayView.action === 'effort'
  ) {
    return overlayDisplay('slash:effort', 'picker')
  }
  const action = args.trim().toLowerCase()
  return !action ||
    action === 'list' ||
    action === 'show' ||
    action === 'ls'
    ? panelDisplay('slash:effort', { overflow: 'pager' })
    : toastDisplay('slash:effort:update')
}

function themePickerItems(): SlashOverlayItem[] {
  return TUI_THEME_IDS.map((id) => ({ id, label: tuiThemeLabel(id) }))
}

function currentThemeIndex(): number {
  const raw = process.env.BOLO_THEME?.trim().toLowerCase()
  if (raw && isTuiThemeId(raw)) {
    return TUI_THEME_IDS.indexOf(raw as TuiThemeId)
  }
  return 0
}

function cmdTheme(_session: SlashSession, args: string): SlashDispatchResult {
  const raw = args.trim().toLowerCase()
  if (
    raw === 'list' ||
    raw === 'show' ||
    raw === 'ls' ||
    raw === 'help' ||
    raw === '?'
  ) {
    const lines = TUI_THEME_IDS.map(
      (id) => `  ${id} — ${tuiThemeLabel(id)}`,
    )
    return { ok: true, message: `TUI themes:\n${lines.join('\n')}` }
  }
  if (raw && !isTuiThemeId(raw)) {
    return {
      ok: false,
      message: `unknown theme "${raw}" (default | amber | neon | dim | plain)`,
    }
  }
  const initialIndex = raw && isTuiThemeId(raw) ? TUI_THEME_IDS.indexOf(raw as TuiThemeId) : currentThemeIndex()
  return {
    ok: true,
    message: 'Select theme (↑/↓ preview · Enter apply · q cancel)',
    overlayView: {
      kind: 'action-picker' as const,
      action: 'theme' as const,
      title: 'Select theme',
      items: themePickerItems(),
      initialIndex: Math.max(0, initialIndex),
    },
  }
}

const themeDisplay: SlashCommandDef['display'] = (args, result) => {
  if (!result.ok) return toastDisplay('slash:theme:error', 'error', 8_000)
  if (
    result.overlayView?.kind === 'action-picker' &&
    result.overlayView.action === 'theme'
  ) {
    return overlayDisplay('slash:theme', 'picker')
  }
  const action = args.trim().toLowerCase()
  return !action ||
    action === 'list' ||
    action === 'show' ||
    action === 'ls' ||
    action === 'help' ||
    action === '?'
    ? panelDisplay('slash:theme', { overflow: 'pager' })
    : toastDisplay('slash:theme:error')
}

const backgroundDisplay: SlashCommandDef['display'] = (args, result) => {
  if (!result.ok) return toastDisplay('slash:bg:error', 'error', 8_000)
  return args.trim().toLowerCase().startsWith('cancel ')
    ? toastDisplay('slash:bg:cancel')
    : panelDisplay('slash:bg')
}

/** 内置注册表（组内顺序即 /help 组内列表顺序） */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'help',
    summary: 'List slash commands (grouped)',
    display: displayOnResult(
      panelDisplay('slash:help', { overflow: 'pager' }),
      'slash:help:error',
    ),
    group: 'diagnostics',
    run: cmdHelp,
  },
  {
    name: 'clear',
    summary: 'Clear conversation messages (keep id/cwd/system)',
    display: displayOnResult(
      toastDisplay('slash:clear'),
      'slash:clear:error',
    ),
    group: 'session',
    run: cmdClear,
  },
  {
    name: 'title',
    summary: 'Show or set session title (jsonl title entry; not model-visible)',
    usage: '[text]',
    display: displayShowOrUpdate(
      panelDisplay('slash:title'),
      toastDisplay('slash:title:update'),
      'slash:title:error',
    ),
    group: 'session',
    run: cmdTitle,
  },
  {
    name: 'note',
    summary:
      'List or append system_note (jsonl; not model-visible; rewrite keeps notes)',
    usage: '[[kind:]text]',
    display: displayShowOrUpdate(
      panelDisplay('slash:note', { overflow: 'pager' }),
      historyDisplay('success'),
      'slash:note:error',
    ),
    group: 'session',
    run: cmdNote,
  },
  {
    name: 'compact',
    summary: 'Summarize conversation (needs CompactSummarizer)',
    usage: '[note]',
    display: displayOnResult(
      historyDisplay('success'),
      'slash:compact:error',
    ),
    group: 'session',
    run: cmdCompact,
  },
  {
    name: 'autocompact',
    summary: 'Show or set session auto compact (on/off)',
    usage: '[on|off]',
    display: displayShowOrUpdate(
      panelDisplay('slash:autocompact'),
      toastDisplay('slash:autocompact:update'),
      'slash:autocompact:error',
    ),
    group: 'session',
    run: cmdAutocompact,
  },
  {
    name: 'context',
    summary: 'Context stats: msgs, chars, token est, sections, cache tip, usage',
    usage: '[details]',
    display: contextDisplay,
    group: 'session',
    run: cmdContext,
  },
  {
    name: 'turn',
    summary: 'Inspect/control active turn and queued prompts',
    usage: '[status | steer <text> | interrupt | queue <text> | cancel <id>]',
    display: displayOnResult(
      historyDisplay(),
      'slash:turn:error',
    ),
    group: 'session',
    run: cmdTurn,
  },
  {
    name: 'runtime',
    summary:
      'Protocol v1 runtime inspect/control/edit/remove/discard/retry-safe',
    usage:
      '[list [turn|control|task]|json|inspect <turn|control|task> <id>|interrupt <turnId>|cancel <control|task> <id>|edit <controlId> <prompt>|remove <controlId>|discard <turn|control|task> <id>|retry-safe <turn|control|task> <id>]',
    display: displayOnResult(
      historyDisplay(),
      'slash:runtime:error',
    ),
    group: 'session',
    run: cmdRuntime,
  },
  {
    name: 'cost',
    summary: 'Show session token usage (local only)',
    display: displayOnResult(
      panelDisplay('slash:cost'),
      'slash:cost:error',
    ),
    group: 'session',
    run: cmdCost,
  },
  {
    name: 'doctor',
    summary: 'Local diagnostics (node, cwd, mode, tools, usage, ~/.bolo)',
    display: displayOnResult(
      panelDisplay('slash:doctor', { overflow: 'pager' }),
      'slash:doctor:error',
    ),
    group: 'diagnostics',
    run: cmdDoctor,
  },
  {
    name: 'diff',
    summary:
      'File changes; TTY opens panel (U1). /diff last · git [path] · <path>',
    usage: '[last | git [path] | <path>]',
    display: diffDisplay,
    group: 'session',
    run: cmdDiff,
  },
  {
    name: 'usage',
    summary: 'Alias of /cost',
    display: displayOnResult(
      panelDisplay('slash:cost'),
      'slash:cost:error',
    ),
    group: 'session',
    hidden: true,
    run: cmdCost,
  },
  {
    name: 'memory',
    summary: 'Long-term MEMORY.md path, status, topics, preview',
    usage: '[path|status|topics]',
    display: displayOnResult(
      panelDisplay('slash:memory', { overflow: 'pager' }),
      'slash:memory:error',
    ),
    group: 'session',
    run: cmdMemory,
  },
  {
    name: 'status',
    summary: 'Alias of /doctor',
    display: displayOnResult(
      panelDisplay('slash:doctor', { overflow: 'pager' }),
      'slash:doctor:error',
    ),
    group: 'diagnostics',
    hidden: true,
    run: cmdDoctor,
  },
  {
    name: 'mcp',
    summary: 'List MCP servers, status/diagnostics, tools, resources, prompts',
    usage: '[status|tools|resources|prompts]',
    display: displayOnResult(
      overlayDisplay('slash:mcp', 'pager'),
      'slash:mcp:error',
    ),
    group: 'extensions',
    run: cmdMcp,
  },
  {
    name: 'plugins',
    summary:
      'Plugins + minimal marketplace (list/reload/market/search/install)',
    usage:
      '[list|commands|reload|market|search|install|uninstall]',
    display: pluginsDisplay,
    group: 'extensions',
    run: cmdPlugins,
  },
  {
    name: 'reload-plugins',
    summary: 'Alias of /plugins reload',
    display: displayOnResult(
      toastDisplay('slash:plugins:reload'),
      'slash:plugins:error',
    ),
    group: 'extensions',
    hidden: true,
    run: (session) => cmdPluginsReload(session),
  },
  {
    name: 'hooks',
    summary: 'List hooks; /hooks recent|failures for diag; /hooks <Event>',
    usage: '[EventName|recent|failures]',
    display: displayOnResult(
      overlayDisplay('slash:hooks', 'pager'),
      'slash:hooks:error',
    ),
    group: 'extensions',
    run: cmdHooks,
  },
  {
    name: 'init',
    summary: 'Ensure ~/.bolo and project .bolo layout (scaffold)',
    usage: '[all|user|project]',
    display: displayOnResult(
      historyDisplay('success'),
      'slash:init:error',
    ),
    group: 'diagnostics',
    run: cmdInit,
  },
  {
    name: 'model',
    summary: 'Show or set model; optional providerId/model sugar',
    usage: '[name | providerId/model]',
    display: displayShowOrUpdate(
      panelDisplay('slash:model'),
      toastDisplay('slash:model:update'),
      'slash:model:error',
    ),
    group: 'model',
    run: cmdModel,
  },
  {
    name: 'provider',
    summary:
      'TTY pick / list / hot-switch / add preset (config.providers)',
    usage: '[list | use <id> [model] | add <preset> [as <id>]]',
    display: providerDisplay,
    group: 'model',
    run: cmdProvider,
  },
  {
    name: 'effort',
    summary:
      'TTY pick / show / set reasoning effort (dialect wire; docs/EFFORT.md)',
    usage: '[list | auto|low|medium|high|xhigh|max|…]',
    display: effortDisplay,
    group: 'model',
    run: cmdEffort,
  },
  {
    name: 'theme',
    summary:
      'Pick / list TUI theme (default=aurora, amber, neon, dim, plain); ↑/↓ live preview',
    usage: '[list]',
    display: themeDisplay,
    group: 'model',
    run: cmdTheme,
  },
  {
    name: 'ultrathink',
    summary:
      'CX8 sugar: off (default) | tip (hint /effort high) | turn (this-turn high)',
    usage: '[off|tip|turn]',
    display: displayShowOrUpdate(
      panelDisplay('slash:ultrathink'),
      toastDisplay('slash:ultrathink:update'),
      'slash:ultrathink:error',
    ),
    group: 'model',
    run: cmdUltrathink,
  },
  {
    name: 'thinking',
    summary:
      'Show/hide thinking display; /thinking persist on|off for openai-compatible refeed',
    usage: '[on|off] | persist [on|off]',
    display: displayShowOrUpdate(
      panelDisplay('slash:thinking'),
      toastDisplay('slash:thinking:update'),
      'slash:thinking:error',
    ),
    group: 'model',
    run: cmdThinking,
  },
  {
    name: 'websearch',
    summary: 'Show or set web search mode',
    usage: '[on|off|auto]',
    display: displayShowOrUpdate(
      panelDisplay('slash:websearch'),
      toastDisplay('slash:websearch:update'),
      'slash:websearch:error',
    ),
    group: 'model',
    run: cmdWebSearch,
  },
  {
    name: 'plan',
    summary: 'Set permissionMode to plan',
    display: displayOnResult(
      toastDisplay('slash:plan'),
      'slash:plan:error',
    ),
    group: 'model',
    run: cmdPlan,
  },
  {
    name: 'permissions',
    summary: 'Show or set permission mode (four tiers)',
    usage: '[mode]',
    display: displayShowOrUpdate(
      panelDisplay('slash:permissions'),
      toastDisplay('slash:permissions:update'),
      'slash:permissions:error',
    ),
    group: 'model',
    run: cmdPermissions,
  },
  {
    name: 'allow',
    summary: 'List or add session always-allow (tool / path:glob / bash:pattern)',
    usage: '[ToolName | path:GLOB | bash:PATTERN]',
    display: displayOnResult(
      historyDisplay(),
      'slash:allow:error',
    ),
    group: 'model',
    run: cmdAllow,
  },
  {
    name: 'deny',
    summary:
      'List or add session always-deny (hard; wins over bypass / allow)',
    usage: '[ToolName | path:GLOB | bash:PATTERN | prefix:PFX]',
    display: displayOnResult(
      historyDisplay(),
      'slash:deny:error',
    ),
    group: 'model',
    run: cmdDeny,
  },
  {
    name: 'rules',
    summary: 'List or show loaded .bolo/rules',
    usage: '[list|show <name>]',
    display: displayOnResult(
      overlayDisplay('slash:rules', 'pager'),
      'slash:rules:error',
    ),
    group: 'extensions',
    run: cmdRules,
  },
  {
    name: 'skills',
    summary: 'List loaded skills (catalog)',
    usage: '[filter]',
    display: displayOnResult(
      overlayDisplay('slash:skills', 'picker'),
      'slash:skills:error',
    ),
    group: 'extensions',
    run: cmdSkills,
  },
  {
    name: 'agents',
    summary: 'List active subagent types; status for background runs',
    usage: '[status]',
    display: displayOnResult(
      panelDisplay('slash:agents'),
      'slash:agents:error',
    ),
    group: 'extensions',
    run: cmdAgents,
  },
  {
    name: 'bg',
    summary: 'List background tasks or cancel a queued task',
    usage: '[status] | cancel <taskId>',
    display: backgroundDisplay,
    group: 'extensions',
    run: cmdBg,
  },
  {
    name: 'skill',
    summary: 'Load a skill body into the conversation by id',
    usage: '<id>',
    display: displayOnResult(
      historyDisplay('success'),
      'slash:skill:error',
    ),
    group: 'extensions',
    run: cmdSkill,
  },
]

export type SlashCommandCandidateSource = 'builtin' | 'plugin' | 'skill'

export type SlashCommandCandidate = {
  name: string
  description: string
  usage?: string
  argumentHint?: string
  source: SlashCommandCandidateSource
  sourceLabel?: string
  hidden?: boolean
}

export type SlashCommandCandidateSession = Pick<
  SlashSession,
  | 'pluginCommands'
  | 'skills'
  | 'effortDialect'
  | 'providerProfile'
  | 'provider'
  | 'model'
>

function formatEffortSlashArgumentHint(
  session: SlashCommandCandidateSession,
): string | undefined {
  const choices = listEffortChoosable(
    resolveSessionEffortDialect(session) as string | undefined,
    {
      isAgent: true,
      model: session.model ?? session.providerProfile?.model,
    },
  )
  if (!choices.length) return undefined
  const ordered = choices.filter((choice) => choice !== 'auto')
  if (choices.includes('auto')) ordered.push('auto')
  return `[${ordered.join('|')}]`
}

function normalizeSlashCandidateName(value: string): string {
  const name = value.trim().replace(/^\/+/, '').toLowerCase()
  return name && !/\s/u.test(name) ? name : ''
}

/**
 * Project the executable slash registry into display-only candidates.
 * Ordering follows dispatch precedence: built-in, plugin, then skill.
 */
export function getSlashCommandCandidates(
  session: SlashCommandCandidateSession,
): SlashCommandCandidate[] {
  const candidates: SlashCommandCandidate[] = []
  const seen = new Set<string>()
  const add = (candidate: SlashCommandCandidate) => {
    const name = normalizeSlashCandidateName(candidate.name)
    if (!name || seen.has(name)) return
    seen.add(name)
    candidates.push({ ...candidate, name })
  }

  for (const command of SLASH_COMMANDS) {
    const argumentHint =
      command.name === 'effort'
        ? formatEffortSlashArgumentHint(session)
        : command.usage
    add({
      name: command.name,
      description: command.summary,
      ...(command.usage ? { usage: command.usage } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      source: 'builtin',
      ...(command.hidden ? { hidden: true } : {}),
    })
  }
  for (const command of session.pluginCommands ?? []) {
    add({
      name: command.name,
      description:
        command.description?.trim() ||
        `Command contributed by plugin ${command.pluginId}`,
      source: 'plugin',
      sourceLabel: command.pluginId,
    })
  }
  for (const skill of session.skills ?? []) {
    if (!isSkillUserInvocable(skill)) continue
    add({
      name: skill.meta.id,
      description:
        skill.meta.description?.trim() ||
        skill.meta.whenToUse?.trim() ||
        `Load skill ${skill.meta.name}`,
      source: 'skill',
      sourceLabel: skill.source,
    })
  }
  return candidates
}

/**
 * Filter a complete command token. The first release deliberately supports
 * exact/prefix discovery only; arguments and `//` prompts close the menu.
 */
export function filterSlashCommandCandidates(
  candidates: readonly SlashCommandCandidate[],
  query: string,
): SlashCommandCandidate[] {
  if (!query.startsWith('/') || query.startsWith('//')) return []
  const needle = query.slice(1).toLowerCase()
  if (/\s/u.test(needle)) return []

  const matches = candidates.filter((candidate) => {
    if (!needle && candidate.hidden) return false
    return candidate.name.toLowerCase().startsWith(needle)
  })
  if (!needle) return matches
  return matches.sort((left, right) => {
    const leftExact = left.name.toLowerCase() === needle ? 0 : 1
    const rightExact = right.name.toLowerCase() === needle ? 0 : 1
    return leftExact - rightExact
  })
}

const COMMAND_MAP = new Map(SLASH_COMMANDS.map((c) => [c.name, c]))

export function getSlashCommand(name: string): SlashCommandDef | undefined {
  return COMMAND_MAP.get(name.toLowerCase())
}

export type PreviewSlashCommandDisplay = {
  readonly name: string
  readonly args: string
  readonly display: SlashDisplayPolicy
}

/**
 * Resolves a built-in command's success surface without running its handler.
 * Display resolvers must stay pure; dynamic Plugin/Skill fallbacks return undefined.
 */
export function previewSlashCommandDisplay(
  text: string,
): PreviewSlashCommandDisplay | undefined {
  const parsed = parseSlashLine(text)
  if (parsed.kind !== 'command') return undefined
  const command = getSlashCommand(parsed.name)
  if (!command) return undefined
  return {
    name: parsed.name,
    args: parsed.args,
    display: resolveSlashCommandDisplay(command, parsed.args, {
      ok: true,
      message: '',
    }),
  }
}

export async function dispatchSlashCommand(
  session: SlashSession,
  name: string,
  args: string,
): Promise<ResolvedSlashDispatchResult> {
  const cmd = getSlashCommand(name)
  if (cmd) {
    const result = await cmd.run(session, args)
    return {
      ...result,
      display: resolveSlashCommandDisplay(cmd, args, result),
    }
  }

  // 回落：插件 contributes.commands（PL2）
  const pluginHit = invokePluginCommand(session, name)
  if (pluginHit) {
    return {
      ...pluginHit,
      display: normalizeSlashDisplayPolicy(
        pluginHit.display,
        pluginHit.ok ? 'info' : 'error',
      ),
    }
  }

  // 回落：/<skill-id> 或 /skill-creator（user-invocable skill）
  const skills = sessionSkills(session)
  if (skills.length && findSkillById(skills, name)) {
    const result = invokeSkillBySlash(session, name)
    return {
      ...result,
      display: normalizeSlashDisplayPolicy(
        result.display,
        result.ok ? 'info' : 'error',
      ),
    }
  }

  return {
    ok: false,
    message: formatUnknownCommand(name, session),
    display: toastDisplay('slash:unknown', 'error', 8_000),
  }
}

/**
 * 用户输入入口：slash → 本地执行；否则 submitPrompt。
 */
export async function submitUserInput(
  session: SlashSession,
  text: string,
  options?: {
    maxTurns?: number
    querySource?: string
    signal?: AbortSignal
    turnId?: string
  },
): Promise<SubmitUserInputResult> {
  const parsed = parseSlashLine(text)
  if (parsed.kind === 'empty') return { type: 'empty' }

  if (parsed.kind === 'command') {
    const r = await dispatchSlashCommand(session, parsed.name, parsed.args)
    return {
      type: 'slash',
      message: r.message,
      display: r.display,
      ...(r.contextView ? { contextView: r.contextView } : {}),
      ...(r.overlayView ? { overlayView: r.overlayView } : {}),
    }
  }

  const { submitPrompt } = await import('./index.ts')
  const terminal = await submitPrompt(
    session as Parameters<typeof submitPrompt>[0],
    parsed.text,
    options,
  )
  return { type: 'prompt', terminal }
}
