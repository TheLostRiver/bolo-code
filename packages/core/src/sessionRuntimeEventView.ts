/**
 * Desktop/runtime 关键事件的窄视图。
 *
 * SessionEvent 是 core 的内部运行态联合体；renderer 不应理解 safe-boundary
 * 语义，也不应接收 steer 的完整原始 prompt。这里把 OI-06 关闭所需的两类事件
 * 投影成可直接显示的稳定形状。其它事件继续走既有兼容路径。
 */
import {
  SESSION_SAFE_BOUNDARIES,
  type SessionSafeBoundary,
} from './sessionCoordinator.ts'

export type SessionRuntimeEventView =
  | {
      type: 'tool_progress'
      id: string
      state: 'running'
      text: string
    }
  | {
      type: 'control'
      controlId: string
      kind: 'steer'
      state: 'applied'
      text: string
    }

const BOUNDARY_LABELS: Record<SessionSafeBoundary, string> = {
  before_provider: 'before model call',
  after_provider: 'after model response',
  before_tools: 'before tool execution',
  after_tools: 'after tool execution',
  after_permission: 'after permission decision',
  after_diff_approval: 'after diff approval',
  after_compact: 'after compaction',
  before_stop: 'before stop',
  turn_terminal: 'at turn completion',
}

function inlineText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

function isSafeBoundary(value: unknown): value is SessionSafeBoundary {
  return (
    typeof value === 'string' &&
    (SESSION_SAFE_BOUNDARIES as readonly string[]).includes(value)
  )
}

/**
 * 返回 null 表示该事件不属于关键投影，或关键事件形状无效。
 *
 * 调用方对 control/tool_progress 的 null 必须 fail closed，不能回退发送原始事件；
 * 对其它 SessionEvent 则可保留已有兼容转发。
 */
export function projectSessionRuntimeEventView(
  event: unknown,
): SessionRuntimeEventView | null {
  if (!event || typeof event !== 'object') return null
  const input = event as Record<string, unknown>

  if (input.type === 'tool_progress') {
    const id = inlineText(input.id, 160)
    const name = inlineText(input.name, 80)
    const message = inlineText(input.message, 200)
    if (!id || !name || !message) return null
    return {
      type: 'tool_progress',
      id,
      state: 'running',
      text: `→ ${name} · ${message}`,
    }
  }

  if (input.type === 'control') {
    const controlId = inlineText(input.controlId, 160)
    const prompt = inlineText(input.prompt, 160)
    if (
      input.kind !== 'steer' ||
      !controlId ||
      !prompt ||
      !isSafeBoundary(input.boundary)
    ) {
      return null
    }
    return {
      type: 'control',
      controlId,
      kind: 'steer',
      state: 'applied',
      text:
        `↪ Steer applied ${BOUNDARY_LABELS[input.boundary]}` +
        ` · ${prompt}`,
    }
  }

  return null
}
