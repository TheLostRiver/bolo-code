/**
 * 单 tool 执行 — 对照 HelsincyCode toolExecution.runToolUse
 * 顺序：resolve → PreToolUse → PermissionGate(mode) → hooks/UI → execute → PostToolUse
 */

import {
  decidePermission,
  type PermissionMode,
} from '../../permissions/src/index.ts'
import { runHooks } from '../../hooks/src/index.ts'
import { nowIso, type ChatMessage, type HooksConfig } from '../../shared/src/index.ts'
import { executeTool, getToolSpec } from '../../tools/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'

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
  | { type: 'tool_end'; id: string; name: string; output: string; ok: boolean }

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
  onEvent?: (e: ToolExecutionEvent) => void
}

export type RunToolUseResult = {
  toolResultMessage: ChatMessage
  blocked: boolean
  denied: boolean
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

function denyResult(
  toolUseId: string,
  name: string,
  content: string,
  ctx: RunToolUseContext,
  flags: { blocked: boolean; denied: boolean },
): RunToolUseResult {
  emit(ctx, {
    type: 'tool_end',
    id: toolUseId,
    name,
    output: content,
    ok: false,
  })
  return {
    blocked: flags.blocked,
    denied: flags.denied,
    toolResultMessage: {
      role: 'tool',
      tool_call_id: toolUseId,
      name,
      content,
    },
  }
}

export async function runToolUse(
  block: ToolUseBlock,
  ctx: RunToolUseContext,
): Promise<RunToolUseResult> {
  const toolInput = parseInput(block)
  const { id: toolUseId, name } = block
  const spec = getToolSpec(name)

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
    return denyResult(
      toolUseId,
      name,
      `blocked by PreToolUse: ${pre.blockReason}`,
      ctx,
      { blocked: true, denied: false },
    )
  }

  // --- PermissionGate (mode) — 对照 HC 模式层 ---
  const gate = decidePermission({
    mode: ctx.permissionMode,
    toolName: name,
    toolInput,
    cwd: ctx.cwd,
    requiresPermission: spec?.requiresPermission,
  })
  emit(ctx, {
    type: 'permission_decision',
    mode: gate.mode,
    behavior: gate.behavior,
    reason: gate.reason,
  })

  let finalBehavior = gate.behavior

  if (finalBehavior === 'deny') {
    return denyResult(toolUseId, name, `permission denied (${gate.reason})`, ctx, {
      blocked: false,
      denied: true,
    })
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
      return denyResult(toolUseId, name, 'permission denied (user/hook)', ctx, {
        blocked: false,
        denied: true,
      })
    }
  }

  // --- Execute ---
  emit(ctx, { type: 'phase', phase: 'running' })
  emit(ctx, { type: 'tool_start', id: toolUseId, name, input: toolInput })
  const result = await executeTool(name, toolInput, {
    cwd: ctx.cwd,
    skills: ctx.skills,
  })
  emit(ctx, {
    type: 'tool_end',
    id: toolUseId,
    name,
    output: result.output,
    ok: result.ok,
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
    toolResultMessage: {
      role: 'tool',
      tool_call_id: toolUseId,
      name,
      content: result.output,
    },
  }
}