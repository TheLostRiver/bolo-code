/**
 * T4：SessionEvent → 可读终端行（纯函数，无 I/O）
 * 对照 HC 时间线简化：text 原样增量；thinking 弱样式与正文分离；tool 一行起止。
 */

/** 与 core SessionEvent 对齐的最小形状（避免 cli↔core 环依赖过重） */
export type CliSessionEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
  | {
      type: 'tool_end'
      id: string
      name: string
      output?: string
      ok: boolean
    }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | { type: string; [k: string]: unknown }

/** ANSI：dim 思考链（无 TTY 时仍写转义；多数终端可忽略或显示弱样式） */
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/**
 * 工具起止简行；其它事件返回 null（text/reasoning 由打印机处理）。
 * - start: `→ ToolName`
 * - end ok: `✓ ToolName`
 * - end fail: `✗ ToolName`
 */
export function formatToolEventLine(e: CliSessionEvent): string | null {
  if (e.type === 'tool_start' && typeof e.name === 'string') {
    return `→ ${e.name}`
  }
  if (e.type === 'tool_end' && typeof e.name === 'string') {
    const ok = e.ok !== false
    return ok ? `✓ ${e.name}` : `✗ ${e.name}`
  }
  return null
}

/**
 * 将事件格式化为应写入 stdout/stderr 的片段（可多段）。
 * text：原样 delta；reasoning：dim + 可选 thinking 前缀；tool：独立一行。
 */
export function formatSessionEventChunks(
  e: CliSessionEvent,
): { stream: 'out' | 'err'; text: string }[] {
  if (e.type === 'text' && typeof e.text === 'string' && e.text.length > 0) {
    return [{ stream: 'out', text: e.text }]
  }
  if (
    e.type === 'reasoning' &&
    typeof e.text === 'string' &&
    e.text.length > 0
  ) {
    // 纯函数不维护「首段前缀」状态；打印机负责前缀与分段
    return [{ stream: 'out', text: `${DIM}${e.text}${RESET}` }]
  }
  const toolLine = formatToolEventLine(e)
  if (toolLine) {
    return [{ stream: 'out', text: `${toolLine}\n` }]
  }
  if (e.type === 'error' && typeof e.message === 'string') {
    return [{ stream: 'err', text: `error: ${e.message}\n` }]
  }
  if (e.type === 'warning' && typeof e.message === 'string') {
    return [{ stream: 'err', text: `warn: ${e.message}\n` }]
  }
  if (e.type === 'model_retry') {
    const attempt = typeof e.attempt === 'number' ? e.attempt : '?'
    const max = typeof e.maxRetries === 'number' ? e.maxRetries : '?'
    const reason = typeof e.reason === 'string' ? e.reason : 'retry'
    return [
      {
        stream: 'err',
        text: `retry ${attempt}/${max} (${reason})\n`,
      },
    ]
  }
  return []
}

export type SessionEventPrinter = {
  onEvent: (e: CliSessionEvent) => void
  beginTurn: () => void
  endTurn: () => void
  didStreamText: () => boolean
}

/**
 * 会话 onEvent 打印机：流式 text + thinking 弱样式 + 工具简行；不刷 phase/hook 等噪声。
 * 思考链与正文分离：thinking 用 dim；首段加 `thinking ` 前缀；切到 text 时换行。
 * showThinking=false 时仍可收到 reasoning 事件，但不写终端（对照 session.showThinking / /thinking）。
 */
export function createSessionEventPrinter(opts: {
  writeOut: (s: string) => void
  writeErr?: (s: string) => void
  /**
   * 是否渲染 reasoning；默认 true。
   * 可传函数以便读取 session.showThinking 的最新值。
   */
  showThinking?: boolean | (() => boolean)
}): SessionEventPrinter {
  const writeOut = opts.writeOut
  const writeErr = opts.writeErr ?? ((s: string) => process.stderr.write(s))
  const isShowThinking = (): boolean => {
    if (opts.showThinking === undefined) return true
    if (typeof opts.showThinking === 'function') return opts.showThinking() !== false
    return opts.showThinking !== false
  }
  let openTextLine = false
  let openReasoningLine = false
  let streamedText = false
  let reasoningPrefixDone = false

  const ensureLineBreak = () => {
    if (openTextLine || openReasoningLine) {
      writeOut('\n')
      openTextLine = false
      openReasoningLine = false
    }
  }

  return {
    beginTurn() {
      streamedText = false
      openTextLine = false
      openReasoningLine = false
      reasoningPrefixDone = false
    },
    endTurn() {
      if (openTextLine || openReasoningLine) {
        writeOut('\n')
        openTextLine = false
        openReasoningLine = false
      }
    },
    didStreamText() {
      return streamedText
    },
    onEvent(e) {
      if (
        e.type === 'reasoning' &&
        typeof e.text === 'string' &&
        e.text.length > 0
      ) {
        if (!isShowThinking()) return
        if (openTextLine) {
          writeOut('\n')
          openTextLine = false
        }
        if (!reasoningPrefixDone) {
          writeOut(`${DIM}thinking ${RESET}`)
          reasoningPrefixDone = true
        }
        writeOut(`${DIM}${e.text}${RESET}`)
        openReasoningLine = !e.text.endsWith('\n')
        return
      }
      if (e.type === 'text' && typeof e.text === 'string' && e.text.length > 0) {
        if (openReasoningLine) {
          writeOut('\n')
          openReasoningLine = false
        }
        writeOut(e.text)
        streamedText = true
        openTextLine = !e.text.endsWith('\n')
        return
      }
      const toolLine = formatToolEventLine(e)
      if (toolLine) {
        ensureLineBreak()
        writeOut(`${toolLine}\n`)
        return
      }
      if (e.type === 'error' && typeof e.message === 'string') {
        ensureLineBreak()
        writeErr(`error: ${e.message}\n`)
        return
      }
      if (e.type === 'warning' && typeof e.message === 'string') {
        ensureLineBreak()
        writeErr(`warn: ${e.message}\n`)
        return
      }
      if (e.type === 'model_retry') {
        ensureLineBreak()
        const attempt = typeof e.attempt === 'number' ? e.attempt : '?'
        const max = typeof e.maxRetries === 'number' ? e.maxRetries : '?'
        const reason = typeof e.reason === 'string' ? e.reason : 'retry'
        writeErr(`retry ${attempt}/${max} (${reason})\n`)
      }
    },
  }
}