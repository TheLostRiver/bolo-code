/**
 * StreamingToolExecutor — 边收 tool_call 边调度（最小 + progress/interrupt）
 *
 * 对照参考实现语义（重新实现，无遥测）：
 * - 并发安全工具可与其它并发安全工具并行
 * - 非并发安全工具独占
 * - drain 结果按入队顺序（非完成顺序）
 * - Bash 执行失败 → 取消排队/在跑的兄弟 tool
 * - discard → 排队项合成错误，放弃本轮流式结果
 * - tool_progress 经 runToolUse onEvent 透出
 * - interruptBehavior：cancel 工具在 parent abort(reason=interrupt) 时取消；block 继续跑完
 */

import type { ChatMessage } from '../../shared/src/index.ts'
import {
  createBuiltinTools,
  findToolByName,
  formatToolUseError,
  type BoloTool,
} from '../../tools/src/index.ts'
import {
  runToolUse,
  type RunToolUseContext,
  type RunToolUseResult,
  type ToolUseBlock,
} from './toolExecution.ts'

type ToolStatus = 'queued' | 'executing' | 'completed'

type TrackedTool = {
  id: string
  block: ToolUseBlock
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  result?: ChatMessage
}

function syntheticResult(
  toolUseId: string,
  name: string,
  message: string,
): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: toolUseId,
    name,
    content: formatToolUseError(message),
  }
}

function resolveConcurrencySafe(
  tools: readonly BoloTool[],
  block: ToolUseBlock,
): boolean {
  const tool = findToolByName(tools, block.name)
  if (!tool) return true
  let input: unknown = block.input
  if (input === undefined && block.argumentsJson) {
    try {
      input = JSON.parse(block.argumentsJson)
    } catch {
      input = {}
    }
  }
  try {
    return Boolean(tool.isConcurrencySafe(input ?? {}))
  } catch {
    return false
  }
}

function createChildAbortController(parent?: AbortSignal): AbortController {
  const child = new AbortController()
  if (!parent) return child
  if (parent.aborted) {
    child.abort(parent.reason)
    return child
  }
  parent.addEventListener(
    'abort',
    () => {
      if (!child.signal.aborted) child.abort(parent.reason)
    },
    { once: true },
  )
  return child
}

/**
 * 工具执行用 AbortController：
 * - parent discard / sibling_error / 普通 abort → 始终转发
 * - parent reason === 'interrupt' 且 interruptBehavior === 'block' → **不**转发（对照 HC）
 */
function createToolAbortController(
  parent: AbortSignal | undefined,
  interruptBehavior: 'cancel' | 'block',
): AbortController {
  const child = new AbortController()
  if (!parent) return child
  const forward = () => {
    if (child.signal.aborted) return
    const reason = parent.reason
    if (reason === 'interrupt' && interruptBehavior === 'block') {
      return
    }
    child.abort(reason)
  }
  if (parent.aborted) {
    forward()
    return child
  }
  parent.addEventListener('abort', forward, { once: true })
  return child
}

function resolveInterruptBehavior(
  tools: readonly BoloTool[],
  name: string,
): 'cancel' | 'block' {
  const tool = findToolByName(tools, name)
  if (!tool?.interruptBehavior) return 'block'
  try {
    const b = tool.interruptBehavior()
    return b === 'cancel' ? 'cancel' : 'block'
  } catch {
    return 'block'
  }
}

/** Bash 失败且应级联取消兄弟（权限 deny / 用户取消不级联） */
function isBashCascadeError(r: RunToolUseResult): boolean {
  if (r.blocked || r.denied) return false
  const c = r.toolResultMessage.content
  if (typeof c !== 'string') return false
  if (c.includes('tool cancelled')) return false
  if (c.includes('permission denied')) return false
  // runToolUse 将 isError 输出包成 <tool_use_error>…
  return c.includes('<tool_use_error>')
}

export type StreamingToolExecutorOptions = {
  context: Omit<RunToolUseContext, 'signal'> & {
    signal?: AbortSignal
  }
}

export class StreamingToolExecutor {
  private readonly toolsDef: readonly BoloTool[]
  private readonly baseCtx: StreamingToolExecutorOptions['context']
  private readonly tracked: TrackedTool[] = []
  private discarded = false
  private hasBashErrored = false
  private erroredBashDesc = ''
  private siblingAbort: AbortController

  constructor(opts: StreamingToolExecutorOptions) {
    this.baseCtx = opts.context
    this.toolsDef = opts.context.tools ?? createBuiltinTools()
    this.siblingAbort = createChildAbortController(opts.context.signal)
  }

  discard(): void {
    this.discarded = true
    if (!this.siblingAbort.signal.aborted) {
      this.siblingAbort.abort('streaming_discard')
    }
    for (const t of this.tracked) {
      if (t.status === 'queued') {
        t.result = syntheticResult(
          t.id,
          t.block.name,
          'Streaming discarded — tool not executed',
        )
        t.status = 'completed'
      }
    }
  }

  addTool(block: ToolUseBlock): void {
    if (this.discarded) {
      this.tracked.push({
        id: block.id,
        block,
        status: 'completed',
        isConcurrencySafe: true,
        result: syntheticResult(
          block.id,
          block.name,
          'Streaming discarded — tool not executed',
        ),
      })
      return
    }

    if (this.hasBashErrored) {
      this.tracked.push({
        id: block.id,
        block,
        status: 'completed',
        isConcurrencySafe: true,
        result: syntheticResult(
          block.id,
          block.name,
          `Cancelled: parallel tool call ${this.erroredBashDesc || 'Bash'} errored`,
        ),
      })
      return
    }

    this.tracked.push({
      id: block.id,
      block,
      status: 'queued',
      isConcurrencySafe: resolveConcurrencySafe(this.toolsDef, block),
    })
    void this.processQueue()
  }

  private canExecute(isConcurrencySafe: boolean): boolean {
    const executing = this.tracked.filter((t) => t.status === 'executing')
    if (executing.length === 0) return true
    return isConcurrencySafe && executing.every((t) => t.isConcurrencySafe)
  }

  private async processQueue(): Promise<void> {
    for (const tool of this.tracked) {
      if (tool.status !== 'queued') continue

      if (this.discarded) {
        tool.result = syntheticResult(
          tool.id,
          tool.block.name,
          'Streaming discarded — tool not executed',
        )
        tool.status = 'completed'
        continue
      }

      if (this.hasBashErrored) {
        tool.result = syntheticResult(
          tool.id,
          tool.block.name,
          `Cancelled: parallel tool call ${this.erroredBashDesc || 'Bash'} errored`,
        )
        tool.status = 'completed'
        continue
      }

      if (this.canExecute(tool.isConcurrencySafe)) {
        this.startTool(tool)
      } else if (!tool.isConcurrencySafe) {
        break
      }
    }
  }

  private startTool(tool: TrackedTool): void {
    tool.status = 'executing'
    const promise = this.executeOne(tool)
    tool.promise = promise
    void promise.finally(() => {
      void this.processQueue()
    })
  }

  private async executeOne(tool: TrackedTool): Promise<void> {
    if (this.discarded) {
      tool.result = syntheticResult(
        tool.id,
        tool.block.name,
        'Streaming discarded — tool not executed',
      )
      tool.status = 'completed'
      return
    }

    // Bash 级联 / discard：立刻合成错误（interrupt 不走这里）
    if (this.hasBashErrored) {
      tool.result = syntheticResult(
        tool.id,
        tool.block.name,
        `Cancelled: parallel tool call ${this.erroredBashDesc || 'Bash'} errored`,
      )
      tool.status = 'completed'
      return
    }
    if (
      this.siblingAbort.signal.aborted &&
      this.siblingAbort.signal.reason === 'streaming_discard'
    ) {
      tool.result = syntheticResult(
        tool.id,
        tool.block.name,
        'Streaming discarded — tool not executed',
      )
      tool.status = 'completed'
      return
    }
    // sibling_error 已在 hasBashErrored 处理；其余 abort(reason=interrupt 等) 交给 toolAbort 策略

    const interruptBehavior = resolveInterruptBehavior(
      this.toolsDef,
      tool.block.name,
    )
    const toolAbort = createToolAbortController(
      this.siblingAbort.signal,
      interruptBehavior,
    )
    const ctx: RunToolUseContext = {
      ...this.baseCtx,
      tools: this.toolsDef,
      signal: toolAbort.signal,
    }

    try {
      const r = await runToolUse(tool.block, ctx)

      if (this.discarded || toolAbort.signal.reason === 'streaming_discard') {
        tool.result = syntheticResult(
          tool.id,
          tool.block.name,
          'Streaming discarded — tool not executed',
        )
      } else if (
        toolAbort.signal.aborted &&
        (toolAbort.signal.reason === 'sibling_error' || this.hasBashErrored)
      ) {
        tool.result = syntheticResult(
          tool.id,
          tool.block.name,
          `Cancelled: parallel tool call ${this.erroredBashDesc || 'Bash'} errored`,
        )
      } else {
        tool.result = r.toolResultMessage
        if (tool.block.name === 'Bash' && isBashCascadeError(r)) {
          this.markBashErrored(tool)
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (
        this.discarded ||
        toolAbort.signal.reason === 'streaming_discard'
      ) {
        tool.result = syntheticResult(
          tool.id,
          tool.block.name,
          'Streaming discarded — tool not executed',
        )
      } else if (
        toolAbort.signal.aborted &&
        (this.hasBashErrored || toolAbort.signal.reason === 'sibling_error')
      ) {
        tool.result = syntheticResult(
          tool.id,
          tool.block.name,
          `Cancelled: parallel tool call ${this.erroredBashDesc || 'Bash'} errored`,
        )
      } else {
        tool.result = syntheticResult(tool.id, tool.block.name, msg)
        if (tool.block.name === 'Bash') {
          this.markBashErrored(tool)
        }
      }
    }

    tool.status = 'completed'
  }

  private markBashErrored(tool: TrackedTool): void {
    this.hasBashErrored = true
    const input = tool.block.input as { command?: unknown } | undefined
    const cmd =
      typeof input?.command === 'string' ? input.command.slice(0, 40) : ''
    this.erroredBashDesc = cmd ? `Bash(${cmd})` : 'Bash'
    if (!this.siblingAbort.signal.aborted) {
      this.siblingAbort.abort('sibling_error')
    }
  }

  /** 等待全部完成，按入队顺序返回 tool_result */
  async drain(): Promise<ChatMessage[]> {
    await this.processQueue()

    for (;;) {
      if (this.tracked.every((t) => t.status === 'completed')) break

      const executing = this.tracked
        .filter((t) => t.status === 'executing' && t.promise)
        .map((t) => t.promise!)

      if (executing.length > 0) {
        await Promise.race(executing)
        continue
      }

      await this.processQueue()

      if (
        this.tracked.some((t) => t.status === 'queued') &&
        !this.tracked.some((t) => t.status === 'executing')
      ) {
        const next = this.tracked.find((t) => t.status === 'queued')
        if (next && this.canExecute(next.isConcurrencySafe)) {
          this.startTool(next)
        } else if (next) {
          next.result = syntheticResult(
            next.id,
            next.block.name,
            'Internal: tool queue stalled',
          )
          next.status = 'completed'
        }
      }
    }

    return this.tracked.map(
      (t) =>
        t.result ??
        syntheticResult(t.id, t.block.name, 'Missing tool result'),
    )
  }

  get size(): number {
    return this.tracked.length
  }

  get bashCascadeActive(): boolean {
    return this.hasBashErrored
  }

  get isDiscarded(): boolean {
    return this.discarded
  }
}