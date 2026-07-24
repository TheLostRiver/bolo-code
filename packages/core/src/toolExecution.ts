/**
 * 单 tool 执行 — 对照 HelsincyCode toolExecution.runToolUse
 *
 * 顺序：
 *   findTool → inputSchema validate → validateInput?
 *   → PreToolUse → PermissionGate(mode) + tool.checkPermissions
 *   → hooks/UI → call → truncate tool_result → PostToolUse → tool_result
 *
 * 无遥测。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  addAlwaysAllowToolName,
  decidePermission,
  type PermissionMode,
  type SessionPermissionRules,
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

/** 单条 tool_result 写入 transcript 的字符上限（C6 类；可配置） */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000

/**
 * 超长 tool 输出截断；对照 HC maxResultSizeChars 语义（无遥测）。
 * 后缀说明完整结果未进 transcript。
 */
export function truncateToolResultOutput(
  output: string,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): { text: string; truncated: boolean; omittedChars: number } {
  const limit = Math.max(0, maxChars)
  if (output.length <= limit) {
    return { text: output, truncated: false, omittedChars: 0 }
  }
  const omitted = output.length - limit
  return {
    text:
      output.slice(0, limit) +
      `\n…(truncated ${omitted} chars; full result not stored in transcript)`,
    truncated: true,
    omittedChars: omitted,
  }
}

async function maybeSpillTruncatedToolResult(opts: {
  cwd: string
  toolUseId: string
  fullOutput: string
}): Promise<string | undefined> {
  try {
    const dir = path.join(opts.cwd, '.bolo', 'sessions', 'tool-results')
    await fs.mkdir(dir, { recursive: true })
    const safeId = opts.toolUseId.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const filePath = path.join(dir, `${safeId || 'tool'}.txt`)
    await fs.writeFile(filePath, opts.fullOutput, 'utf8')
    return filePath
  } catch {
    return undefined
  }
}

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

/** UI/CLI 权限应答：allow_always = 本会话记住该 tool 名 */
export type AskPermissionDecision = 'allow' | 'deny' | 'allow_always'

export type AskPermissionFn = (req: {
  toolName: string
  toolInput: unknown
  toolUseId: string
}) => Promise<AskPermissionDecision>

export type RunToolUseContext = {
  sessionId: string
  cwd: string
  hooks: HooksConfig
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  /** 会话 Always-allow；ask 选 a 时就地写入 */
  permissionRules?: SessionPermissionRules
  /** tool_result 字符预算；默认 DEFAULT_MAX_TOOL_RESULT_CHARS */
  maxToolResultChars?: number
  /**
   * 截断后是否把全文落到 `.bolo/sessions/tool-results/<id>.txt`。
   * 默认 true。
   */
  spillTruncatedToolResults?: boolean
  skills?: LoadedSkill[]
  /** 默认：内置 + Agent */
  tools?: readonly BoloTool[]
  /** 供 Agent 工具 runSubagent */
  deps?: QueryDeps
  /** 活跃 agent 定义；注入 subagentParent */
  agentDefinitions?: import('./subagent.ts').ActiveAgentDefinitions
  /** 后台 subagent 状态表 */
  backgroundStore?: import('./subagent.ts').BackgroundAgentStore
  /** 父会话 messages；后台完成后可选推 system 通知 */
  parentMessages?: import('../../shared/src/index.ts').ChatMessage[]
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
    rules: ctx.permissionRules,
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
    // 工具要求 ask 时不能比全局更松（会话 always-allow 仍可被工具硬 deny 挡住）
    if (!gate.reason.includes('always-allow')) {
      finalBehavior = 'ask'
    }
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
      if (user === 'allow_always') {
        if (ctx.permissionRules) {
          addAlwaysAllowToolName(ctx.permissionRules, name)
        }
        finalBehavior = 'allow'
      } else {
        finalBehavior = user
      }
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
              permissionRules: ctx.permissionRules,
              maxToolResultChars: ctx.maxToolResultChars,
              allTools: tools,
              skills: ctx.skills,
              agentDefinitions: ctx.agentDefinitions,
              signal: ctx.signal,
              onEvent: ctx.onEvent,
              backgroundStore: ctx.backgroundStore,
              parentMessages: ctx.parentMessages,
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

  let content =
    result.isError && !result.output.includes('tool_use_error')
      ? formatToolUseError(result.output)
      : result.output

  // --- tool_result 字符预算（C6）---
  const maxChars = ctx.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
  const trunc = truncateToolResultOutput(content, maxChars)
  if (trunc.truncated) {
    let note = trunc.text
    if (ctx.spillTruncatedToolResults !== false) {
      const spillPath = await maybeSpillTruncatedToolResult({
        cwd: ctx.cwd,
        toolUseId,
        fullOutput: content,
      })
      if (spillPath) {
        note += `\n[full result: ${spillPath}]`
      }
    }
    content = note
  }

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