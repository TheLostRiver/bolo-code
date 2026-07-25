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
  createAutoModeState,
  recordAutoClassifySuccess,
  recordAutoClassifyFailure,
  formatAutoClassifyAuditNote,
  previewToolInputForAudit,
  AUTO_CLASSIFY_NOTE_KIND,
  type PermissionMode,
  type SessionPermissionRules,
  type AutoModeState,
  type AutoClassifyFn,
  type AutoClassifyInput,
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
  | {
      type: 'permission_request'
      id: string
      name: string
      input: unknown
      /** 写前文件 diff 预览（Edit/Write/apply_patch） */
      preview?: {
        added: number
        removed: number
        paths: string[]
        summaryText: string
        unifiedPreview?: string
      }
    }
  | { type: 'permission_decision'; mode: string; behavior: string; reason: string }
  | { type: 'phase'; phase: 'awaiting_permission' | 'running' }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | {
      type: 'tool_progress'
      id: string
      name: string
      message: string
    }
  | {
      type: 'tool_end'
      id: string
      name: string
      output: string
      ok: boolean
      isError?: boolean
      /** 文件改动摘要（Edit/Write/apply_patch） */
      path?: string
      added?: number
      removed?: number
      summaryLine?: string
      /** 可选 ANSI unified（仅 UI；默认不塞大段） */
      ansiUnified?: string
      /** U3：多文件列表供 history cell / Desktop */
      files?: Array<{
        path: string
        op?: string
        added?: number
        removed?: number
      }>
      /** U3：折叠态一行（无 ANSI 亦可） */
      cellCollapsed?: string
      /** U3：展开态多行 */
      cellExpanded?: string
    }

/** UI/CLI 权限应答：allow_always = 本会话记住该 tool 名 */
export type AskPermissionDecision = 'allow' | 'deny' | 'allow_always'

export type PermissionPreviewPayload = {
  added: number
  removed: number
  paths: string[]
  summaryText: string
  unifiedPreview?: string
  tool?: string
  files?: Array<{
    path: string
    op?: string
    added?: number
    removed?: number
    structuredPatch?: Array<{
      oldStart: number
      oldLines: number
      newStart: number
      newLines: number
      lines: string[]
    }>
  }>
}

export type AskPermissionFn = (req: {
  toolName: string
  toolInput: unknown
  toolUseId: string
  preview?: PermissionPreviewPayload
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
  /** 父会话 messages；后台完成通知 + fork 继承上下文 */
  parentMessages?: import('../../shared/src/index.ts').ChatMessage[]
  /** fork 时注入子 agent 的父 system 段 */
  parentSystemPromptSections?: readonly string[]
  /** 父会话 model（Agent → 子 usage.byModel / inherit） */
  model?: string
  /** 父会话 effort */
  parentEffort?: string
  /** 父会话 usage；子完成后 merge 回卷 */
  parentUsage?: import('./sessionUsage.ts').SessionUsage
  /** 全局 agent 策略 */
  agentPolicy?: import('./subagent.ts').AgentPolicy
  /** 当前 loop spawnDepth（主=0） */
  spawnDepth?: number
  /**
   * auto 模式分类器（Y2）。mode=auto 且规则层 ask 时调用。
   * 未注入则 auto 对非快路径 **deny**（fail-closed）。
   */
  classifyPermission?: AutoClassifyFn
  /** 会话 auto 状态（熔断 / lastReason） */
  autoModeState?: AutoModeState
  /**
   * 可选：会话引用，用于 auto 熔断 demote 回 default（Y3.2）。
   * 亦可挂 fileDiffLog / diffTurn（D2 文件改动 side-channel）。
   */
  sessionRef?: {
    permissionMode: PermissionMode
    autoModeState?: AutoModeState
    fileDiffLog?: import('./fileDiffLog.ts').FileChangeRecord[]
    /** 当前用户 turn 序号；submitPrompt 递增 */
    diffTurn?: number
    id?: string
    /** 可选：file_diff 摘要落盘（D6） */
    onFileDiffRecord?: (
      rec: import('./fileDiffLog.ts').FileChangeRecord,
    ) => void | Promise<void>
  }
  /**
   * Y3.6：auto 分类结果审计（对照 HC decision 事件；本地 system_note，无遥测）。
   * 失败必须静默，不得阻断 tool 路径。
   */
  onAutoClassifyAudit?: (note: {
    text: string
    kind: typeof AUTO_CLASSIFY_NOTE_KIND
  }) => void | Promise<void>
  signal?: AbortSignal
  onEvent?: (e: ToolExecutionEvent | QueryLoopEvent) => void
}

async function auditAutoClassify(
  ctx: RunToolUseContext,
  input: {
    toolName: string
    toolUseId: string
    toolInput: unknown
    decision: 'allow' | 'deny'
    reason: string
    stage?: string
    unavailable?: boolean
    demoted?: boolean
  },
): Promise<void> {
  const fn = ctx.onAutoClassifyAudit
  if (!fn) return
  try {
    const text = formatAutoClassifyAuditNote({
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      decision: input.decision,
      reason: input.reason,
      stage: input.stage,
      unavailable: input.unavailable,
      demoted: input.demoted,
      inputPreview: previewToolInputForAudit(input.toolInput),
    })
    await fn({ text, kind: AUTO_CLASSIFY_NOTE_KIND })
  } catch {
    // 审计失败不拖垮权限路径
  }
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

/** 供 auto 分类器的极简近期摘要（不进主对话） */
function summarizeRecentMessages(
  messages: import('../../shared/src/index.ts').ChatMessage[] | undefined,
  max = 8,
): string {
  if (!messages?.length) return ''
  const slice = messages.slice(-max)
  return slice
    .map((m) => {
      const role = m.role
      const content = (m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const tools = m.tool_calls?.map((t) => t.name).join(',')
      return tools
        ? `${role}: ${content} [tools:${tools}]`
        : `${role}: ${content}`
    })
    .join('\n')
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
    { signal: ctx.signal },
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
    // ── auto 模式：分类器（对照 HC YOLO 挂接点）──
    if (ctx.permissionMode === 'auto') {
      const autoState = ctx.autoModeState
      if (autoState?.circuitBroken) {
        if (autoState.fallback === 'ask') {
          // 熔断后回退 UI ask：fall through 到下方 hooks/UI
        } else {
          await auditAutoClassify(ctx, {
            toolName: name,
            toolUseId,
            toolInput,
            decision: 'deny',
            reason:
              autoState.lastReason ?? 'classifier unavailable',
            stage: 'circuit',
          })
          return endResult(
            ctx,
            toolUseId,
            name,
            formatToolUseError(
              `permission denied (auto circuit open: ${autoState.lastReason ?? 'classifier unavailable'})`,
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
      }
      if (!autoState?.circuitBroken || autoState.fallback !== 'ask') {
        const classify = ctx.classifyPermission
        if (!classify) {
          if (autoState) {
            recordAutoClassifyFailure(
              autoState,
              'no classifyPermission injected',
            )
          }
          await auditAutoClassify(ctx, {
            toolName: name,
            toolUseId,
            toolInput,
            decision: 'deny',
            reason: 'no classifier; fail-closed',
            stage: 'no_classifier',
            unavailable: true,
          })
          return endResult(
            ctx,
            toolUseId,
            name,
            formatToolUseError(
              'permission denied (auto: no classifier; fail-closed)',
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
        const recentSummary = summarizeRecentMessages(ctx.parentMessages)
        const classifyInput: AutoClassifyInput = {
          toolName: name,
          toolInput,
          cwd: ctx.cwd,
          recentSummary,
        }
        const result = await classify(classifyInput, {
          signal: ctx.signal,
        })
        if (result.unavailable) {
          let demoted = false
          if (autoState) {
            recordAutoClassifyFailure(autoState, result.reason)
            if (autoState.demoteToDefault && ctx.sessionRef) {
              ctx.sessionRef.permissionMode = 'default'
              autoState.demoteToDefault = false
              autoState.lastReason = `demoted to default: ${result.reason}`
              demoted = true
            }
          }
          emit(ctx, {
            type: 'permission_decision',
            mode: 'auto',
            behavior: 'deny',
            reason: result.reason,
          })
          await auditAutoClassify(ctx, {
            toolName: name,
            toolUseId,
            toolInput,
            decision: 'deny',
            reason: result.reason,
            stage: result.stage ?? 'single',
            unavailable: true,
            demoted,
          })
          return endResult(
            ctx,
            toolUseId,
            name,
            formatToolUseError(`permission denied (auto: ${result.reason})`),
            {
              blocked: false,
              denied: true,
              ok: false,
              isError: true,
              concurrencySafe,
            },
          )
        }
        if (autoState) {
          recordAutoClassifySuccess(autoState, result.decision, result.reason)
        }
        emit(ctx, {
          type: 'permission_decision',
          mode: 'auto',
          behavior: result.decision,
          reason: result.reason,
        })
        await auditAutoClassify(ctx, {
          toolName: name,
          toolUseId,
          toolInput,
          decision: result.decision,
          reason: result.reason,
          stage: result.stage ?? 'single',
        })
        if (result.decision === 'deny') {
          return endResult(
            ctx,
            toolUseId,
            name,
            formatToolUseError(`permission denied (auto: ${result.reason})`),
            {
              blocked: false,
              denied: true,
              ok: false,
              isError: true,
              concurrencySafe,
            },
          )
        }
        finalBehavior = 'allow'
      }
    }

    if (finalBehavior === 'ask') {
    // D3：写前 preview（失败静默）；U2 可含 files 供审批面板
    let previewPayload:
      | import('../../tools/src/fileChangePreview.ts').PermissionPreviewPayload
      | undefined
    try {
      const { previewFileToolChange, toPermissionPreviewPayload } = await import(
        '../../tools/src/fileChangePreview.ts'
      )
      const full = await previewFileToolChange(name, toolInput, ctx.cwd)
      previewPayload = toPermissionPreviewPayload(full)
    } catch {
      previewPayload = undefined
    }

    emit(ctx, { type: 'phase', phase: 'awaiting_permission' })
    emit(ctx, {
      type: 'permission_request',
      id: toolUseId,
      name,
      input: toolInput,
      ...(previewPayload ? { preview: previewPayload } : {}),
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
      { signal: ctx.signal },
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
        ...(previewPayload ? { preview: previewPayload } : {}),
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
    } // end if still ask (UI path)
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
      onProgress: (message) => {
        const m = typeof message === 'string' ? message.trim() : ''
        if (!m) return
        emit(ctx, {
          type: 'tool_progress',
          id: toolUseId,
          name,
          message: m.length > 200 ? `${m.slice(0, 199)}…` : m,
        })
      },
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
              parentSystemPromptSections: ctx.parentSystemPromptSections,
              model: ctx.model,
              parentUsage: ctx.parentUsage,
              effort: ctx.parentEffort,
              agentPolicy: ctx.agentPolicy,
              spawnDepth: ctx.spawnDepth ?? 0,
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

  // D4/D7/U3：tool_end 摘要 + history cell（UI）；模型 content 仍为 plain
  let summaryLine: string | undefined
  let ansiUnified: string | undefined
  let cellFiles:
    | Array<{ path: string; op?: string; added?: number; removed?: number }>
    | undefined
  let cellCollapsed: string | undefined
  let cellExpanded: string | undefined
  if (result.ok && result.meta?.kind) {
    try {
      const {
        formatFileChangeEndLine,
        colorizeUnifiedText,
        createDiffSummary,
        inlineDiffMaxLines,
      } = await import('../../tools/src/ansiDiff.ts')
      const {
        formatFileChangeHistoryCell,
        fileChangeCellFromMeta,
      } = await import('./fileChangeCell.ts')
      const paths =
        result.meta.paths?.length
          ? result.meta.paths
          : result.meta.files?.map((f) => f.path).filter(Boolean)
      summaryLine = formatFileChangeEndLine({
        name,
        path: result.meta.path,
        paths,
        added: result.meta.added,
        removed: result.meta.removed,
        ok: true,
        color: true,
      })
      if (result.meta.files && result.meta.files.length > 1) {
        const block = createDiffSummary(
          result.meta.files.map((f) => ({
            path: f.path,
            op: f.op,
            added: f.added ?? 0,
            removed: f.removed ?? 0,
          })),
          { title: `${name} files`, color: true, maxFiles: 12 },
        )
        summaryLine = `${summaryLine}\n${block}`
      }
      const maxUni = inlineDiffMaxLines()
      if (maxUni > 0 && result.meta.unified) {
        ansiUnified = colorizeUnifiedText(result.meta.unified, {
          maxLines: maxUni,
        })
      }
      cellFiles = result.meta.files?.map((f) => ({
        path: f.path,
        op: f.op,
        added: f.added,
        removed: f.removed,
      }))
      if (!cellFiles?.length && result.meta.path) {
        cellFiles = [
          {
            path: result.meta.path,
            added: result.meta.added,
            removed: result.meta.removed,
          },
        ]
      }
      const cellIn = fileChangeCellFromMeta({
        toolName: name,
        ok: true,
        meta: result.meta,
        ansiUnified,
      })
      if (cellIn) {
        cellCollapsed = formatFileChangeHistoryCell(cellIn, {
          expanded: false,
          color: true,
        })
        cellExpanded = formatFileChangeHistoryCell(cellIn, {
          expanded: true,
          color: true,
          maxUnifiedLines: maxUni > 0 ? maxUni : 16,
        })
      }
    } catch {
      /* ignore */
    }
  }

  emit(ctx, {
    type: 'tool_end',
    id: toolUseId,
    name,
    output: content,
    ok: result.ok,
    isError: result.isError,
    ...(result.ok && result.meta?.path
      ? {
          path: result.meta.path,
          added: result.meta.added,
          removed: result.meta.removed,
        }
      : {}),
    ...(summaryLine ? { summaryLine } : {}),
    ...(ansiUnified ? { ansiUnified } : {}),
    ...(cellFiles?.length ? { files: cellFiles } : {}),
    ...(cellCollapsed ? { cellCollapsed } : {}),
    ...(cellExpanded ? { cellExpanded } : {}),
  })

  // --- 会话 fileDiffLog（D2；不污染 tool_result 文本）---
  if (result.ok && result.meta && ctx.sessionRef) {
    try {
      const { appendFileChange, recordsFromToolMeta } = await import(
        './fileDiffLog.ts'
      )
      const records = recordsFromToolMeta({
        toolName: name,
        meta: result.meta,
        at: nowIso(),
        turn: ctx.sessionRef.diffTurn,
      })
      for (const rec of records) {
        ctx.sessionRef.fileDiffLog = appendFileChange(
          ctx.sessionRef.fileDiffLog,
          rec,
        )
        // D6：可选落盘摘要
        if (ctx.sessionRef.onFileDiffRecord) {
          try {
            await ctx.sessionRef.onFileDiffRecord(rec)
          } catch {
            /* 落盘失败不拖垮 */
          }
        }
      }
    } catch {
      // log 失败不拖垮 tool 路径
    }
  }

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
    { signal: ctx.signal },
  )
  for (const r of post.results) {
    emit(ctx, {
      type: 'hook',
      event: 'PostToolUse',
      exitCode: r.exitCode,
      blocked: r.exitCode === 2,
    })
  }
  // H2：exit 2 stderr → 立即并入 tool_result（模型可见）
  const postFeedback = (post.continuationText || '').trim()
  if (postFeedback) {
    content = `${content}\n\n[PostToolUse hook]\n${postFeedback}`
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