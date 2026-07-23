/**
 * Agent Runtime — Session 外壳 + compactSession
 * Agent loop 本体见 queryLoop.ts（对照 HelsincyCode query.ts）
 * 禁止：Electron / DOM / 遥测
 */

import {
  runFullCompact,
  type CompactSummarizer,
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
import type { LoadedSkill } from '../../skills/src/index.ts'
import {
  newId,
  nowIso,
  type ChatMessage,
  type HooksConfig,
  type SessionPhase,
  type SessionStartSource,
} from '../../shared/src/index.ts'
import {
  createAutoCompactPrepare,
  productionDeps,
  type QueryDeps,
} from './deps.ts'
import { queryLoop, type QueryLoopEvent, type Terminal } from './queryLoop.ts'
import type { AskPermissionFn } from './toolExecution.ts'
import {
  parsePermissionMode,
  type PermissionMode,
} from '../../permissions/src/index.ts'
import {
  assembleSessionSystemPrompt,
  type AssembleSessionSystemPromptOptions,
} from './systemPrompt.ts'

export type { AskPermissionFn, Terminal }
export type { QueryDeps, PrepareMessagesFn } from './deps.ts'
export { productionDeps, createAutoCompactPrepare, identityPrepareMessages } from './deps.ts'
export { queryLoop } from './queryLoop.ts'
export { runTools } from './toolOrchestration.ts'
export { runToolUse } from './toolExecution.ts'
export type { PermissionMode } from '../../permissions/src/index.ts'
export {
  loadBoloMd,
  getSystemPrompt,
  buildEffectiveSystemPrompt,
  prepareModelMessages,
  assembleSessionSystemPrompt,
  systemSectionsToMessages,
  boloMdCandidatePaths,
  permissionModeBehaviorLine,
  BOLO_MD_MAX_CHARS_PER_FILE,
  BOLO_MD_MAX_TOTAL_CHARS,
} from './systemPrompt.ts'
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
} from '../../permissions/src/index.ts'

export type SessionEvent =
  | { type: 'phase'; phase: SessionPhase | string }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: string; ok: boolean }
  | { type: 'permission_request'; id: string; name: string; input: unknown }
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean }
  | { type: 'permission_decision'; mode: string; behavior: string; reason: string }
  | { type: 'error'; message: string }
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
  compactSummarizer?: CompactSummarizer
  /** 会话 skill 全文表；默认不进 system，仅 Skill 工具按需加载 */
  skills?: LoadedSkill[]
  /**
   * 是否组装默认 system（身份/环境/BOLO.md/skill catalog）。
   * 默认 true。smoke 可关以保持最短 mock 路径。
   */
  systemPrompt?: boolean | AssembleSessionSystemPromptOptions
  /**
   * 是否在 queryLoop 的 prepareMessages 挂 auto compact（对照 HC autoCompactIfNeeded）。
   * 需同时注入 compactSummarizer；默认 false。
   */
  autoCompactEnabled?: boolean
  /** 模型上下文窗口估计（tokens），用于 auto 阈值；默认 128_000 */
  contextWindowTokens?: number
  /** 模型名（写入环境段；可从 workspace 传入） */
  model?: string
  source?: SessionStartSource
  onEvent?: (e: SessionEvent) => void
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
  hooks: HooksConfig
  provider: LlmProvider
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  compactSummarizer?: CompactSummarizer
  skills: LoadedSkill[]
  model?: string
  /** 会话级 auto compact 开关（prepareMessages） */
  autoCompactEnabled: boolean
  contextWindowTokens: number
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
  if (opts.systemPrompt !== false) {
    const extra =
      typeof opts.systemPrompt === 'object' && opts.systemPrompt
        ? opts.systemPrompt
        : {}
    systemPromptSections = await assembleSessionSystemPrompt({
      cwd: opts.cwd,
      permissionMode,
      model: opts.model ?? extra.model,
      skills: extra.skills ?? skills,
      skillCatalog: extra.skillCatalog,
      boloMd: extra.boloMd,
      loadInstructions: extra.loadInstructions,
      userConfigDir: extra.userConfigDir,
      mcpPlaceholder: extra.mcpPlaceholder,
      overrideSystemPrompt: extra.overrideSystemPrompt,
      customSystemPrompt: extra.customSystemPrompt,
      appendSystemPrompt: extra.appendSystemPrompt,
      date: extra.date,
      platform: extra.platform,
      shellHint: extra.shellHint,
    })
  }

  const session: BoloSession = {
    id: opts.sessionId ?? newId('sess'),
    cwd: opts.cwd,
    phase: 'idle',
    messages: [],
    systemPromptSections,
    hooks: opts.hooks ?? {},
    provider,
    deps: opts.deps ?? productionDeps(provider),
    permissionMode,
    // smoke 可注入；default 模式下 ask 会走到这里。未注入则 deny 更安全；
    // 测试/smoke 显式传 allow。
    askPermission: opts.askPermission ?? (async () => 'deny'),
    compactSummarizer: opts.compactSummarizer,
    skills,
    model: opts.model,
    autoCompactEnabled: opts.autoCompactEnabled === true,
    contextWindowTokens: opts.contextWindowTokens ?? 128_000,
    onEvent: opts.onEvent ?? (() => {}),
  }

  // 对照 HC query/deps autocompact：达阈值 → full compact（真 summarizer，禁止 slice）
  if (session.autoCompactEnabled && session.compactSummarizer) {
    session.deps = {
      ...session.deps,
      prepareMessages: createAutoCompactPrepare({
        enabled: true,
        contextWindowTokens: session.contextWindowTokens,
        runAutoCompact: async () => {
          const r = await compactSession(session, { trigger: 'auto' })
          return r.ok ? session.messages : null
        },
      }),
    }
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
}

/**
 * 从 ~/.bolo + 项目 .bolo 装配 Session
 * system 由 assembleSessionSystemPrompt 统一组装（含 BOLO.md + skill catalog）
 */
export async function createSessionFromWorkspace(
  opts: CreateSessionFromWorkspaceOptions,
): Promise<{ session: BoloSession; workspace: ResolvedWorkspace }> {
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
      opts.autoCompactEnabled ?? workspace.config.autoCompactEnabled === true,
    contextWindowTokens:
      opts.contextWindowTokens ??
      workspace.config.contextWindowTokens ??
      128_000,
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

  return { session, workspace }
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

  const terminal = await queryLoop({
    sessionId: session.id,
    cwd: session.cwd,
    hooks: session.hooks,
    messages: session.messages,
    systemPromptSections: session.systemPromptSections,
    deps: session.deps,
    permissionMode: session.permissionMode,
    askPermission: session.askPermission,
    skills: session.skills,
    maxTurns: options?.maxTurns ?? 8,
    querySource: options?.querySource ?? 'repl_main_thread',
    onEvent: (e) => mapLoopEvent(session, e),
  })

  if (session.phase !== 'ready') setPhase(session, 'ready')
  return terminal
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

  setPhase(session, 'ready')
  return { ok: true }
}

export async function spawnSubagentStub(
  session: BoloSession,
  agentType: string,
): Promise<{ agentId: string }> {
  const agentId = newId('agent')
  await runHooks(
    'SubagentStart',
    {
      hook_event_name: 'SubagentStart',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      agent_id: agentId,
      agent_type: agentType,
    },
    session.hooks,
  )
  await runHooks(
    'SubagentStop',
    {
      hook_event_name: 'SubagentStop',
      session_id: session.id,
      cwd: session.cwd,
      timestamp: nowIso(),
      agent_id: agentId,
      agent_type: agentType,
    },
    session.hooks,
  )
  return { agentId }
}

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