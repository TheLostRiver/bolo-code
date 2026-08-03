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

import {
  addAlwaysAllowToolName,
  decidePermission,
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
import {
  truncateMiddle,
  toolOutputBudgetBytes,
} from '../../compact/src/index.ts'
import {
  classifyBashCommandSafety,
  createToolPresentation,
  nowIso,
  type ChatMessage,
  type HooksConfig,
  type ToolPresentation,
  type ToolResultReference,
} from '../../shared/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import {
  createBuiltinTools,
  findToolByName,
  formatToolUseError,
  validateAgainstJsonSchema,
  TODO_WRITE_TOOL_NAME,
  type BoloTool,
  type ToolResult,
} from '../../tools/src/index.ts'
import type { QueryDeps } from './deps.ts'
import type { QueryLoopEvent } from './queryLoop.ts'
import type { SessionSafeBoundary } from './sessionCoordinator.ts'
import { writeToolResultFile } from './toolResultStore.ts'

/** 单条 tool_result 写入 transcript 的字符上限（C6 类；可配置） */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000

/**
 * 超长 tool 输出截断（AR2A0b：中段截断，保头保尾）。
 * 委托 compact truncateMiddle：标注原始 tokens/行数，幂等；
 * 完整结果经 spill 落盘，模型上下文只保留头尾切片。
 */
export function truncateToolResultOutput(
  output: string,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): { text: string; truncated: boolean; omittedChars: number } {
  const r = truncateMiddle(output, { maxChars: Math.max(0, maxChars) })
  return { text: r.text, truncated: r.truncated, omittedChars: r.omittedChars }
}

export type ToolUseBlock = {
  id: string
  name: string
  input: unknown
  argumentsJson?: string
}

export type ToolExecutionEvent =
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean; status?: import('../../shared/src/index.ts').HookRunStatus }
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
      presentation: ToolPresentation
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
  /** 执行工具时的真实工作目录；可选以兼容旧 UI。 */
  cwd?: string
  preview?: PermissionPreviewPayload
  /** 当前 tool/turn 的合并取消信号；自定义 UI 应按 deny 收口。 */
  signal?: AbortSignal
}) => Promise<AskPermissionDecision>

export type RunToolUseContext = {
  sessionId: string
  /** DR3A：当前主 durable turn；透传给 Agent task parentTurnId。 */
  parentTurnId?: string
  cwd: string
  hooks: HooksConfig
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  /** 会话 Always-allow；ask 选 a 时就地写入 */
  permissionRules?: SessionPermissionRules
  /** tool_result 字符预算；默认 DEFAULT_MAX_TOOL_RESULT_CHARS */
  maxToolResultChars?: number
  /**
   * 截断后是否把全文落到用户 workspace sessions 的 `tool-results/`。
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
  /** AR-T1：会话待办表 store；经 extras 交给 TodoWrite 工具 */
  todoStore?: import('../../tools/src/index.ts').TodoStoreRef
  /** AR-T2：后台 shell 注册表；经 extras 交给 Bash/BashOutput/KillShell */
  backgroundShellStore?: import('../../shared/src/index.ts').BackgroundShellStore
  /** AR-T3a：会话权限模式引用；经 extras 交给 ExitPlanMode */
  planModeStore?: import('../../tools/src/index.ts').PlanModeStoreRef
  askUserQuestion?: import('../../tools/src/index.ts').AskUserQuestionAskerRef
  /** 父会话 messages；仅供 fork 继承，后台完成不得异步修改 */
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
    /** H5：hook 诊断 ring */
    hookDiagLog?: import('./hookDiag.ts').HookDiagLog
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
  /**
   * DR2B3：permission/diff ask 完成或取消后的显式安全边界。
   * callback 不得直接执行 tool side effect。
   */
  onSafeBoundary?: (
    boundary: SessionSafeBoundary,
  ) => void | Promise<void>
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
  presentation: ToolPresentation
  blocked: boolean
  denied: boolean
  /** 工具声明可并发 */
  concurrencySafe: boolean
}

function emit(ctx: RunToolUseContext, e: ToolExecutionEvent) {
  ctx.onEvent?.(e)
}

function resolvePermissionOnAbort(
  start: () => Promise<AskPermissionDecision>,
  signal: AbortSignal | undefined,
): Promise<AskPermissionDecision> {
  if (!signal) return Promise.resolve().then(start)
  if (signal.aborted) return Promise.resolve('deny')
  return new Promise<AskPermissionDecision>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const finish = (decision: AskPermissionDecision) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(decision)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => finish('deny')
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(start).then(finish, fail)
  })
}

async function visitToolSafeBoundary(
  ctx: RunToolUseContext,
  boundary: SessionSafeBoundary,
): Promise<void> {
  await ctx.onSafeBoundary?.(boundary)
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
  _isError?: boolean,
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
  toolInput: unknown,
  content: string,
  flags: {
    blocked: boolean
    denied: boolean
    ok: boolean
    isError?: boolean
    concurrencySafe?: boolean
  },
): RunToolUseResult {
  if (flags.denied) {
    // HKP-1：PermissionDenied 纯观察 hook（fire-and-forget，不阻塞拒绝路径）。
    // 时序契约：hook 事件在 runHooks 完成（最长 timeout 秒）后异步 emit，
    // 可能晚于后续工具事件；观察性语义下不保证事件间顺序。
    const deniedInput = {
      hook_event_name: 'PermissionDenied' as const,
      session_id: ctx.sessionId,
      cwd: ctx.cwd,
      timestamp: nowIso(),
      tool_name: name,
      tool_input: toolInput,
      tool_use_id: toolUseId,
      ...(content.trim() ? { reason: content.trim() } : {}),
    }
    void runHooks('PermissionDenied', deniedInput, ctx.hooks, {
      signal: ctx.signal,
    })
      .then((run) => {
        for (const r of run.results) {
          emit(ctx, {
            type: 'hook',
            event: 'PermissionDenied',
            exitCode: r.exitCode,
            status: r.status,
          })
        }
      })
      .catch(() => {
        /* 纯观察：hook 自身失败不阻断拒绝路径 */
      })
  }
  const presentation = createToolPresentation({
    toolName: name,
    output: content,
    retainedOutput: content,
    truncated: false,
    ok: flags.ok,
    isError: flags.isError,
  })
  emit(ctx, {
    type: 'tool_end',
    id: toolUseId,
    name,
    output: content,
    ok: flags.ok,
    isError: flags.isError,
    presentation,
  })
  return {
    blocked: flags.blocked,
    denied: flags.denied,
    concurrencySafe: flags.concurrencySafe ?? false,
    toolResultMessage: toolResultMessage(toolUseId, name, content, flags.isError),
    presentation,
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
    return endResult(ctx, toolUseId, name, rawInput, content, {
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
    return endResult(ctx, toolUseId, name, rawInput, content, {
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
      extras: {
        skills: ctx.skills,
        todoStore: ctx.todoStore,
        backgroundShellStore: ctx.backgroundShellStore,
        planModeStore: ctx.planModeStore,
        askUserQuestion: ctx.askUserQuestion,
      },
    })
    if (!v.ok) {
      const content = formatToolUseError(v.message)
      return endResult(ctx, toolUseId, name, toolInput, content, {
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
  // H5 诊断
  try {
    const { appendHookDiag, diagEntriesFromHookRun } = await import(
      './hookDiag.ts'
    )
    if (ctx.sessionRef) {
      const entries = diagEntriesFromHookRun({
        event: 'PreToolUse',
        results: pre.results,
        blockReason: pre.blockReason,
      })
      for (const e of entries) {
        ctx.sessionRef.hookDiagLog = appendHookDiag(ctx.sessionRef.hookDiagLog, e)
      }
    }
  } catch {
    /* ignore */
  }
  if (pre.blocked) {
    return endResult(
      ctx,
      toolUseId,
      name,
      toolInput,
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

  // H4：PreToolUse updatedInput → 覆盖 tool_input（后写 wins）；再 schema 校验
  if (pre.updatedInput !== undefined) {
    const rewritten = validateAgainstJsonSchema(
      tool.inputJSONSchema,
      pre.updatedInput,
    )
    if (rewritten.success) {
      toolInput = rewritten.data
    }
    // 校验失败：忽略改写，继续原 input（fail-open on rewrite）
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
      toolInput,
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
            toolInput,
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
        // HKP-2：Bash 命令级安全分析（先于分类器，确定性判定；
        // 危险拒绝 / 包管理器白名单放行 / 其余交给分类器）
        const bashSafety =
          name === 'Bash' &&
          typeof (toolInput as { command?: unknown } | null)?.command ===
            'string'
            ? classifyBashCommandSafety(
                (toolInput as { command: string }).command,
              )
            : undefined
        if (bashSafety?.verdict === 'deny') {
          emit(ctx, {
            type: 'permission_decision',
            mode: 'auto',
            behavior: 'deny',
            reason: bashSafety.reason,
          })
          await auditAutoClassify(ctx, {
            toolName: name,
            toolUseId,
            toolInput,
            decision: 'deny',
            reason: bashSafety.reason,
            stage: 'command-safety',
          })
          return endResult(
            ctx,
            toolUseId,
            name,
            toolInput,
            formatToolUseError(
              `permission denied (auto command safety: ${bashSafety.reason})`,
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
        if (bashSafety?.verdict === 'allow') {
          emit(ctx, {
            type: 'permission_decision',
            mode: 'auto',
            behavior: 'allow',
            reason: bashSafety.reason,
          })
          await auditAutoClassify(ctx, {
            toolName: name,
            toolUseId,
            toolInput,
            decision: 'allow',
            reason: bashSafety.reason,
            stage: 'command-safety',
          })
          finalBehavior = 'allow'
        } else {
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
            toolInput,
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
            toolInput,
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
            toolInput,
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

    try {
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
        const user = await resolvePermissionOnAbort(
          () =>
            ctx.askPermission({
              toolName: name,
              toolInput,
              toolUseId,
              cwd: ctx.cwd,
              ...(previewPayload ? { preview: previewPayload } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            }),
          ctx.signal,
        )
        if (user === 'allow_always') {
          if (ctx.permissionRules) {
            addAlwaysAllowToolName(ctx.permissionRules, name)
          }
          finalBehavior = 'allow'
        } else {
          finalBehavior = user
        }
      }
    } finally {
      await visitToolSafeBoundary(ctx, 'after_permission')
      if (previewPayload?.files?.length) {
        await visitToolSafeBoundary(ctx, 'after_diff_approval')
      }
    }

    if (finalBehavior === 'deny') {
      return endResult(
        ctx,
        toolUseId,
        name,
        toolInput,
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
      toolInput,
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
        todoStore: ctx.todoStore,
        backgroundShellStore: ctx.backgroundShellStore,
        planModeStore: ctx.planModeStore,
        askUserQuestion: ctx.askUserQuestion,
        subagentParent: ctx.deps
          ? {
              parentSessionId: ctx.sessionId,
              parentTurnId: ctx.parentTurnId,
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
  const originalContent = content
  let fullResult: ToolResultReference | undefined

  // --- tool_result 字符预算（C6 + AR2A0b per-tool 表驱动）---
  // 优先级：显式 ctx.maxToolResultChars > per-tool 预算表 > 默认 10k
  const maxChars = toolOutputBudgetBytes(name, ctx.maxToolResultChars)
  const trunc = truncateToolResultOutput(content, maxChars)
  if (trunc.truncated) {
    let note = trunc.text
    if (ctx.spillTruncatedToolResults !== false) {
      fullResult = await writeToolResultFile({
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        toolUseId,
        content,
      })
      if (fullResult) {
        note += `\n[full result: ${fullResult.path}]`
      }
    }
    content = note
  }

  const presentation = createToolPresentation({
    toolName: name,
    toolInput,
    output: originalContent,
    retainedOutput: content,
    truncated: trunc.truncated,
    ok: result.ok,
    isError: result.isError,
    fullResult,
  })

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

  // AR-T1：TodoWrite 没有 file meta，用会话表本身渲染 cell。
  // 读的是写入后的 store，所以展示的就是刚刚生效的表。
  if (result.ok && name === TODO_WRITE_TOOL_NAME && ctx.todoStore) {
    try {
      const { formatTodoCell } = await import('./todoCell.ts')
      const todos = ctx.todoStore.todos
      cellCollapsed = formatTodoCell(todos, { expanded: false, color: true })
      cellExpanded = formatTodoCell(todos, { expanded: true, color: true })
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
    presentation,
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
  try {
    const { appendHookDiag, diagEntriesFromHookRun } = await import(
      './hookDiag.ts'
    )
    if (ctx.sessionRef) {
      for (const e of diagEntriesFromHookRun({
        event: 'PostToolUse',
        results: post.results,
      })) {
        ctx.sessionRef.hookDiagLog = appendHookDiag(ctx.sessionRef.hookDiagLog, e)
      }
    }
  } catch {
    /* ignore */
  }
  // H2：exit 2 stderr → 立即并入 tool_result（模型可见）
  const postFeedback = (post.continuationText || '').trim()
  if (postFeedback) {
    content = `${content}\n\n[PostToolUse hook]\n${postFeedback}`
  }

  // HKP-1：工具执行失败时额外触发 PostToolUseFailure（观察 + exit 2 反馈）
  if (result.isError) {
    // 载荷有界：error 只带截断摘要（完整输出可能 MB 级，且已按
    // maxToolResultChars 截断进 tool_result）；tool_response 保留原始引用。
    const failureError =
      result.output.length > 2_000
        ? `${result.output.slice(0, 1_999)}…`
        : result.output
    const failure = await runHooks(
      'PostToolUseFailure',
      {
        hook_event_name: 'PostToolUseFailure',
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        timestamp: nowIso(),
        tool_name: name,
        tool_input: toolInput,
        tool_use_id: toolUseId,
        tool_response: result,
        error: failureError,
      },
      ctx.hooks,
      { signal: ctx.signal },
    )
    for (const r of failure.results) {
      emit(ctx, {
        type: 'hook',
        event: 'PostToolUseFailure',
        exitCode: r.exitCode,
        status: r.status,
      })
    }
    try {
      const { appendHookDiag, diagEntriesFromHookRun } = await import(
        './hookDiag.ts'
      )
      if (ctx.sessionRef) {
        const entries = diagEntriesFromHookRun({
          event: 'PostToolUseFailure',
          results: failure.results,
        })
        for (const e of entries) {
          ctx.sessionRef.hookDiagLog = appendHookDiag(
            ctx.sessionRef.hookDiagLog,
            e,
          )
        }
      }
    } catch {
      /* ignore */
    }
    const failureFeedback = (failure.continuationText || '').trim()
    if (failureFeedback) {
      content = `${content}\n\n[PostToolUseFailure hook]\n${failureFeedback}`
    }
  }

  return {
    blocked: false,
    denied: false,
    concurrencySafe,
    presentation,
    toolResultMessage: toolResultMessage(
      toolUseId,
      name,
      content,
      result.isError,
    ),
  }
}
