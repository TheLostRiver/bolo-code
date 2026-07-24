/**
 * queryLoop — 对照 HelsincyCode query.ts queryLoop
 *
 * while true:
 *   prepareMessages（默认链：microcompact → auto full compact）
 *   callModel stream (+ tools)
 *     若 429/5xx/timeout：wrapCallModelWithRetry 退避（deps 默认包装）
 *     若 PTL：截断最旧 API 轮次 → 写回 session → 再 prepare → 重试（有限次）
 *   if tool_use → runTools → continue
 *   else → Stop hooks → terminal
 */

import { runHooks } from '../../hooks/src/index.ts'
import {
  isPromptTooLongError,
  truncateHeadForPtlRetry,
  DEFAULT_MAX_PTL_RETRIES,
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
import { runTools } from './toolOrchestration.ts'
import { prepareModelMessages } from './systemPrompt.ts'
import {
  accumulateSessionUsage,
  estimateUsageFromCharCounts,
  messageChars,
  normalizeProviderUsage,
  type SessionUsage,
} from './sessionUsage.ts'

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
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean }
  | { type: 'error'; message: string }
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
  | { type: 'done'; terminal: Terminal }
  | ToolExecutionEvent

export type QueryLoopParams = {
  sessionId: string
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
   * 会话 effort 档位（/effort）；透传 callModel → provider max_tokens 映射。
   */
  effortLevel?: string
  onEvent?: (e: QueryLoopEvent) => void
  signal?: AbortSignal
}

function emit(params: QueryLoopParams, e: QueryLoopEvent) {
  params.onEvent?.(e)
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
          m.content.trim() === 'Conversation compacted',
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

  while (true) {
    if (params.signal?.aborted) {
      const terminal: Terminal = { reason: 'aborted' }
      emit(params, { type: 'done', terminal })
      return terminal
    }

    turnCount += 1
    if (turnCount > maxTurns) {
      const terminal: Terminal = {
        reason: 'max_turns',
        detail: `maxTurns=${maxTurns}`,
      }
      emit(params, { type: 'phase', phase: 'stopping' })
      await runStopHooks(params)
      emit(params, { type: 'done', terminal })
      return terminal
    }

    emit(params, { type: 'phase', phase: 'running' })

    // 同一 turn 内：callModel 失败且为 PTL 时截断后 continue，不额外消耗 maxTurns
    let modelOk = false
    let assistantText = ''
    const toolBlocks: ToolUseBlock[] = []

    while (!modelOk) {
      if (params.signal?.aborted) {
        const terminal: Terminal = { reason: 'aborted' }
        emit(params, { type: 'done', terminal })
        return terminal
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
      toolBlocks.length = 0
      let modelError: string | undefined
      let streamUsage: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
      } | null = null
      let toolArgsChars = 0

      try {
        for await (const ev of params.deps.callModel({
          messages: messagesForQuery,
          signal: params.signal,
          tools,
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
            emit(params, { type: 'text', text: ev.text })
          } else if (ev.type === 'tool_call') {
            let input: unknown = {}
            try {
              input = ev.arguments ? JSON.parse(ev.arguments) : {}
            } catch {
              input = { raw: ev.arguments }
            }
            toolArgsChars += (ev.arguments ?? '').length
            toolBlocks.push({
              id: ev.id || params.deps.uuid(),
              name: ev.name,
              input,
              argumentsJson: ev.arguments,
            })
          } else if (ev.type === 'usage') {
            streamUsage = {
              inputTokens: ev.usage?.inputTokens,
              outputTokens: ev.usage?.outputTokens,
              totalTokens: ev.usage?.totalTokens,
            }
          } else if (ev.type === 'error') {
            modelError = ev.message
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const classified = classifyError(e, { signal: params.signal })
        if (classified.class === 'user_abort' || params.signal?.aborted) {
          const terminal: Terminal = { reason: 'aborted', detail: msg }
          emit(params, { type: 'done', terminal })
          return terminal
        }
        const recovered = tryPtlRecover(
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
        emit(params, { type: 'done', terminal })
        return terminal
      }

      if (modelError && !assistantText && toolBlocks.length === 0) {
        const classified = classifyError(modelError, {
          signal: params.signal,
        })
        if (classified.class === 'user_abort' || params.signal?.aborted) {
          const terminal: Terminal = {
            reason: 'aborted',
            detail: modelError,
          }
          emit(params, { type: 'done', terminal })
          return terminal
        }
        const recovered = tryPtlRecover(
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
        emit(params, { type: 'done', terminal })
        return terminal
      }

      modelOk = true
      ptlAttemptsThisTurn = 0

      // 本地 usage 累计（无遥测）：provider usage 优先，否则 chars/4
      if (params.usage) {
        const fromProvider = streamUsage
          ? normalizeProviderUsage(streamUsage)
          : null
        if (fromProvider) {
          accumulateSessionUsage(params.usage, fromProvider)
        } else {
          accumulateSessionUsage(
            params.usage,
            estimateUsageFromCharCounts({
              inputChars: messageChars(messagesForQuery),
              outputChars: assistantText.length + toolArgsChars,
            }),
          )
        }
      }
    }

    // OpenAI 回灌：assistant 需带 tool_calls 结构
    if (toolBlocks.length > 0) {
      params.messages.push({
        role: 'assistant',
        content: assistantText || '',
        tool_calls: toolBlocks.map((t) => ({
          id: t.id,
          name: t.name,
          arguments: t.argumentsJson ?? JSON.stringify(t.input ?? {}),
        })),
      })
    } else if (assistantText) {
      params.messages.push({ role: 'assistant', content: assistantText })
    }

    if (toolBlocks.length === 0) {
      emit(params, { type: 'phase', phase: 'stopping' })
      await runStopHooks(params)
      const terminal: Terminal = { reason: 'completed' }
      emit(params, { type: 'phase', phase: 'ready' })
      emit(params, { type: 'done', terminal })
      return terminal
    }

    const { toolResultMessages } = await runTools({
      blocks: toolBlocks,
      sessionId: params.sessionId,
      cwd: params.cwd,
      hooks: params.hooks,
      permissionMode: params.permissionMode,
      askPermission: params.askPermission,
      permissionRules: params.permissionRules,
      maxToolResultChars: params.maxToolResultChars,
      spillTruncatedToolResults: params.spillTruncatedToolResults,
      skills: params.skills,
      tools,
      deps: params.deps,
      agentDefinitions: params.agentDefinitions,
      backgroundStore: params.backgroundStore,
      parentMessages: params.messages,
      parentSystemPromptSections: params.systemPromptSections,
      signal: params.signal,
      onEvent: params.onEvent,
    })

    for (const m of toolResultMessages) {
      params.messages.push(m)
    }
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

async function runStopHooks(params: QueryLoopParams): Promise<void> {
  const stop = await runHooks(
    'Stop',
    {
      hook_event_name: 'Stop',
      session_id: params.sessionId,
      cwd: params.cwd,
      timestamp: nowIso(),
    },
    params.hooks,
  )
  for (const r of stop.results) {
    emit(params, {
      type: 'hook',
      event: 'Stop',
      exitCode: r.exitCode,
    })
  }
}