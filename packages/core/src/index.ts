/**
 * Agent Runtime — Session 外壳 + compactSession
 * Agent loop 本体见 queryLoop.ts（对照 HelsincyCode query.ts）
 * 禁止：Electron / DOM / 遥测
 */

import path from 'node:path'
import {
  runFullCompact,
  isAutoCompactEnvDisabled,
  type CompactSummarizer,
  type MicrocompactOptions,
  type SnipOptions,
} from '../../compact/src/index.ts'
import { runHooks } from '../../hooks/src/index.ts'
import {
  createMockProvider,
  createProviderFromEnv,
  createOpenAICompatibleProvider,
  createCompactSummarizerFromProvider,
  type LlmProvider,
} from '../../providers/src/index.ts'
import {
  loadWorkspace,
  type ResolvedWorkspace,
} from '../../config/src/index.ts'
import {
  closeMcpConnections,
  connectMcpServers,
  isMcpManagedToolName,
  mergeSessionToolsWithMcp,
  type ConnectedMcpServer,
  type ConnectMcpResult,
  type McpListChangedEvent,
} from '../../mcp/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import { formatSkillCatalog } from '../../skills/src/index.ts'
import type {
  LoadedPlugin,
  PluginCommand,
} from '../../plugins/src/index.ts'
import type { BoloTool } from '../../tools/src/index.ts'
import {
  newId,
  nowIso,
  type ChatMessage,
  type HooksConfig,
  type SessionPhase,
  type SessionStartSource,
} from '../../shared/src/index.ts'
import {
  composePrepareMessages,
  createAutoCompactPrepare,
  createMicrocompactPrepare,
  createSnipPrepare,
  productionDeps,
  type QueryDeps,
} from './deps.ts'
import { queryLoop, type QueryLoopEvent, type Terminal } from './queryLoop.ts'
import type { AskPermissionFn } from './toolExecution.ts'
import {
  createBackgroundAgentStore,
  createDefaultTools,
  loadAgentsDir,
  type ActiveAgentDefinitions,
} from './subagent.ts'
import {
  createEmptyPermissionRules,
  parsePermissionMode,
  type PermissionMode,
  type SessionPermissionRules,
} from '../../permissions/src/index.ts'
import {
  assembleSessionSystemPrompt,
  replaceSkillCatalogSection,
  type AssembleSessionSystemPromptOptions,
} from './systemPrompt.ts'
import {
  loadBoloRules,
  collectActivePathsFromMessages,
  replaceProjectRulesSection,
} from './rules.ts'
import {
  applySnapshotToSession,
  getSessionPersistMeta,
  loadSession,
  maybeAutoSaveSession,
  resolveSessionFilePath,
  saveSession,
  setSessionPersistMeta,
  type SaveSessionOptions,
  type SessionScope,
  type SessionSnapshot,
} from './sessionPersist.ts'
import {
  writeTranscriptAfterCompact,
} from './sessionTranscript.ts'
import type { SessionUsage } from './sessionUsage.ts'
import {
  cloneSessionUsage,
  createEmptySessionUsage,
} from './sessionUsage.ts'

export type { AskPermissionFn, Terminal }
export type {
  QueryDeps,
  PrepareMessagesFn,
  CallModelFn,
  ModelRetryInfo,
  ModelRetryOptions,
} from './deps.ts'
export {
  productionDeps,
  createCallModelFromProvider,
  createAutoCompactPrepare,
  createMicrocompactPrepare,
  createSnipPrepare,
  composePrepareMessages,
  identityPrepareMessages,
  wrapCallModelWithRetry,
  DEFAULT_MAX_MODEL_RETRIES,
  DEFAULT_MODEL_RETRY_BASE_DELAY_MS,
} from './deps.ts'
export type {
  MicrocompactOptions,
  SnipOptions,
} from '../../compact/src/index.ts'
export {
  microcompactMessages,
  snipMessagesIfNeeded,
  findSafeSnipCutIndex,
  TOOL_RESULT_CLEARED_MESSAGE,
  SNIP_BOUNDARY_CONTENT,
  DEFAULT_MICROCOMPACT_OPTIONS,
  DEFAULT_SNIP_OPTIONS,
  isPromptTooLongError,
  truncateHeadForPtlRetry,
  groupMessagesByApiRound,
  DEFAULT_MAX_PTL_RETRIES,
  PTL_RETRY_MARKER,
  estimateTokens,
  estimateTextTokens,
  estimateMessageTokens,
  estimateSystemSectionsTokens,
  getAutoCompactThreshold,
  getEffectiveContextWindow,
  getContextPressure,
  shouldAutoCompact,
  isAutoCompactEnvDisabled,
  isEnvTruthy,
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_BUFFER_TOKENS,
  DEFAULT_MAX_AUTOCOMPACT_FAILURES,
} from '../../compact/src/index.ts'
export {
  classifyError,
  isRetryableError,
  extractHttpStatus,
  errorMessageOf,
  type ErrorClass,
  type ClassifiedError,
} from './errorClassify.ts'
export { queryLoop } from './queryLoop.ts'
export {
  createEmptySessionUsage,
  cloneSessionUsage,
  accumulateSessionUsage,
  estimateTokensFromChars,
  estimateUsageFromCharCounts,
  estimateUsageFromTexts,
  normalizeProviderUsage,
  formatSessionUsage,
  formatUsageOneLiner,
  type SessionUsage,
  type ModelUsageBucket,
  type UsageDelta,
} from './sessionUsage.ts'
export { runTools, partitionToolCalls } from './toolOrchestration.ts'
export { runToolUse } from './toolExecution.ts'
export { StreamingToolExecutor } from './streamingToolExecutor.ts'
export type { PermissionMode, SessionPermissionRules } from '../../permissions/src/index.ts'
export {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  truncateToolResultOutput,
} from './toolExecution.ts'
export {
  loadBoloMd,
  getSystemPrompt,
  getSystemPromptPartition,
  getCacheStableSections,
  getCacheStablePrefix,
  getVolatileSections,
  partitionSystemPromptSections,
  buildEffectiveSystemPrompt,
  prepareModelMessages,
  assembleSessionSystemPrompt,
  replaceSkillCatalogSection,
  systemSectionsToMessages,
  boloMdCandidatePaths,
  permissionModeBehaviorLine,
  BOLO_MD_MAX_CHARS_PER_FILE,
  BOLO_MD_MAX_TOTAL_CHARS,
} from './systemPrompt.ts'
export type {
  SystemPromptPartition,
  GetSystemPromptOptions,
  SystemPromptEnv,
} from './systemPrompt.ts'
export {
  loadBoloRules,
  parseRuleFrontmatter,
  collectRuleCandidates,
  matchRulePathGlob,
  activePathsMatchGlobs,
  collectActivePathsFromMessages,
  extractPathTokensFromText,
  replaceProjectRulesSection,
  BOLO_RULES_MAX_CHARS_PER_FILE,
  BOLO_RULES_MAX_TOTAL_CHARS,
  type BoloRuleSource,
  type LoadBoloRulesResult,
  type LoadBoloRulesOptions,
  type RuleFrontmatter,
} from './rules.ts'
export {
  createProviderFromEnv,
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  createMockProvider,
  createCompactSummarizerFromProvider,
} from '../../providers/src/index.ts'
export {
  loadWorkspace,
  ensureUserLayout,
  ensureProjectLayout,
  ensureAllLayouts,
  getBoloHomeDir,
  getProjectBoloDir,
} from '../../config/src/index.ts'
export {
  PERMISSION_MODES,
  PERMISSION_MODE_META,
  getNextPermissionMode,
  decidePermission,
  createEmptyPermissionRules,
  matchesAlwaysAllow,
  matchesAlwaysDeny,
  matchPathGlob,
  matchBashPattern,
  addAlwaysAllowToolName,
  addAlwaysAllowPathGlob,
  addAlwaysAllowBashPrefix,
  addAlwaysDenyToolName,
  addAlwaysDenyPathGlob,
  addAlwaysDenyBashPrefix,
  addAlwaysDenyPrefix,
} from '../../permissions/src/index.ts'
export {
  SESSION_SNAPSHOT_VERSION,
  toSnapshot,
  parseSessionSnapshot,
  saveSession,
  loadSession,
  listProjectSessions,
  sessionPreviewFromMessages,
  resolveSessionFilePath,
  resolveIdOrPath,
  looksLikeSessionPath,
  resolveJsonPathFromTranscript,
  sessionFileName,
  applySnapshotToSession,
  setSessionPersistMeta,
  getSessionPersistMeta,
  maybeAutoSaveSession,
  atomicWriteJson,
  loadSessionPair,
  migrateSessionToJsonl,
  setSessionTitle,
  appendSessionSystemNote,
  type SessionSnapshot,
  type SessionScope,
  type SessionListItem,
  type SaveSessionOptions,
  type LoadSessionOptions,
  type MigrateSessionOptions,
  type PersistableSession,
  type SessionPersistMeta,
} from './sessionPersist.ts'
export {
  appendTranscriptLine,
  ensureTranscriptFile,
  recordSessionMessages,
  appendCompactBoundary,
  appendSessionTitle,
  appendSystemNote,
  dualWriteSessionTranscript,
  writeTranscriptAfterCompact,
  resolveTranscriptPathFromJson,
  resolveTranscriptFilePath,
  sessionTranscriptFileName,
  countTranscriptMessageEntries,
  rewriteTranscriptFromMessages,
  loadTranscriptFile,
  loadTranscriptMessages,
  messagesFromTranscriptEntries,
  titleFromTranscriptEntries,
  systemNotesFromTranscriptEntries,
  normalizeSessionTitle,
  normalizeSystemNoteText,
  buildTitleEntry,
  buildSystemNoteEntry,
  scanTranscriptLite,
  DEFAULT_LITE_SCAN_BYTES,
  getTranscriptWriteState,
  setTranscriptWriteState,
  metaInputFromSession,
  buildMetaEntry,
  type TranscriptEntry,
  type TranscriptMetaEntry,
  type TranscriptMessageEntry,
  type TranscriptCompactBoundaryEntry,
  type TranscriptTitleEntry,
  type TranscriptSystemNoteEntry,
  type TranscriptMetaInput,
  type TranscriptLiteScan,
} from './sessionTranscript.ts'

export type SessionEvent =
  | { type: 'phase'; phase: SessionPhase | string }
  | { type: 'text'; text: string }
  /** 思考链增量（流式展示；不持久化进 transcript） */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: string; ok: boolean }
  | { type: 'permission_request'; id: string; name: string; input: unknown }
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean }
  | { type: 'permission_decision'; mode: string; behavior: string; reason: string }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | {
      type: 'mcp_list_changed'
      server: string
      kind: 'tools' | 'resources' | 'prompts'
      toolCount: number
      resourceCount: number
      promptCount: number
    }
  | {
      type: 'ptl_retry'
      attempt: number
      maxRetries: number
      droppedMessageCount: number
    }
  | {
      type: 'model_retry'
      attempt: number
      maxRetries: number
      delayMs: number
      message: string
      reason: string
      status?: number
    }
  | { type: 'done'; terminal?: Terminal }

export type CreateSessionOptions = {
  cwd: string
  sessionId?: string
  hooks?: HooksConfig
  provider?: LlmProvider
  deps?: QueryDeps
  /** 对照 HC PermissionMode；默认 default（请求批准） */
  permissionMode?: PermissionMode
  askPermission?: AskPermissionFn
  /** 会话 Always-allow 规则；默认空表 */
  permissionRules?: SessionPermissionRules
  /**
   * 会话 effort 档位（/effort）；可选。
   * resume 时由快照恢复。
   */
  effortLevel?: string
  /**
   * 是否在 CLI 显示思考链（/thinking）；默认 true。
   * resume 时由快照恢复；仅影响渲染，不影响 provider 解析。
   */
  showThinking?: boolean
  /**
   * 会话本地 token 累计种子；默认全 0。
   * resume 时由快照恢复（无遥测）。
   */
  usage?: SessionUsage
  /** tool_result 写入 transcript 的字符上限；默认 50_000 */
  maxToolResultChars?: number
  compactSummarizer?: CompactSummarizer
  /** 会话 skill 全文表；默认不进 system，仅 Skill 工具按需加载 */
  skills?: LoadedSkill[]
  /**
   * 是否组装默认 system（身份/环境/BOLO.md/skill catalog）。
   * 默认 true。smoke 可关以保持最短 mock 路径。
   */
  systemPrompt?: boolean | AssembleSessionSystemPromptOptions
  /**
   * 是否在 queryLoop 的 prepareMessages 挂 auto compact（对照参考 autoCompactIfNeeded）。
   * 需同时注入 compactSummarizer；默认 **true**（与 DEFAULT_CONFIG 一致）。
   * 环境变量 `BOLO_DISABLE_AUTO_COMPACT` / `BOLO_DISABLE_COMPACT` 可熔断 auto。
   */
  autoCompactEnabled?: boolean
  /** 模型上下文窗口估计（tokens），用于 auto 阈值；默认 128_000 */
  contextWindowTokens?: number
  /**
   * Microcompact（清旧 tool_result，无 LLM）。
   * 默认启用；`false` 关闭。顺序：snip → micro → auto full。
   */
  microcompact?: MicrocompactOptions | false
  /**
   * Snip（无 LLM，丢过旧前缀，保留尾部）。
   * 默认启用；`false` 关闭。在 micro / auto 之前。
   */
  snip?: SnipOptions | false
  /**
   * callModel / compact summarizer 命中 PTL 时截断重试次数。
   * 默认 3；0 = 关闭。
   */
  maxPtlRetries?: number
  /** 模型名（写入环境段；可从 workspace 传入） */
  model?: string
  source?: SessionStartSource
  onEvent?: (e: SessionEvent) => void
  /**
   * 预加载的 active agent 定义（内置 + 目录）。
   * 未传时 createSession 会按 cwd 调 loadAgentsDir。
   */
  agentDefinitions?: ActiveAgentDefinitions
  /**
   * 每轮 submitPrompt 结束后自动 saveSession。
   * true = project scope；或传 { scope, sessionsDir, filePath }。
   */
  autoSave?: boolean | {
    scope?: SessionScope
    sessionsDir?: string
    filePath?: string
  }
}

export type BoloSession = {
  id: string
  cwd: string
  phase: SessionPhase
  messages: ChatMessage[]
  /**
   * 权威 system 段（对照 HC systemPrompt）。
   * callModel 时由 prepareModelMessages 前缀；对话历史尽量不混入 system。
   */
  systemPromptSections: string[]
  /**
   * 组装 system 时的 userConfigDir（测试/覆盖）；
   * submitPrompt path-scope 刷新 rules 时透传。
   */
  systemPromptUserConfigDir?: string
  /**
   * 是否在 submitPrompt 时按 activePaths 重装 path-scoped rules。
   * 默认 true；createSession(systemPrompt:false) 或显式 loadRules:false 时为 false。
   */
  refreshPathScopedRules?: boolean
  hooks: HooksConfig
  provider: LlmProvider
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  /** 会话 Always-allow（/allow 与 CLI `a`） */
  permissionRules: SessionPermissionRules
  /** tool_result 字符预算（C6） */
  maxToolResultChars: number
  compactSummarizer?: CompactSummarizer
  skills: LoadedSkill[]
  model?: string
  /**
   * 会话级 effort 档位（/effort）。
   * 经 callModel → completeStream options.effort → mapEffort → max_tokens。
   * `undefined` 视为 auto（默认 base maxTokens）。
   */
  effortLevel?: string
  /**
   * 是否在 CLI 渲染思考链（/thinking）。默认 true。
   * false 时 provider 仍解析并转发 reasoning 事件，仅打印机不渲染。
   * 不回灌 ChatMessage。
   */
  showThinking?: boolean
  /** 会话级 auto compact 开关（prepareMessages） */
  autoCompactEnabled: boolean
  contextWindowTokens: number
  /** PTL 截断重试上限；0 = 关 */
  maxPtlRetries: number
  /**
   * 会话内本地 token 累计（/cost）；无遥测。
   * 有 provider usage 事件则累加，否则 chars/4 估算。
   */
  usage?: SessionUsage
  /**
   * 会话工具表（内置 + Agent + 可选 MCP）。
   * 未设置时 submitPrompt 回落 createDefaultTools()。
   */
  tools?: BoloTool[]
  /**
   * 活跃 subagent 定义（内置 + ~/.bolo/agents + .bolo/agents）。
   * Agent 工具 / spawnSubagent 按此 resolve。
   */
  agentDefinitions?: ActiveAgentDefinitions
  /**
   * 后台 subagent 表（Agent run_in_background）。
   * pendingAgents + backgroundAgentResults；/agents status · /bg 读取。
   */
  backgroundAgents?: import('./subagent.ts').BackgroundAgentStore
  /** 已连接的 MCP stdio 进程；endSession 时关闭 */
  mcpConnections?: ConnectedMcpServer[]
  /**
   * workspace 发现的插件列表（PL1/PL2）；供 /plugins。
   * PL2：`/plugins reload` 可热刷新列表与贡献点。
   */
  plugins?: LoadedPlugin[]
  /**
   * 插件贡献的 slash 命令（PL2；contributes.commands / commands/*.md）。
   * 内置 slash 优先；未知名再查此表。
   */
  pluginCommands?: PluginCommand[]
  /**
   * 最近一次 workspace 装载的 merge 错误（插件 hooks/mcp/command 冲突等）。
   * 供 /plugins reload 文案；不写遥测。
   */
  pluginMergeErrors?: string[]
  onEvent: (e: SessionEvent) => void
}

function emit(session: BoloSession, e: SessionEvent) {
  session.onEvent(e)
  if (e.type === 'phase' && isSessionPhase(e.phase)) {
    session.phase = e.phase
  }
}

function isSessionPhase(p: string): p is SessionPhase {
  return (
    p === 'idle' ||
    p === 'starting' ||
    p === 'ready' ||
    p === 'running' ||
    p === 'awaiting_permission' ||
    p === 'compacting' ||
    p === 'stopping' ||
    p === 'ended'
  )
}

function setPhase(session: BoloSession, phase: SessionPhase) {
  emit(session, { type: 'phase', phase })
}

function mapLoopEvent(session: BoloSession, e: QueryLoopEvent) {
  if (e.type === 'phase') {
    emit(session, { type: 'phase', phase: e.phase })
    return
  }
  if (e.type === 'done') {
    emit(session, { type: 'done', terminal: e.terminal })
    return
  }
  emit(session, e as SessionEvent)
}

export async function createSession(opts: CreateSessionOptions): Promise<BoloSession> {
  const provider = opts.provider ?? createMockProvider()
  const permissionMode = parsePermissionMode(opts.permissionMode, 'default')
  const skills = opts.skills ?? []

  let systemPromptSections: string[] = []
  let systemPromptUserConfigDir: string | undefined
  let refreshPathScopedRules = false
  if (opts.systemPrompt !== false) {
    const extra =
      typeof opts.systemPrompt === 'object' && opts.systemPrompt
        ? opts.systemPrompt
        : {}
    systemPromptUserConfigDir = extra.userConfigDir
    // 默认装载 rules 且非 custom/override 时，submitPrompt 可按 activePaths 刷新 path-scope
    refreshPathScopedRules =
      extra.loadRules !== false &&
      !extra.overrideSystemPrompt &&
      !extra.customSystemPrompt
    systemPromptSections = await assembleSessionSystemPrompt({
      cwd: opts.cwd,
      permissionMode,
      model: opts.model ?? extra.model,
      skills: extra.skills ?? skills,
      skillCatalog: extra.skillCatalog,
      boloMd: extra.boloMd,
      loadInstructions: extra.loadInstructions,
      boloRules: extra.boloRules,
      loadRules: extra.loadRules,
      userConfigDir: extra.userConfigDir,
      activePaths: extra.activePaths,
      mcpPlaceholder: extra.mcpPlaceholder,
      overrideSystemPrompt: extra.overrideSystemPrompt,
      customSystemPrompt: extra.customSystemPrompt,
      appendSystemPrompt: extra.appendSystemPrompt,
      date: extra.date,
      platform: extra.platform,
      shellHint: extra.shellHint,
    })
  }

  const agentDefinitions =
    opts.agentDefinitions ??
    (await loadAgentsDir({ cwd: opts.cwd })).active

  const session: BoloSession = {
    id: opts.sessionId ?? newId('sess'),
    cwd: opts.cwd,
    phase: 'idle',
    messages: [],
    systemPromptSections,
    systemPromptUserConfigDir,
    refreshPathScopedRules,
    hooks: opts.hooks ?? {},
    provider,
    deps: opts.deps ?? productionDeps(provider),
    permissionMode,
    // smoke 可注入；default 模式下 ask 会走到这里。未注入则 deny 更安全；
    // 测试/smoke 显式传 allow。
    askPermission: opts.askPermission ?? (async () => 'deny'),
    permissionRules: opts.permissionRules ?? createEmptyPermissionRules(),
    maxToolResultChars: opts.maxToolResultChars ?? 50_000,
    compactSummarizer: opts.compactSummarizer,
    skills,
    model: opts.model,
    effortLevel:
      typeof opts.effortLevel === 'string' && opts.effortLevel.trim()
        ? opts.effortLevel.trim()
        : undefined,
    showThinking: opts.showThinking === false ? false : true,
    // 默认开 auto（对照参考全局 config）；显式 false 关闭
    autoCompactEnabled: opts.autoCompactEnabled !== false,
    contextWindowTokens: opts.contextWindowTokens ?? 128_000,
    maxPtlRetries:
      opts.maxPtlRetries === undefined
        ? 3
        : Math.max(0, opts.maxPtlRetries),
    agentDefinitions,
    backgroundAgents: createBackgroundAgentStore(),
    tools: createDefaultTools(agentDefinitions),
    usage: opts.usage
      ? cloneSessionUsage(opts.usage)
      : createEmptySessionUsage(),
    onEvent: opts.onEvent ?? (() => {}),
  }

  // 对照参考 query：snip → microcompact → autocompact → callModel
  const microOpts: MicrocompactOptions | undefined =
    opts.microcompact === false
      ? { enabled: false }
      : opts.microcompact === undefined
        ? undefined
        : opts.microcompact
  const snipOpts: SnipOptions | false | undefined =
    opts.snip === false
      ? false
      : opts.snip === undefined
        ? undefined
        : opts.snip

  if (session.autoCompactEnabled && session.compactSummarizer) {
    wireSessionPrepareMessages(session, {
      microcompact: microOpts,
      snip: snipOpts,
    })
  } else if (opts.deps) {
    // 自定义 deps：在其 prepare 前挂 snip → micro（便宜、幂等）
    const snipPrepare = createSnipPrepare(snipOpts)
    const microPrepare = createMicrocompactPrepare(microOpts)
    session.deps = {
      ...session.deps,
      prepareMessages: composePrepareMessages(
        snipPrepare,
        microPrepare,
        opts.deps.prepareMessages,
      ),
    }
  } else if (
    opts.microcompact === false ||
    opts.microcompact !== undefined ||
    opts.snip === false ||
    opts.snip !== undefined
  ) {
    // 覆盖 productionDeps 默认 snip/micro 配置
    session.deps = {
      ...session.deps,
      prepareMessages: composePrepareMessages(
        createSnipPrepare(snipOpts),
        createMicrocompactPrepare(microOpts),
      ),
    }
  } else if (session.autoCompactEnabled && !session.compactSummarizer) {
    // 默认 auto 开但无 summarizer：仍 snip → micro（productionDeps 默认）
  }
  // 否则：productionDeps 已默认 snip → micro

  if (opts.autoSave) {
    const as =
      opts.autoSave === true
        ? { scope: 'project' as SessionScope }
        : opts.autoSave
    setSessionPersistMeta(session, {
      autoSave: true,
      scope: as.scope ?? 'project',
      sessionsDir: as.sessionsDir,
      filePath: as.filePath,
    })
  }

  setPhase(session, 'starting')
  const start = await runHooks(
    'SessionStart',
    {
      hook_event_name: 'SessionStart',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      source: opts.source ?? 'startup',
    },
    session.hooks,
  )
  for (const r of start.results) {
    emit(session, { type: 'hook', event: 'SessionStart', exitCode: r.exitCode })
  }
  // SessionStart 注入作为额外 system 段（不混进对话 user/assistant）
  if (start.injectText?.trim()) {
    session.systemPromptSections = [
      ...session.systemPromptSections,
      start.injectText.trim(),
    ]
  }
  setPhase(session, 'ready')
  return session
}

export type CreateSessionFromWorkspaceOptions = {
  cwd: string
  ensureDefaults?: boolean
  askPermission?: AskPermissionFn
  onEvent?: (e: SessionEvent) => void
  source?: SessionStartSource
  wireCompactSummarizer?: boolean
  /**
   * 是否把 skill catalog 并入 system（默认 true）。
   * skills 全文表始终挂 session.skills 供 Skill 工具使用。
   */
  injectSkills?: boolean
  /** 是否组装 system（默认 true） */
  systemPrompt?: boolean
  /** 覆盖 workspace.config.autoCompactEnabled */
  autoCompactEnabled?: boolean
  /** 覆盖 workspace.config.contextWindowTokens */
  contextWindowTokens?: number
  /** 覆盖 workspace.config.microcompactEnabled；或传入完整 MicrocompactOptions */
  microcompact?: MicrocompactOptions | false
  /** 覆盖 workspace.config.maxPtlRetries */
  maxPtlRetries?: number
  /**
   * 是否连接 workspace.mcpServers（stdio listTools → 注册 mcp__*）。
   * 默认 true；失败只 warn，不炸会话。
   */
  connectMcp?: boolean
  /** MCP 单请求超时（ms） */
  mcpTimeoutMs?: number
}

/**
 * 从 ~/.bolo + 项目 .bolo 装配 Session
 * system 由 assembleSessionSystemPrompt 统一组装（含 BOLO.md + skill catalog）
 * 可选连接 MCP stdio（失败 warn 不炸会话）
 */
export async function createSessionFromWorkspace(
  opts: CreateSessionFromWorkspaceOptions,
): Promise<{
  session: BoloSession
  workspace: ResolvedWorkspace
  mcp?: ConnectMcpResult
}> {
  const workspace = await loadWorkspace({
    cwd: opts.cwd,
    ensureDefaults: opts.ensureDefaults,
  })

  const compactSummarizer =
    opts.wireCompactSummarizer === false
      ? undefined
      : createCompactSummarizerFromProvider(workspace.provider)

  const injectSkills = opts.injectSkills !== false
  const session = await createSession({
    cwd: opts.cwd,
    provider: workspace.provider,
    hooks: workspace.hooks,
    permissionMode: workspace.permissionMode,
    askPermission: opts.askPermission,
    compactSummarizer,
    skills: workspace.skills,
    model: workspace.providerModel,
    source: opts.source,
    onEvent: opts.onEvent,
    autoCompactEnabled:
      opts.autoCompactEnabled ??
      workspace.config.autoCompactEnabled !== false,
    contextWindowTokens:
      opts.contextWindowTokens ??
      workspace.config.contextWindowTokens ??
      128_000,
    microcompact:
      opts.microcompact !== undefined
        ? opts.microcompact
        : workspace.config.microcompactEnabled === false
          ? false
          : undefined,
    maxPtlRetries:
      opts.maxPtlRetries ?? workspace.config.maxPtlRetries,
    systemPrompt:
      opts.systemPrompt === false
        ? false
        : {
            skills: injectSkills ? workspace.skills : [],
            model: workspace.providerModel,
            permissionMode: workspace.permissionMode,
          },
  })

  // 全文注册表给 Skill 工具（catalog 已在 systemPromptSections）
  session.skills = workspace.skills
  session.plugins = workspace.plugins
  session.pluginCommands = workspace.pluginMerge?.commands ?? []
  session.pluginMergeErrors = workspace.pluginMerge?.errors?.length
    ? [...workspace.pluginMerge.errors]
    : undefined
  // tools 已在 createSession 按 agentDefinitions 装配；MCP 再追加

  let mcp: ConnectMcpResult | undefined
  if (opts.connectMcp !== false && workspace.mcpServers.length > 0) {
    mcp = await connectMcpServers({
      servers: workspace.mcpServers,
      cwd: opts.cwd,
      timeoutMs: opts.mcpTimeoutMs,
      onListChanged: async (event: McpListChangedEvent) => {
        // 对照 HC list_changed：再 list 后同步会话工具表 + 事件（无遥测）
        if (session.mcpConnections?.length) {
          session.tools = mergeSessionToolsWithMcp(
            session.tools,
            session.mcpConnections,
          )
        }
        emit(session, {
          type: 'mcp_list_changed',
          server: event.server,
          kind: event.kind,
          toolCount: event.tools.length,
          resourceCount: event.resources.length,
          promptCount: event.prompts.length,
        })
      },
    })
    for (const w of mcp.warnings) {
      emit(session, { type: 'warning', message: w })
      // eslint-disable-next-line no-console
      console.warn(`[bolo mcp] ${w}`)
    }
    if (mcp.servers.length > 0) {
      session.mcpConnections = mcp.servers
    }
    if (mcp.tools.length > 0) {
      session.tools = [
        ...(session.tools ?? createDefaultTools(session.agentDefinitions)),
        ...mcp.tools,
      ]
    }
  }

  return { session, workspace, mcp }
}

export type ReloadSessionPluginsOptions = {
  /** 默认 true：关掉旧 MCP 再按新 workspace 连接 */
  reconnectMcp?: boolean
  mcpTimeoutMs?: number
  /** 默认 true：刷新 skill catalog 段（不重建整个 system） */
  refreshSkillCatalog?: boolean
}

export type ReloadSessionPluginsResult = {
  pluginCount: number
  skillCount: number
  commandCount: number
  hookEventCount: number
  mcpServerCount: number
  mcpConnectedCount: number
  errors: string[]
  warnings: string[]
}

/**
 * PL2：会话内热加载插件贡献（对照 HC `/reload-plugins` + refreshActivePlugins 语义）。
 * - 重扫 user/project plugins + 合并 skills/hooks/mcp/commands
 * - 刷新 session.skills / hooks / plugins / pluginCommands
 * - 可选重连 MCP（默认开）：先 close 再 connect 新表
 * - 不重建 cache-stable system 前缀；仅替换 skill catalog 段
 * - 无市场、无遥测
 */
export async function reloadSessionPlugins(
  session: BoloSession,
  opts?: ReloadSessionPluginsOptions,
): Promise<ReloadSessionPluginsResult> {
  const reconnectMcp = opts?.reconnectMcp !== false
  const refreshCatalog = opts?.refreshSkillCatalog !== false
  const warnings: string[] = []

  const workspace = await loadWorkspace({
    cwd: session.cwd,
    ensureDefaults: false,
  })

  session.plugins = workspace.plugins
  session.skills = workspace.skills
  session.hooks = workspace.hooks
  session.pluginCommands = workspace.pluginMerge?.commands ?? []
  const errors = workspace.pluginMerge?.errors ?? []
  session.pluginMergeErrors = errors.length ? [...errors] : undefined

  if (refreshCatalog) {
    const catalog = formatSkillCatalog(workspace.skills, {
      contextWindowTokens: session.contextWindowTokens,
    })
    session.systemPromptSections = replaceSkillCatalogSection(
      session.systemPromptSections,
      catalog || undefined,
    )
  }

  let mcpConnectedCount = 0
  if (reconnectMcp) {
    await closeSessionMcp(session)
    // 去掉旧 mcp 工具，保留内置（与 mergeSessionToolsWithMcp 同源）
    session.tools = (
      session.tools ?? createDefaultTools(session.agentDefinitions)
    ).filter((t) => !isMcpManagedToolName(t.name))

    if (workspace.mcpServers.length > 0) {
      const mcp = await connectMcpServers({
        servers: workspace.mcpServers,
        cwd: session.cwd,
        timeoutMs: opts?.mcpTimeoutMs,
        onListChanged: async (event: McpListChangedEvent) => {
          if (session.mcpConnections?.length) {
            session.tools = mergeSessionToolsWithMcp(
              session.tools,
              session.mcpConnections,
            )
          }
          emit(session, {
            type: 'mcp_list_changed',
            server: event.server,
            kind: event.kind,
            toolCount: event.tools.length,
            resourceCount: event.resources.length,
            promptCount: event.prompts.length,
          })
        },
      })
      for (const w of mcp.warnings) {
        warnings.push(w)
        emit(session, { type: 'warning', message: w })
      }
      if (mcp.servers.length > 0) {
        session.mcpConnections = mcp.servers
        mcpConnectedCount = mcp.servers.length
      }
      if (mcp.tools.length > 0) {
        session.tools = [
          ...(session.tools ?? createDefaultTools(session.agentDefinitions)),
          ...mcp.tools,
        ]
      }
    }
  } else {
    mcpConnectedCount = session.mcpConnections?.length ?? 0
  }

  // hooks 事件数（配置侧，非运行时 handler 数）
  let hookEventCount = 0
  for (const groups of Object.values(workspace.hooks)) {
    if (Array.isArray(groups) && groups.length) hookEventCount += 1
  }

  return {
    pluginCount: workspace.plugins.length,
    skillCount: workspace.skills.length,
    commandCount: session.pluginCommands?.length ?? 0,
    hookEventCount,
    mcpServerCount: workspace.mcpServers.length,
    mcpConnectedCount,
    errors: [...errors],
    warnings,
  }
}

/** 关闭 MCP 子进程（会话结束时调用） */
export async function closeSessionMcp(session: BoloSession): Promise<void> {
  if (!session.mcpConnections?.length) return
  await closeMcpConnections(session.mcpConnections)
  session.mcpConnections = []
}

/**
 * 按当前 messages + 本轮输入刷新 path-scoped rules 段。
 * 仅替换 `# Project rules`（volatile）；cache-stable 前缀不动。
 * 对照 HC：触达文件时再装载 conditional paths 规则（Bolo 合入 system 段）。
 */
export async function refreshSessionPathScopedRules(
  session: BoloSession,
  opts?: { extraText?: string; activePaths?: string[] },
): Promise<string[]> {
  if (session.refreshPathScopedRules === false) {
    return session.systemPromptSections
  }
  const activePaths =
    opts?.activePaths ??
    collectActivePathsFromMessages(session.messages, opts?.extraText)
  const loaded = await loadBoloRules({
    cwd: session.cwd,
    userConfigDir: session.systemPromptUserConfigDir,
    activePaths,
  })
  session.systemPromptSections = replaceProjectRulesSection(
    session.systemPromptSections,
    loaded.text,
  )
  return session.systemPromptSections
}

/**
 * UserPromptSubmit → queryLoop（对照：用户输入处理后进入 query）
 */
export async function submitPrompt(
  session: BoloSession,
  prompt: string,
  options?: { maxTurns?: number; querySource?: string },
): Promise<Terminal> {
  setPhase(session, 'running')

  const submit = await runHooks(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      prompt,
    },
    session.hooks,
  )
  for (const r of submit.results) {
    emit(session, {
      type: 'hook',
      event: 'UserPromptSubmit',
      exitCode: r.exitCode,
      blocked: r.blocked,
    })
  }
  if (submit.blocked) {
    emit(session, { type: 'error', message: submit.blockReason })
    setPhase(session, 'ready')
    const terminal: Terminal = {
      reason: 'user_prompt_blocked',
      detail: submit.blockReason,
    }
    emit(session, { type: 'done', terminal })
    return terminal
  }

  let userContent = prompt
  if (submit.injectText) userContent = `${prompt}\n\n${submit.injectText}`
  session.messages.push({ role: 'user', content: userContent })

  // path-scope：发模型前按对话中的 active paths 刷新 rules 段
  await refreshSessionPathScopedRules(session, { extraText: userContent })

  const terminal = await queryLoop({
    sessionId: session.id,
    cwd: session.cwd,
    hooks: session.hooks,
    messages: session.messages,
    systemPromptSections: session.systemPromptSections,
    deps: session.deps,
    permissionMode: session.permissionMode,
    askPermission: session.askPermission,
    permissionRules: session.permissionRules,
    maxToolResultChars: session.maxToolResultChars,
    skills: session.skills,
    tools: session.tools ?? createDefaultTools(session.agentDefinitions),
    agentDefinitions: session.agentDefinitions,
    backgroundStore: session.backgroundAgents,
    maxTurns: options?.maxTurns ?? 8,
    querySource: options?.querySource ?? 'repl_main_thread',
    maxPtlRetries: session.maxPtlRetries,
    usage: session.usage,
    model: session.model,
    effortLevel: session.effortLevel,
    onEvent: (e) => mapLoopEvent(session, e),
  })

  if (session.phase !== 'ready') setPhase(session, 'ready')
  await maybeAutoSaveSession(session)
  return terminal
}

export type ResumeSessionOptions = {
  /** session id 或 .json 路径 */
  idOrPath: string
  /** load 时解析 project scope 用的 cwd；默认 process.cwd() 或快照内 cwd */
  cwd?: string
  scope?: SessionScope
  sessionsDir?: string
  filePath?: string
  /**
   * true（默认）：按 cwd/mode 重建 systemPromptSections；
   * false：使用快照中的 system 段。
   */
  reassembleSystem?: boolean
  /** 覆盖 createSession 的其余选项（provider / hooks / skills…） */
  create?: Omit<CreateSessionOptions, 'cwd' | 'sessionId' | 'source' | 'permissionMode'>
  /** 恢复后是否 autoSave（默认 false） */
  autoSave?: CreateSessionOptions['autoSave']
  onEvent?: (e: SessionEvent) => void
  askPermission?: AskPermissionFn
  provider?: LlmProvider
  hooks?: HooksConfig
  skills?: LoadedSkill[]
  systemPrompt?: boolean | AssembleSessionSystemPromptOptions
  source?: SessionStartSource
}

/**
 * 加载会话：经 loadSession（J-C+：同 id 有 jsonl 时 messages 优先 jsonl）。
 */
async function loadSessionOrTranscript(
  idOrPath: string,
  options?: {
    scope?: SessionScope
    cwd?: string
    sessionsDir?: string
    filePath?: string
  },
): Promise<{ path: string; snapshot: SessionSnapshot }> {
  return loadSession(idOrPath, options)
}

/**
 * 从磁盘快照恢复会话（SessionStart source 默认 resume）。
 * J-C+：同 id 同时有 `.json` 与 `.jsonl` 时 messages 优先 jsonl，meta 可从 json 补。
 */
export async function resumeSession(
  opts: ResumeSessionOptions,
): Promise<{ session: BoloSession; snapshot: SessionSnapshot; path: string }> {
  const { path: filePath, snapshot } = await loadSessionOrTranscript(
    opts.idOrPath,
    {
      scope: opts.scope,
      cwd: opts.cwd,
      sessionsDir: opts.sessionsDir,
      filePath: opts.filePath,
    },
  )

  const cwd = opts.cwd ?? snapshot.cwd
  const reassemble = opts.reassembleSystem !== false

  const session = await createSession({
    ...opts.create,
    cwd,
    sessionId: snapshot.id,
    permissionMode: snapshot.permissionMode,
    model: opts.create?.model ?? snapshot.model,
    autoCompactEnabled:
      opts.create?.autoCompactEnabled ?? snapshot.autoCompactEnabled,
    contextWindowTokens:
      opts.create?.contextWindowTokens ?? snapshot.contextWindowTokens,
    maxPtlRetries: opts.create?.maxPtlRetries ?? snapshot.maxPtlRetries,
    permissionRules:
      opts.create?.permissionRules ?? snapshot.permissionRules,
    effortLevel: opts.create?.effortLevel ?? snapshot.effortLevel,
    showThinking:
      opts.create?.showThinking ??
      (snapshot.showThinking === false ? false : true),
    usage: opts.create?.usage ?? snapshot.usage,
    provider: opts.provider ?? opts.create?.provider,
    hooks: opts.hooks ?? opts.create?.hooks,
    skills: opts.skills ?? opts.create?.skills,
    askPermission: opts.askPermission ?? opts.create?.askPermission,
    onEvent: opts.onEvent ?? opts.create?.onEvent,
    systemPrompt: reassemble
      ? (opts.systemPrompt ?? opts.create?.systemPrompt ?? true)
      : false,
    source: opts.source ?? 'resume',
    autoSave: opts.autoSave ?? opts.create?.autoSave,
  })

  applySnapshotToSession(session, snapshot, {
    restoreSystemSections: !reassemble,
  })

  // 重建 system 失败或为空时回退快照
  if (reassemble && session.systemPromptSections.length === 0) {
    session.systemPromptSections = [...snapshot.systemPromptSections]
  }

  setSessionPersistMeta(session, {
    createdAt: snapshot.createdAt,
    filePath,
    scope: opts.scope ?? 'project',
  })

  return { session, snapshot, path: filePath }
}

/** 显式保存当前会话（同 saveSession，便于从 core 入口发现） */
export async function persistSession(
  session: BoloSession,
  options?: SaveSessionOptions,
): Promise<{ path: string; snapshot: SessionSnapshot }> {
  return saveSession(session, options)
}

/**
 * 按 session.autoCompactEnabled + summarizer 重挂 prepare 链。
 * 供 createSession / 运行时 `/autocompact` 共用。
 * 顺序：snip → micro → auto full。
 */
export function wireSessionPrepareMessages(
  session: BoloSession,
  opts?: {
    microcompact?: MicrocompactOptions | false
    snip?: SnipOptions | false
  },
): void {
  const microOpts: MicrocompactOptions | undefined =
    opts?.microcompact === false
      ? { enabled: false }
      : opts?.microcompact === undefined
        ? undefined
        : opts.microcompact
  const snipOpts: SnipOptions | false | undefined =
    opts?.snip === false
      ? false
      : opts?.snip === undefined
        ? undefined
        : opts.snip
  const snipPrepare = createSnipPrepare(snipOpts)
  const microPrepare = createMicrocompactPrepare(microOpts)

  if (session.autoCompactEnabled && session.compactSummarizer) {
    session.deps = {
      ...session.deps,
      prepareMessages: composePrepareMessages(
        snipPrepare,
        microPrepare,
        createAutoCompactPrepare({
          enabled: true,
          contextWindowTokens: session.contextWindowTokens,
          runAutoCompact: async () => {
            const r = await compactSession(session, { trigger: 'auto' })
            return r.ok ? session.messages : null
          },
        }),
      ),
    }
    return
  }

  session.deps = {
    ...session.deps,
    prepareMessages: composePrepareMessages(snipPrepare, microPrepare),
  }
}

/**
 * 运行时开关 auto compact，并重挂 prepare（不改 system 前缀）。
 * 返回生效后的状态；环境熔断时仍可「会话 on」但 shouldAutoCompact 为 false。
 */
export function setSessionAutoCompact(
  session: BoloSession,
  enabled: boolean,
  opts?: {
    microcompact?: MicrocompactOptions | false
    snip?: SnipOptions | false
  },
): { autoCompactEnabled: boolean; envDisabled: boolean } {
  session.autoCompactEnabled = enabled === true
  wireSessionPrepareMessages(session, opts)
  return {
    autoCompactEnabled: session.autoCompactEnabled,
    envDisabled: isAutoCompactEnvDisabled(),
  }
}

export type CompactSessionOptions = {
  trigger?: 'manual' | 'auto'
  customInstructions?: string
  keepRecentMessageCount?: number
}

/**
 * Full compact — docs/COMPACTION.md；无 summarizer 则失败且不改 messages
 */
export async function compactSession(
  session: BoloSession,
  options: CompactSessionOptions | 'manual' | 'auto' = 'manual',
): Promise<{ ok: boolean; reason?: string }> {
  const opts: CompactSessionOptions =
    typeof options === 'string' ? { trigger: options } : options
  const trigger = opts.trigger ?? 'manual'

  if (!session.compactSummarizer) {
    emit(session, {
      type: 'error',
      message:
        'compact refused: inject CompactSummarizer (see docs/COMPACTION.md); will not truncate messages',
    })
    return { ok: false, reason: 'no CompactSummarizer' }
  }

  const snapshot = session.messages.slice()
  setPhase(session, 'compacting')

  const pre = await runHooks(
    'PreCompact',
    {
      hook_event_name: 'PreCompact',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      trigger,
    },
    session.hooks,
  )
  for (const r of pre.results) {
    emit(session, {
      type: 'hook',
      event: 'PreCompact',
      exitCode: r.exitCode,
      blocked: r.blocked,
    })
  }
  if (pre.blocked) {
    session.messages.length = 0
    session.messages.push(...snapshot)
    setPhase(session, 'ready')
    return { ok: false, reason: pre.blockReason || 'PreCompact blocked' }
  }

  const outcome = await runFullCompact({
    messages: session.messages,
    trigger,
    customInstructions: opts.customInstructions,
    maxPtlRetries: session.maxPtlRetries,
    hookInstructions: pre.injectText || undefined,
    summarize: session.compactSummarizer,
    keepRecentMessageCount: opts.keepRecentMessageCount ?? 0,
    suppressFollowUpQuestions: trigger === 'auto',
  })

  if (!outcome.ok) {
    // 失败：恢复快照且保持同一数组引用（queryLoop 持有 params.messages）
    session.messages.length = 0
    session.messages.push(...snapshot)
    emit(session, { type: 'error', message: outcome.reason })
    setPhase(session, 'ready')
    return { ok: false, reason: outcome.reason }
  }

  // 就地替换，避免 session.messages 与 queryLoop 引用脱节
  session.messages.length = 0
  session.messages.push(...outcome.apiMessages)

  // full compact 只改对话 messages；systemPromptSections（含 BOLO / rules 稳定前缀）不动
  // boundary 为 apiMessages[0] system「Conversation compacted」

  const post = await runHooks(
    'PostCompact',
    {
      hook_event_name: 'PostCompact',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      trigger,
      summary: outcome.result.summaryText,
    },
    session.hooks,
  )
  for (const r of post.results) {
    emit(session, { type: 'hook', event: 'PostCompact', exitCode: r.exitCode })
  }

  // 旁路 jsonl：rewrite 并写入 compact_boundary（不改 JSON 快照）
  try {
    const meta = getSessionPersistMeta(session)
    await writeTranscriptAfterCompact(session, {
      summary: outcome.result.summaryText,
      filePath: meta?.filePath,
      sessionsDir: meta?.sessionsDir,
      createdAt: meta?.createdAt,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit(session, {
      type: 'error',
      message: `compact transcript boundary failed: ${message}`,
    })
  }

  setPhase(session, 'ready')
  return { ok: true }
}

export {
  AGENT_TOOL_NAME,
  EXPLORE_AGENT,
  GENERAL_AGENT,
  FORK_AGENT,
  createAgentTool,
  createDefaultTools,
  createBackgroundAgentStore,
  formatBackgroundAgentsStatus,
  markBackgroundAgentRunning,
  markBackgroundAgentFinished,
  getAgentDefinition,
  listBuiltinAgents,
  listActiveAgents,
  loadAgentsDir,
  mergeAgentDefinitions,
  builtinAgentMap,
  resolveAgentTools,
  resolveSubagentTranscriptPath,
  runSubagent,
  spawnSubagent,
  spawnSubagentStub,
  isForkAgentRequest,
  agentDefinitionFromMarkdown,
  parseAgentFrontmatter,
  parseToolsField,
  type AgentDefinition,
  type AgentDefinitionSource,
  type ActiveAgentDefinitions,
  type BackgroundAgentEntry,
  type BackgroundAgentStatus,
  type BackgroundAgentStore,
  type LoadAgentsDirOptions,
  type LoadAgentsDirResult,
  type ResolveAgentToolsResult,
  type RunSubagentParams,
  type RunSubagentResult,
  type SubagentParentContext,
} from './subagent.ts'

/**
 * 切换权限模式（对照 HC cyclePermissionMode 的 session 侧）
 */
export function setPermissionMode(session: BoloSession, mode: PermissionMode) {
  session.permissionMode = mode
  emit(session, {
    type: 'phase',
    phase: session.phase,
  })
}

// ── slash 总线（parse / dispatch / submitUserInput）──
export {
  parseSlashLine,
  dispatchSlashCommand,
  submitUserInput,
  getSlashCommand,
  invokeSkillBySlash,
  SLASH_COMMANDS,
  EFFORT_LEVELS,
  isEffortLevel,
  approxTokensFromChars,
  sectionLabel,
  editDistance,
  suggestSlashCommands,
  SLASH_GROUP_LABELS,
  SLASH_GROUP_ORDER,
  type ParseSlashResult,
  type SlashDispatchResult,
  type SubmitUserInputResult,
  type SlashCommandDef,
  type SlashCommandGroup,
  type EffortLevel,
} from './slash.ts'