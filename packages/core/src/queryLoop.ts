/**
 * queryLoop — 对照 HelsincyCode query.ts queryLoop
 *
 * while true:
 *   prepareMessages (micro/auto 挂点)
 *   callModel stream (+ tools)
 *   if tool_use → runTools → continue
 *   else → Stop hooks → terminal
 */

import { runHooks } from '../../hooks/src/index.ts'
import {
  nowIso,
  type ChatMessage,
  type HooksConfig,
} from '../../shared/src/index.ts'
import { createBuiltinTools, type BoloTool } from '../../tools/src/index.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import type { QueryDeps } from './deps.ts'
import type {
  AskPermissionFn,
  ToolExecutionEvent,
  ToolUseBlock,
} from './toolExecution.ts'
import { runTools } from './toolOrchestration.ts'

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
  | { type: 'done'; terminal: Terminal }
  | ToolExecutionEvent

export type QueryLoopParams = {
  sessionId: string
  cwd: string
  hooks: HooksConfig
  messages: ChatMessage[]
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  maxTurns?: number
  querySource?: string
  /** 默认内置工具集（HC buildTool 契约） */
  tools?: readonly BoloTool[]
  /** 会话 skill 注册表（Skill 工具按需加载全文） */
  skills?: LoadedSkill[]
  onEvent?: (e: QueryLoopEvent) => void
  signal?: AbortSignal
}

function emit(params: QueryLoopParams, e: QueryLoopEvent) {
  params.onEvent?.(e)
}

export async function queryLoop(params: QueryLoopParams): Promise<Terminal> {
  const maxTurns = params.maxTurns ?? 8
  const querySource = params.querySource ?? 'repl_main_thread'
  const tools = params.tools ?? createBuiltinTools()
  let turnCount = 0

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

    const prepared = await params.deps.prepareMessages({
      messages: params.messages,
      querySource,
      tokenCount: 0,
    })
    if (prepared.didCompact) {
      params.messages.length = 0
      params.messages.push(...prepared.messages)
    }
    const messagesForQuery = prepared.didCompact
      ? params.messages
      : prepared.messages

    let assistantText = ''
    const toolBlocks: ToolUseBlock[] = []
    let modelError: string | undefined

    try {
      for await (const ev of params.deps.callModel({
        messages: messagesForQuery,
        signal: params.signal,
        tools,
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
          toolBlocks.push({
            id: ev.id || params.deps.uuid(),
            name: ev.name,
            input,
            argumentsJson: ev.arguments,
          })
        } else if (ev.type === 'error') {
          modelError = ev.message
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      emit(params, { type: 'error', message: msg })
      const terminal: Terminal = { reason: 'error', detail: msg }
      emit(params, { type: 'done', terminal })
      return terminal
    }

    if (modelError && !assistantText && toolBlocks.length === 0) {
      emit(params, { type: 'error', message: modelError })
      const terminal: Terminal = { reason: 'error', detail: modelError }
      emit(params, { type: 'done', terminal })
      return terminal
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
      skills: params.skills,
      tools,
      signal: params.signal,
      onEvent: params.onEvent,
    })

    for (const m of toolResultMessages) {
      params.messages.push(m)
    }
  }
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