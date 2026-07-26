/**
 * queryLoop — 对照 HelsincyCode query.ts queryLoop
 *
 * while true:
 *   prepareMessages（默认链：snip → microcompact → auto full compact）
 *   callModel stream (+ tools)
 *     若 429/5xx/timeout：wrapCallModelWithRetry 退避（deps 默认包装）
 *     若 PTL：截断最旧 API 轮次 → 写回 session → 再 prepare → 重试（有限次）
 *   if tool_use → StreamingToolExecutor（边流边跑）→ drain → continue
 *   else → Stop hooks → terminal
 */

import { runHooks } from '../../hooks/src/index.ts'
import {
  isPromptTooLongError,
  truncateHeadForPtlRetry,
  DEFAULT_MAX_PTL_RETRIES,
  fingerprintMessagePrefix,
} from '../../compact/src/index.ts'
import { classifyError } from './errorClassify.ts'
import type { ModelRetryInfo } from './modelRetry.ts'
import {
  nowIso,
  type ChatMessage,
  type HooksConfig,
} from '../../shared/src/index.ts'
import { createBuiltinTools, type BoloTool } from '../../tools/src/index.ts'
import type {
  PermissionMode,
  SessionPermissionRules,
} from '../../permissions/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import type { QueryDeps } from './deps.ts'
import type {
  AskPermissionFn,
  ToolExecutionEvent,
  ToolUseBlock,
} from './toolExecution.ts'
import { StreamingToolExecutor } from './streamingToolExecutor.ts'
import { buildTodoReminderMessage } from './sessionTodo.ts'
import { prepareModelMessages, getCacheStablePrefix } from './systemPrompt.ts'
import {
  accumulateSessionUsage,
  estimateUsageFromCharCounts,
  messageChars,
  normalizeProviderUsage,
  type SessionUsage,
} from './sessionUsage.ts'
import type { PromptCacheSessionState } from '../../compact/src/index.ts'
import { notePromptCacheAfterModelCall } from '../../compact/src/index.ts'
import type {
  SessionControlRecord,
  SessionSafeBoundary,
} from './sessionCoordinator.ts'
import type { BackgroundAgentEntry } from './subagent.ts'

export type TerminalReason =
  | 'completed'
  | 'max_turns'
  | 'aborted'
  | 'user_prompt_blocked'
  | 'error'

export type Terminal = {
  reason: TerminalReason
  detail?: string
}

export type QueryLoopEvent =
  | { type: 'phase'; phase: string }
  | { type: 'text'; text: string }
  /** 思考链增量（不写入 ChatMessage；仅展示） */
  | { type: 'reasoning'; text: string }
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean }
  | { type: 'error'; message: string }
  /**
   * 非致命诊断：本轮继续，但有些东西值得说。
   * 目前来源是 provider 流里不认识的内容块——静默丢弃会让用户
   * 「付了钱、没结果、查不出原因」。CLI printer 已有 warn 渲染。
   */
  | { type: 'warning'; message: string }
  /**
   * provider 侧执行的搜索的可观测信号（查询词 / 结果数 / 引用）。
   * 与 tool_start/tool_end 刻意分开：这不是 Bolo 跑的工具，
   * 混进工具轨会让人以为本地执行了什么。
   */
  | {
      type: 'web_search'
      phase: 'query' | 'results' | 'citation'
      query?: string
      resultCount?: number
      url?: string
      title?: string
    }
  | {
      type: 'ptl_retry'
      attempt: number
      maxRetries: number
      droppedMessageCount: number
    }
  | {
      type: 'mid_turn_compact'
      ok: boolean
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
  | {
      type: 'control'
      kind: 'steer'
      controlId: string
      boundary: SessionSafeBoundary
      prompt: string
    }
  | {
      type: 'background_result'
      taskId: string
      status: BackgroundAgentEntry['status']
      boundary: SessionSafeBoundary
    }
  /** AR-T1：当前待办表已重新注入对话（模型久未更新 / compact 后失去视野） */
  | { type: 'todo_reminder' }
  | { type: 'done'; terminal: Terminal }
  | ToolExecutionEvent

export type QueryLoopParams = {
  sessionId: string
  /** DR3A：主会话当前 durable turn；subagent task 以此关联父 turn。 */
  turnId?: string
  cwd: string
  hooks: HooksConfig
  messages: ChatMessage[]
  /**
   * 权威 system 段；每轮 callModel 前缀。
   * 未传时回退 messages 内已有 system（兼容旧调用）。
   */
  systemPromptSections?: readonly string[]
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  /** 会话 Always-allow；透传 runTools */
  permissionRules?: SessionPermissionRules
  /** auto 分类器 / 状态 */
  classifyPermission?: import('../../permissions/src/index.ts').AutoClassifyFn
  autoModeState?: import('../../permissions/src/index.ts').AutoModeState
  /** 熔断 demote 时写回 mode；亦可挂 fileDiffLog */
  sessionRef?: {
    permissionMode: import('../../permissions/src/index.ts').PermissionMode
    autoModeState?: import('../../permissions/src/index.ts').AutoModeState
    fileDiffLog?: import('./fileDiffLog.ts').FileChangeRecord[]
    diffTurn?: number
    id?: string
    onFileDiffRecord?: (
      rec: import('./fileDiffLog.ts').FileChangeRecord,
    ) => void | Promise<void>
    hookDiagLog?: import('./hookDiag.ts').HookDiagLog
    /**
     * C3：mid-turn compact 钩子（由 createSession/submit 挂上）。
     * 成功压消息后返回 true。
     */
    tryMidTurnCompact?: () => Promise<boolean>
  }
  /** Y3.6 auto 分类审计 → system_note */
  onAutoClassifyAudit?: (note: {
    text: string
    kind: 'auto_classify'
  }) => void | Promise<void>
  /** tool_result 字符预算 */
  maxToolResultChars?: number
  spillTruncatedToolResults?: boolean
  maxTurns?: number
  querySource?: string
  /** 默认内置工具集（HC buildTool 契约） */
  tools?: readonly BoloTool[]
  /** 会话 skill 注册表（Skill 工具按需加载全文） */
  skills?: LoadedSkill[]
  /** 活跃 agent 定义；传给 Agent 工具 resolve */
  agentDefinitions?: import('./subagent.ts').ActiveAgentDefinitions
  /** 后台 subagent 状态表（Agent run_in_background） */
  backgroundStore?: import('./subagent.ts').BackgroundAgentStore
  /** DR3B：父 session owner 在 safe boundary 提供尚未 delivery 的结果。 */
  takeBackgroundResults?: () => readonly BackgroundAgentEntry[]
  /**
   * AR-T1：会话待办表 store（TodoWrite 工具写入 · reminder 注入读取）。
   * 不进 messages，因此不受 compact 影响。
   */
  todoStore?: import('../../tools/src/index.ts').TodoStoreRef
  /**
   * AR-T2：后台 shell 注册表。后台进程跨 turn 存活，只在 session 结束时收尸。
   */
  backgroundShellStore?: import('../../shared/src/index.ts').BackgroundShellStore
  /** AR-T3a：会话权限模式引用（ExitPlanMode 批准后切换） */
  planModeStore?: import('../../tools/src/index.ts').PlanModeStoreRef
  /** 全局 agent 策略（Spec v0） */
  agentPolicy?: import('./subagent.ts').AgentPolicy
  /**
   * 当前 loop 的 spawn 深度：主=0，子≥1。
   * 用于条件暴露 Agent 工具。
   */
  spawnDepth?: number
  /**
   * callModel 因上下文过长失败时，截断最旧轮次再试的次数。
   * 默认 3；0 = 关闭。对照 HC MAX_PTL_RETRIES。
   */
  maxPtlRetries?: number
  /**
   * 可选：会话 usage 累加器（就地更新）。
   * 有 provider `usage` 事件则累加；否则 chars/4 估算并标 estimated。
   */
  usage?: SessionUsage
  /**
   * 当前会话 model 标签；写入 usage.byModel 分桶（本地 breakdown）。
   */
  model?: string
  /**
   * 会话 effort 档位（/effort）；透传 callModel → provider max_tokens 映射。
   */
  effortLevel?: string
  /**
   * 本地 prompt-cache 布局/TTL 观测（F-C6）；callModel 成功后 touch。
   */
  promptCacheState?: PromptCacheSessionState
  /**
   * 是否把本轮 reasoning 写入 assistant.reasoning_content（openai-compatible 回灌）。
   * 默认 false。
   */
  persistReasoning?: boolean
  /**
   * Stop exit 2 续跑预算（本 queryLoop 调用内）。
   * 默认 3；0 = 不续跑（仍 emit hook）。
   */
  maxStopContinuations?: number
  /**
   * C3：tool drain 后 mid-turn auto compact（每 outer turn 最多一次）。
   * 默认 true；false 关闭。需 sessionRef 上能跑 compact 或提供 tryMidTurnCompact。
   */
  midTurnAutoCompact?: boolean
  /**
   * C3：可选注入 mid-turn compact；返回 true 表示已压消息。
   * 未传时若 sessionRef 带 tryMidTurnCompact 则调用。
   */
  tryMidTurnCompact?: () => Promise<boolean>
  onEvent?: (e: QueryLoopEvent) => void
  signal?: AbortSignal
  /**
   * DR2B2：显式 safe boundary 消费 coordinator 已 promotion 的 controls。
   * callback 不得直接修改 messages。
   */
  onSafeBoundary?: (
    boundary: SessionSafeBoundary,
  ) =>
    | readonly SessionControlRecord[]
    | Promise<readonly SessionControlRecord[]>
}

function emit(params: QueryLoopParams, e: QueryLoopEvent) {
  params.onEvent?.(e)
}

const BACKGROUND_RESULT_PROMOTION_BOUNDARIES =
  new Set<SessionSafeBoundary>([
    'before_provider',
    'after_tools',
    'after_compact',
    'before_stop',
  ])

function formatBackgroundResultMessage(
  task: BackgroundAgentEntry,
): string {
  const summary = (task.summary ?? '(no summary)').trim()
  const boundedSummary =
    summary.length > 20_000
      ? `${summary.slice(0, 19_999)}…`
      : summary
  const lines = [
    '<background_task_result>',
    `task_id: ${task.agentId}`,
    `agent_type: ${task.agentType}`,
    `status: ${task.status}`,
    ...(task.description ? [`description: ${task.description}`] : []),
    ...(task.worktreePath ? [`worktree_path: ${task.worktreePath}`] : []),
    'summary:',
    boundedSummary,
    '</background_task_result>',
  ]
  return lines.join('\n')
}

async function visitSafeBoundary(
  params: QueryLoopParams,
  boundary: SessionSafeBoundary,
): Promise<number> {
  let controls: readonly SessionControlRecord[] = []
  if (params.onSafeBoundary) {
    try {
      controls = await params.onSafeBoundary(boundary)
    } catch (error) {
      emit(params, {
        type: 'error',
        message: `safe boundary "${boundary}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  }
  let promoted = 0
  for (const control of controls) {
    if (
      control.kind !== 'steer' ||
      control.state !== 'promoted' ||
      !control.prompt
    ) {
      continue
    }
    params.messages.push({ role: 'user', content: control.prompt })
    promoted += 1
    emit(params, {
      type: 'control',
      kind: 'steer',
      controlId: control.controlId,
      boundary,
      prompt: control.prompt,
    })
  }
  // AR-T1：待办表不在 messages 里，模型看不见它。
  // 在下一次 provider 调用前，按锚点策略把当前表重新注入一次。
  if (boundary === 'before_provider' && params.todoStore) {
    const reminder = buildTodoReminderMessage(
      params.todoStore.todos,
      params.messages,
    )
    if (reminder) {
      params.messages.push(reminder)
      promoted += 1
      emit(params, { type: 'todo_reminder' })
    }
  }
  if (
    params.takeBackgroundResults &&
    BACKGROUND_RESULT_PROMOTION_BOUNDARIES.has(boundary)
  ) {
    const results = params.takeBackgroundResults()
    for (const result of results) {
      params.messages.push({
        role: 'user',
        content: formatBackgroundResultMessage(result),
      })
      promoted += 1
      emit(params, {
        type: 'background_result',
        taskId: result.agentId,
        status: result.status,
        boundary,
      })
    }
  }
  return promoted
}

async function finishTerminal(
  params: QueryLoopParams,
  terminal: Terminal,
): Promise<Terminal> {
  await visitSafeBoundary(params, 'turn_terminal')
  emit(params, { type: 'done', terminal })
  return terminal
}

function applyPreparedToSession(
  params: QueryLoopParams,
  prepared: { messages: ChatMessage[]; didCompact?: boolean },
): ChatMessage[] {
  if (prepared.didCompact) {
    // 注意：runAutoCompact 可能返回与 params.messages 同一数组引用；
    // 必须先拷贝再就地写回，否则 length=0 会清空 spread 源。
    const next = prepared.messages.slice()
    params.messages.length = 0
    params.messages.push(...next)
  }
  return prepared.didCompact
    ? params.messages
    : prepared.messages.filter(
        (m) =>
          m.role !== 'system' ||
          m.content.trim() === 'Conversation compacted' ||
          m.content.trim() === 'History snipped',
      )
}

function buildMessagesForQuery(
  params: QueryLoopParams,
  prepared: { messages: ChatMessage[]; didCompact?: boolean },
  conversation: ChatMessage[],
): ChatMessage[] {
  if (params.systemPromptSections && params.systemPromptSections.length > 0) {
    return prepareModelMessages({
      systemSections: params.systemPromptSections,
      conversation,
    })
  }
  return prepared.didCompact ? params.messages : prepared.messages
}

export async function queryLoop(params: QueryLoopParams): Promise<Terminal> {
  const maxTurns = params.maxTurns ?? 8
  const querySource = params.querySource ?? 'repl_main_thread'
  const tools = params.tools ?? createBuiltinTools()
  const maxPtlRetries =
    params.maxPtlRetries === undefined
      ? DEFAULT_MAX_PTL_RETRIES
      : Math.max(0, params.maxPtlRetries)
  let turnCount = 0
  /** 本 turn 内 PTL 重试计数；成功 callModel 后清零 */
  let ptlAttemptsThisTurn = 0
  /** Stop exit 2 续跑已用次数（H1） */
  let stopContinuations = 0
  const maxStopContinuations =
    params.maxStopContinuations === undefined
      ? 3
      : Math.max(0, Math.floor(params.maxStopContinuations))
  /** C3：本 outer turn 是否已 mid-turn compact */
  let midTurnCompacted = false
  const midTurnEnabled = params.midTurnAutoCompact !== false

  while (true) {
    if (params.signal?.aborted) {
      const terminal: Terminal = { reason: 'aborted' }
      return finishTerminal(params, terminal)
    }

    turnCount += 1
    midTurnCompacted = false
    if (turnCount > maxTurns) {
      const terminal: Terminal = {
        reason: 'max_turns',
        detail: `maxTurns=${maxTurns}`,
      }
      emit(params, { type: 'phase', phase: 'stopping' })
      await runStopHooks(params)
      return finishTerminal(params, terminal)
    }

    await visitSafeBoundary(params, 'before_provider')
    if (params.signal?.aborted) {
      const terminal: Terminal = { reason: 'aborted' }
      return finishTerminal(params, terminal)
    }
    emit(params, { type: 'phase', phase: 'running' })

    // 同一 turn 内：callModel 失败且为 PTL 时截断后 continue，不额外消耗 maxTurns
    let modelOk = false
    let assistantText = ''
    let assistantReasoning = ''
    const toolBlocks: ToolUseBlock[] = []
    /**
     * 工具只在 provider stream 成功结束后入队。
     * provider 可能在 partial text/tool_call 后报错；提前执行会产生不可回滚副作用。
     */
    let streamTools: StreamingToolExecutor | null = null

    while (!modelOk) {
      if (params.signal?.aborted) {
        streamTools?.discard()
        const terminal: Terminal = { reason: 'aborted' }
        return finishTerminal(params, terminal)
      }

      const prepared = await params.deps.prepareMessages({
        messages: params.messages,
        querySource,
        tokenCount: 0,
      })
      const conversation = applyPreparedToSession(params, prepared)
      const messagesForQuery = buildMessagesForQuery(
        params,
        prepared,
        conversation,
      )

      assistantText = ''
      assistantReasoning = ''
      toolBlocks.length = 0
      streamTools?.discard()
      streamTools = new StreamingToolExecutor({
        context: {
          sessionId: params.sessionId,
          parentTurnId: params.turnId,
          cwd: params.cwd,
          hooks: params.hooks,
          permissionMode: params.permissionMode,
          askPermission: params.askPermission,
          permissionRules: params.permissionRules,
          classifyPermission: params.classifyPermission,
          autoModeState: params.autoModeState,
          sessionRef: params.sessionRef,
          onAutoClassifyAudit: params.onAutoClassifyAudit,
          maxToolResultChars: params.maxToolResultChars,
          spillTruncatedToolResults: params.spillTruncatedToolResults,
          skills: params.skills,
          tools,
          deps: params.deps,
          agentDefinitions: params.agentDefinitions,
          backgroundStore: params.backgroundStore,
          todoStore: params.todoStore,
          backgroundShellStore: params.backgroundShellStore,
          planModeStore: params.planModeStore,
          parentMessages: params.messages,
          parentSystemPromptSections: params.systemPromptSections,
          model: params.model,
          parentUsage: params.usage,
          parentEffort: params.effortLevel,
          agentPolicy: params.agentPolicy,
          spawnDepth: params.spawnDepth ?? 0,
          signal: params.signal,
          onSafeBoundary: async (boundary) => {
            await visitSafeBoundary(params, boundary)
          },
          onEvent: params.onEvent,
        },
      })
      let modelError: string | undefined
      let hadModelOutput = false
      let streamUsage: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        cacheReadInputTokens?: number
        cacheCreationInputTokens?: number
      } | null = null
      let toolArgsChars = 0
      const callStartedAt = Date.now()

      try {
        for await (const ev of params.deps.callModel({
          messages: messagesForQuery,
          signal: params.signal,
          tools,
          model: params.model,
          effort: params.effortLevel,
          onModelRetry: (info: ModelRetryInfo) => {
            emit(params, {
              type: 'model_retry',
              attempt: info.attempt,
              maxRetries: info.maxRetries,
              delayMs: info.delayMs,
              message: info.message,
              reason: info.reason,
              status: info.status,
            })
          },
        })) {
          if (ev.type === 'text_delta') {
            assistantText += ev.text
            if (ev.text) hadModelOutput = true
            emit(params, { type: 'text', text: ev.text })
          } else if (ev.type === 'reasoning_delta') {
            // 展示始终转发；可选累加供 openai-compatible 回灌
            if (ev.text) {
              hadModelOutput = true
              if (params.persistReasoning) assistantReasoning += ev.text
              emit(params, { type: 'reasoning', text: ev.text })
            }
          } else if (ev.type === 'reasoning_end') {
            // 分段标记：CLI 用空 reasoning 或仅靠后续 text 换行；此处不发噪声
          } else if (ev.type === 'tool_call') {
            let input: unknown = {}
            try {
              input = ev.arguments ? JSON.parse(ev.arguments) : {}
            } catch {
              input = { raw: ev.arguments }
            }
            toolArgsChars += (ev.arguments ?? '').length
            const block: ToolUseBlock = {
              id: ev.id || params.deps.uuid(),
              name: ev.name,
              input,
              argumentsJson: ev.arguments,
            }
            hadModelOutput = true
            toolBlocks.push(block)
          } else if (ev.type === 'usage') {
            streamUsage = {
              inputTokens: ev.usage?.inputTokens,
              outputTokens: ev.usage?.outputTokens,
              totalTokens: ev.usage?.totalTokens,
              cacheReadInputTokens: ev.usage?.cacheReadInputTokens,
              cacheCreationInputTokens: ev.usage?.cacheCreationInputTokens,
            }
          } else if (ev.type === 'web_search') {
            // provider 侧已经搜完了。这里只是让它可见——不可见就等于
            // 用户为一次看不到的搜索付费。**不是** tool_call，不本地执行。
            emit(params, {
              type: 'web_search',
              phase: ev.phase,
              ...(ev.query ? { query: ev.query } : {}),
              ...(ev.resultCount != null ? { resultCount: ev.resultCount } : {}),
              ...(ev.url ? { url: ev.url } : {}),
              ...(ev.title ? { title: ev.title } : {}),
            })
          } else if (ev.type === 'provider_notice') {
            // provider 流里出现本客户端不认识的块。不是错误，不终止本轮，
            // 但必须让用户看见——否则「搜索跑了、花了钱、结果没了」查不出来。
            emit(params, {
              type: 'warning',
              message: ev.detail,
            })
          } else if (ev.type === 'error') {
            modelError = ev.message
            break
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        streamTools?.discard()
        const classified = classifyError(e, { signal: params.signal })
        if (classified.class === 'user_abort' || params.signal?.aborted) {
          const terminal: Terminal = { reason: 'aborted', detail: msg }
          return finishTerminal(params, terminal)
        }
        const recovered = hadModelOutput
          ? null
          : tryPtlRecover(
              params,
              msg,
              maxPtlRetries,
              ptlAttemptsThisTurn,
            )
        if (recovered) {
          ptlAttemptsThisTurn = recovered.nextAttempts
          continue
        }
        emit(params, { type: 'error', message: msg })
        const terminal: Terminal = { reason: 'error', detail: msg }
        return finishTerminal(params, terminal)
      }

      if (params.signal?.aborted) {
        streamTools?.discard()
        const terminal: Terminal = {
          reason: 'aborted',
          detail: modelError,
        }
        return finishTerminal(params, terminal)
      }

      if (modelError) {
        streamTools?.discard()
        const classified = classifyError(modelError, {
          signal: params.signal,
        })
        if (classified.class === 'user_abort' || params.signal?.aborted) {
          const terminal: Terminal = {
            reason: 'aborted',
            detail: modelError,
          }
          return finishTerminal(params, terminal)
        }
        const recovered = hadModelOutput
          ? null
          : tryPtlRecover(
              params,
              modelError,
              maxPtlRetries,
              ptlAttemptsThisTurn,
            )
        if (recovered) {
          ptlAttemptsThisTurn = recovered.nextAttempts
          continue
        }
        emit(params, { type: 'error', message: modelError })
        const terminal: Terminal = { reason: 'error', detail: modelError }
        return finishTerminal(params, terminal)
      }

      // provider 已成功结束；此时才允许本地工具产生副作用。
      for (const block of toolBlocks) {
        streamTools?.addTool(block)
      }
      modelOk = true
      ptlAttemptsThisTurn = 0
      const apiDurationMs = Math.max(0, Date.now() - callStartedAt)

      // 本地 usage 累计（无遥测）：provider usage 优先，否则 chars/4
      if (params.usage) {
        const modelTag =
          typeof params.model === 'string' && params.model.trim()
            ? params.model.trim()
            : undefined
        const fromProvider = streamUsage
          ? normalizeProviderUsage(streamUsage)
          : null
        if (fromProvider) {
          accumulateSessionUsage(params.usage, {
            ...fromProvider,
            ...(modelTag ? { model: modelTag } : {}),
            apiDurationMs,
            // AR2A0a usage 锚：记录 call 时会话消息数与前缀形状指纹。
            // 只在 provider 真实 usage 上记；估算 usage 锚定无意义。
            messageCountAtCall: params.messages.length,
            messagePrefixFingerprint: fingerprintMessagePrefix(
              params.messages,
              params.messages.length,
            ),
          })
        } else {
          accumulateSessionUsage(params.usage, {
            ...estimateUsageFromCharCounts({
              inputChars: messageChars(messagesForQuery),
              outputChars: assistantText.length + toolArgsChars,
            }),
            ...(modelTag ? { model: modelTag } : {}),
            apiDurationMs,
          })
        }
      }

      // 本地 prompt-cache 布局/TTL/tools/model/API-read 观测（无遥测）
      if (params.promptCacheState) {
        const stable =
          params.systemPromptSections?.length
            ? getCacheStablePrefix(params.systemPromptSections)
            : getCacheStablePrefix()
        notePromptCacheAfterModelCall(params.promptCacheState, {
          stablePrefix: stable,
          toolNames: tools.map((t) => t.name),
          model: params.model,
          effort: params.effortLevel,
          cacheReadTokens: streamUsage?.cacheReadInputTokens,
        })
      }
    }

    // OpenAI 回灌：assistant 需带 tool_calls 结构
    if (toolBlocks.length > 0) {
      const msg: (typeof params.messages)[number] = {
        role: 'assistant',
        content: assistantText || '',
        tool_calls: toolBlocks.map((t) => ({
          id: t.id,
          name: t.name,
          arguments: t.argumentsJson ?? JSON.stringify(t.input ?? {}),
        })),
      }
      if (params.persistReasoning && assistantReasoning.trim()) {
        msg.reasoning_content = assistantReasoning
      }
      params.messages.push(msg)
    } else if (assistantText || (params.persistReasoning && assistantReasoning.trim())) {
      const msg: (typeof params.messages)[number] = {
        role: 'assistant',
        content: assistantText || '',
      }
      if (params.persistReasoning && assistantReasoning.trim()) {
        msg.reasoning_content = assistantReasoning
      }
      params.messages.push(msg)
    }

    await visitSafeBoundary(params, 'after_provider')

    if (toolBlocks.length === 0) {
      streamTools?.discard()
      const promoted = await visitSafeBoundary(params, 'before_stop')
      if (promoted > 0) {
        emit(params, { type: 'phase', phase: 'running' })
        continue
      }
      emit(params, { type: 'phase', phase: 'stopping' })
      const stop = await runStopHooks(params)
      // H1：exit 2 → 注入 continuation 再入 loop（有预算）
      if (
        stop.shouldContinue &&
        stop.continuationText &&
        stopContinuations < maxStopContinuations
      ) {
        stopContinuations += 1
        params.messages.push({
          role: 'user',
          content: `[Stop hook continuation]\n${stop.continuationText}`,
        })
        emit(params, {
          type: 'hook',
          event: 'Stop',
          exitCode: 2,
          blocked: true,
        })
        emit(params, { type: 'phase', phase: 'running' })
        continue
      }
      const terminal: Terminal = { reason: 'completed' }
      emit(params, { type: 'phase', phase: 'ready' })
      return finishTerminal(params, terminal)
    }

    await visitSafeBoundary(params, 'before_tools')
    // 流式已启动的 tool 按入队序收齐（与 runTools 分区并发语义一致）
    const toolResultMessages = streamTools
      ? await streamTools.drain()
      : []

    for (const m of toolResultMessages) {
      params.messages.push(m)
    }
    await visitSafeBoundary(params, 'after_tools')

    // C3：tool 批后、下一 callModel 前 — mid-turn auto compact（每 outer turn ≤1）
    if (midTurnEnabled && !midTurnCompacted) {
      const tryFn =
        params.tryMidTurnCompact ?? params.sessionRef?.tryMidTurnCompact
      if (typeof tryFn === 'function') {
        try {
          const did = await tryFn()
          if (did) {
            midTurnCompacted = true
            emit(params, { type: 'mid_turn_compact', ok: true })
          }
        } catch {
          emit(params, { type: 'mid_turn_compact', ok: false })
        }
      }
    }
    await visitSafeBoundary(params, 'after_compact')
  }
}

/**
 * PTL 恢复：若识别为上下文过长且未超限，截断 session.messages 并返回新 attempt 计数。
 * 截断后下一轮会再跑 prepareMessages（micro / auto）。
 */
function tryPtlRecover(
  params: QueryLoopParams,
  errorMessage: string,
  maxPtlRetries: number,
  ptlAttemptsThisTurn: number,
): { nextAttempts: number } | null {
  if (maxPtlRetries <= 0) return null
  if (!isPromptTooLongError(errorMessage)) return null
  if (ptlAttemptsThisTurn >= maxPtlRetries) return null

  const truncated = truncateHeadForPtlRetry(params.messages)
  if (!truncated) return null

  const nextAttempts = ptlAttemptsThisTurn + 1
  params.messages.length = 0
  params.messages.push(...truncated.messages)

  emit(params, {
    type: 'ptl_retry',
    attempt: nextAttempts,
    maxRetries: maxPtlRetries,
    droppedMessageCount: truncated.droppedMessageCount,
  })
  return { nextAttempts }
}

async function runStopHooks(params: QueryLoopParams): Promise<{
  shouldContinue: boolean
  continuationText: string
}> {
  const stop = await runHooks(
    'Stop',
    {
      hook_event_name: 'Stop',
      session_id: params.sessionId,
      cwd: params.cwd,
      timestamp: nowIso(),
    },
    params.hooks,
    { signal: params.signal },
  )
  for (const r of stop.results) {
    emit(params, {
      type: 'hook',
      event: 'Stop',
      exitCode: r.exitCode,
      blocked: r.blocked,
    })
  }
  try {
    const { appendHookDiag, diagEntriesFromHookRun } = await import(
      './hookDiag.ts'
    )
    if (params.sessionRef) {
      for (const e of diagEntriesFromHookRun({
        event: 'Stop',
        results: stop.results,
        blockReason: stop.blockReason,
      })) {
        params.sessionRef.hookDiagLog = appendHookDiag(
          params.sessionRef.hookDiagLog,
          e,
        )
      }
    }
  } catch {
    /* ignore */
  }
  const continuationText = (stop.continuationText || stop.blockReason || '').trim()
  return {
    shouldContinue: stop.blocked && continuationText.length > 0,
    continuationText,
  }
}
