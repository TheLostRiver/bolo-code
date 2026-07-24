/**
 * T4：SessionEvent → 可读终端行（纯函数，无 I/O）
 * 对照 HC 时间线简化：text 原样增量；tool 一行起止。
 */

/** 与 core SessionEvent 对齐的最小形状（避免 cli↔core 环依赖过重） */
export type CliSessionEvent =
  | { type: 'text'; text: string }
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

/**
 * 工具起止简行；其它事件返回 null（text 由打印机原样写）。
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
 * text：原样 delta（可能无换行）；tool：独立一行（含尾换行）。
 */
export function formatSessionEventChunks(
  e: CliSessionEvent,
): { stream: 'out' | 'err'; text: string }[] {
  if (e.type === 'text' && typeof e.text === 'string' && e.text.length > 0) {
    return [{ stream: 'out', text: e.text }]
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
  return []
}

export type SessionEventPrinter = {
  onEvent: (e: CliSessionEvent) => void
  beginTurn: () => void
  endTurn: () => void
  didStreamText: () => boolean
}

/**
 * 会话 onEvent 打印机：流式 text + 工具简行；不刷 phase/hook 等噪声。
 */
export function createSessionEventPrinter(opts: {
  writeOut: (s: string) => void
  writeErr?: (s: string) => void
}): SessionEventPrinter {
  const writeOut = opts.writeOut
  const writeErr = opts.writeErr ?? ((s: string) => process.stderr.write(s))
  let openTextLine = false
  let streamedText = false

  const ensureToolLineBreak = () => {
    if (openTextLine) {
      writeOut('\n')
      openTextLine = false
    }
  }

  return {
    beginTurn() {
      streamedText = false
      openTextLine = false
    },
    endTurn() {
      if (openTextLine) {
        writeOut('\n')
        openTextLine = false
      }
    },
    didStreamText() {
      return streamedText
    },
    onEvent(e) {
      if (e.type === 'text' && typeof e.text === 'string' && e.text.length > 0) {
        writeOut(e.text)
        streamedText = true
        openTextLine = !e.text.endsWith('\n')
        return
      }
      const toolLine = formatToolEventLine(e)
      if (toolLine) {
        ensureToolLineBreak()
        writeOut(`${toolLine}\n`)
        return
      }
      if (e.type === 'error' && typeof e.message === 'string') {
        ensureToolLineBreak()
        writeErr(`error: ${e.message}\n`)
        return
      }
      if (e.type === 'warning' && typeof e.message === 'string') {
        ensureToolLineBreak()
        writeErr(`warn: ${e.message}\n`)
      }
    },
  }
}