/**
 * StreamingToolExecutor — 边收 tool_call 边调度（最小）
 *
 * 对照参考实现语义（重新实现，无遥测）：
 * - 并发安全工具可与其它并发安全工具并行
 * - 非并发安全工具独占
 * - drain 结果按入队顺序（非完成顺序）
 * - Bash 执行失败 → 取消排队/在跑的兄弟 tool
 * - discard → 排队项合成错误，放弃本轮流式结果
 *
 * 有意缩小：无 progress 通道、无 interruptBehavior、无 contextModifier。
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

    if (this.hasBashErrored || this.siblingAbort.signal.aborted) {
      const reason =
        this.siblingAbort.signal.reason === 'streaming_discard'
          ? 'Streaming discarded — tool not executed'
          : `Cancelled: parallel tool call ${this.erroredBashDesc || 'Bash'} errored`
      tool.result = syntheticResult(tool.id, tool.block.name, reason)
      tool.status = 'completed'
      return
    }

    const toolAbort = createChildAbortController(this.siblingAbort.signal)
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