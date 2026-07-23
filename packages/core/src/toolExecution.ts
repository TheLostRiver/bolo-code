/**
 * 单 tool 执行 — 对照 HelsincyCode toolExecution.runToolUse
 *
 * 顺序：
 *   findTool → inputSchema validate → validateInput?
 *   → PreToolUse → PermissionGate(mode) + tool.checkPermissions
 *   → hooks/UI → call → PostToolUse → tool_result
 *
 * 无遥测。
 */

import {
  decidePermission,
  type PermissionMode,
} from '../../permissions/src/index.ts'
import { runHooks } from '../../hooks/src/index.ts'
import { nowIso, type ChatMessage, type HooksConfig } from '../../shared/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import {
  createBuiltinTools,
  findToolByName,
  formatToolUseError,
  validateAgainstJsonSchema,
  type BoloTool,
  type ToolResult,
} from '../../tools/src/index.ts'
import type { QueryDeps } from './deps.ts'
import type { QueryLoopEvent } from './queryLoop.ts'

export type ToolUseBlock = {
  id: string
  name: string
  input: unknown
  argumentsJson?: string
}

export type ToolExecutionEvent =
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean }
  | { type: 'permission_request'; id: string; name: string; input: unknown }
  | { type: 'permission_decision'; mode: string; behavior: string; reason: string }
  | { type: 'phase'; phase: 'awaiting_permission' | 'running' }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | {
      type: 'tool_end'
      id: string
      name: string
      output: string
      ok: boolean
      isError?: boolean
    }

export type AskPermissionFn = (req: {
  toolName: string
  toolInput: unknown
  toolUseId: string
}) => Promise<'allow' | 'deny'>

export type RunToolUseContext = {
  sessionId: string
  cwd: string
  hooks: HooksConfig
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  skills?: LoadedSkill[]
  /** 默认：内置 + Agent */
  tools?: readonly BoloTool[]
  /** 供 Agent 工具 runSubagent */
  deps?: QueryDeps
  signal?: AbortSignal
  onEvent?: (e: ToolExecutionEvent | QueryLoopEvent) => void
}

export type RunToolUseResult = {
  toolResultMessage: ChatMessage
  blocked: boolean
  denied: boolean
  /** 工具声明可并发 */
  concurrencySafe: boolean
}

function emit(ctx: RunToolUseContext, e: ToolExecutionEvent) {
  ctx.onEvent?.(e)
}

function parseInput(block: ToolUseBlock): unknown {
  if (block.input !== undefined && block.input !== null) return block.input
  if (block.argumentsJson) {
    try {
      return JSON.parse(block.argumentsJson)
    } catch {
      return { raw: block.argumentsJson }
    }
  }
  return {}
}

function toolResultMessage(
  toolUseId: string,
  name: string,
  content: string,
  isError?: boolean,
): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: toolUseId,
    name,
    content,
  }
}

function endResult(
  ctx: RunToolUseContext,
  toolUseId: string,
  name: string,
  content: string,
  flags: {
    blocked: boolean
    denied: boolean
    ok: boolean
    isError?: boolean
    concurrencySafe?: boolean
  },
): RunToolUseResult {
  emit(ctx, {
    type: 'tool_end',
    id: toolUseId,
    name,
    output: content,
    ok: flags.ok,
    isError: flags.isError,
  })
  return {
    blocked: flags.blocked,
    denied: flags.denied,
    concurrencySafe: flags.concurrencySafe ?? false,
    toolResultMessage: toolResultMessage(toolUseId, name, content, flags.isError),
  }
}

export async function runToolUse(
  block: ToolUseBlock,
  ctx: RunToolUseContext,
): Promise<RunToolUseResult> {
  const rawInput = parseInput(block)
  const { id: toolUseId, name } = block
  const tools = ctx.tools ?? createBuiltinTools()
  const tool = findToolByName(tools, name)

  // --- Unknown tool（对照 HC）---
  if (!tool) {
    const content = formatToolUseError(`Error: No such tool available: ${name}`)
    return endResult(ctx, toolUseId, name, content, {
      blocked: false,
      denied: false,
      ok: false,
      isError: true,
    })
  }

  // --- Schema validate（对照 zod safeParse）---
  const parsed = validateAgainstJsonSchema(tool.inputJSONSchema, rawInput)
  if (!parsed.success) {
    const content = formatToolUseError(parsed.error)
    return endResult(ctx, toolUseId, name, content, {
      blocked: false,
      denied: false,
      ok: false,
      isError: true,
      concurrencySafe: tool.isConcurrencySafe(rawInput),
    })
  }
  let toolInput = parsed.data

  // --- validateInput ---
  if (tool.validateInput) {
    const v = await tool.validateInput(toolInput, {
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      extras: { skills: ctx.skills },
    })
    if (!v.ok) {
      const content = formatToolUseError(v.message)
      return endResult(ctx, toolUseId, name, content, {
        blocked: false,
        denied: false,
        ok: false,
        isError: true,
        concurrencySafe: tool.isConcurrencySafe(toolInput),
      })
    }
  }

  const concurrencySafe = tool.isConcurrencySafe(toolInput)

  // --- PreToolUse ---
  const pre = await runHooks(
    'PreToolUse',
    {
      hook_event_name: 'PreToolUse',
      session_id: ctx.sessionId,
      cwd: ctx.cwd,
      timestamp: nowIso(),
      tool_name: name,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    },
    ctx.hooks,
  )
  for (const r of pre.results) {
    emit(ctx, {
      type: 'hook',
      event: 'PreToolUse',
      exitCode: r.exitCode,
      blocked: r.blocked,
    })
  }
  if (pre.blocked) {
    return endResult(
      ctx,
      toolUseId,
      name,
      formatToolUseError(`blocked by PreToolUse: ${pre.blockReason}`),
      {
        blocked: true,
        denied: false,
        ok: false,
        isError: true,
        concurrencySafe,
      },
    )
  }

  // --- 全局 PermissionGate + tool.checkPermissions ---
  const gate = decidePermission({
    mode: ctx.permissionMode,
    toolName: name,
    toolInput,
    cwd: ctx.cwd,
    requiresPermission: tool.requiresPermission,
  })
  emit(ctx, {
    type: 'permission_decision',
    mode: gate.mode,
    behavior: gate.behavior,
    reason: gate.reason,
  })

  let finalBehavior = gate.behavior

  const toolPerm = await tool.checkPermissions(toolInput, {
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
  })
  if (toolPerm.behavior === 'deny') {
    finalBehavior = 'deny'
  } else if (toolPerm.behavior === 'ask' && finalBehavior === 'allow') {
    // 工具要求 ask 时不能比全局更松
    finalBehavior = 'ask'
  }

  if (finalBehavior === 'deny') {
    return endResult(
      ctx,
      toolUseId,
      name,
      formatToolUseError(
        `permission denied (${toolPerm.reason ?? gate.reason})`,
      ),
      {
        blocked: false,
        denied: true,
        ok: false,
        isError: true,
        concurrencySafe,
      },
    )
  }

  if (finalBehavior === 'ask') {
    emit(ctx, { type: 'phase', phase: 'awaiting_permission' })
    emit(ctx, {
      type: 'permission_request',
      id: toolUseId,
      name,
      input: toolInput,
    })

    const hookRes = await runHooks(
      'PermissionRequest',
      {
        hook_event_name: 'PermissionRequest',
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        timestamp: nowIso(),
        tool_name: name,
        tool_input: toolInput,
        tool_use_id: toolUseId,
      },
      ctx.hooks,
    )
    for (const r of hookRes.results) {
      emit(ctx, {
        type: 'hook',
        event: 'PermissionRequest',
        exitCode: r.exitCode,
      })
    }

    const fromHook = hookRes.permissionDecision
    if (fromHook === 'allow' || fromHook === 'deny') {
      finalBehavior = fromHook
    } else {
      const user = await ctx.askPermission({
        toolName: name,
        toolInput,
        toolUseId,
      })
      finalBehavior = user
    }

    if (finalBehavior === 'deny') {
      return endResult(
        ctx,
        toolUseId,
        name,
        formatToolUseError('permission denied (user/hook)'),
        {
          blocked: false,
          denied: true,
          ok: false,
          isError: true,
          concurrencySafe,
        },
      )
    }
  }

  // --- Execute ---
  if (ctx.signal?.aborted) {
    return endResult(
      ctx,
      toolUseId,
      name,
      formatToolUseError('Error: tool cancelled'),
      {
        blocked: false,
        denied: false,
        ok: false,
        isError: true,
        concurrencySafe,
      },
    )
  }

  emit(ctx, { type: 'phase', phase: 'running' })
  emit(ctx, { type: 'tool_start', id: toolUseId, name, input: toolInput })

  let result: ToolResult
  try {
    result = await tool.call(toolInput, {
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      extras: {
        skills: ctx.skills,
        subagentParent: ctx.deps
          ? {
              parentSessionId: ctx.sessionId,
              cwd: ctx.cwd,
              hooks: ctx.hooks,
              deps: ctx.deps,
              permissionMode: ctx.permissionMode,
              askPermission: ctx.askPermission,
              allTools: tools,
              skills: ctx.skills,
              signal: ctx.signal,
              onEvent: ctx.onEvent,
            }
          : undefined,
      },
    })
  } catch (e) {
    result = {
      ok: false,
      isError: true,
      output: formatToolUseError(e instanceof Error ? e.message : String(e)),
      errorCode: 'throw',
    }
  }

  const content =
    result.isError && !result.output.includes('tool_use_error')
      ? formatToolUseError(result.output)
      : result.output

  emit(ctx, {
    type: 'tool_end',
    id: toolUseId,
    name,
    output: content,
    ok: result.ok,
    isError: result.isError,
  })

  // --- PostToolUse ---
  const post = await runHooks(
    'PostToolUse',
    {
      hook_event_name: 'PostToolUse',
      session_id: ctx.sessionId,
      cwd: ctx.cwd,
      timestamp: nowIso(),
      tool_name: name,
      tool_input: toolInput,
      tool_response: result,
      tool_use_id: toolUseId,
    },
    ctx.hooks,
  )
  for (const r of post.results) {
    emit(ctx, { type: 'hook', event: 'PostToolUse', exitCode: r.exitCode })
  }

  return {
    blocked: false,
    denied: false,
    concurrencySafe,
    toolResultMessage: toolResultMessage(
      toolUseId,
      name,
      content,
      result.isError,
    ),
  }
}