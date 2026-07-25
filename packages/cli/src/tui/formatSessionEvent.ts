/**
 * T4/U3：SessionEvent → 可读终端行（纯函数，无 I/O）
 * 对照 HC 时间线：text 增量；thinking dim；tool 起止；写后 history cell（可折叠）。
 */

/** 与 core SessionEvent 对齐的最小形状（避免 cli↔core 环依赖过重） */
export type CliSessionEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
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
      output?: string
      ok: boolean
      path?: string
      added?: number
      removed?: number
      summaryLine?: string
      ansiUnified?: string
      files?: Array<{
        path: string
        op?: string
        added?: number
        removed?: number
      }>
      cellCollapsed?: string
      cellExpanded?: string
    }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | { type: string; [k: string]: unknown }

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function envExpandCell(): boolean {
  const v = (process.env.BOLO_DIFF_CELL ?? '').toLowerCase()
  if (v === '0' || v === 'fold' || v === 'collapsed') return false
  if (v === '1' || v === 'full' || v === 'expand' || v === 'expanded') {
    return true
  }
  const verbose = process.env.BOLO_DIFF_VERBOSE
  return verbose === '1' || verbose === 'true' || verbose === 'yes'
}

/**
 * 工具起止/进度/写后 cell；其它事件返回 null。
 */
export function formatToolEventLine(e: CliSessionEvent): string | null {
  if (e.type === 'tool_start' && typeof e.name === 'string') {
    return `→ ${e.name}`
  }
  if (e.type === 'tool_progress' && typeof e.name === 'string') {
    const msg =
      typeof e.message === 'string' && e.message.trim()
        ? e.message.trim()
        : ''
    const body = msg ? `${e.name} ${msg}` : e.name
    return `${DIM}… ${body}${RESET}`
  }
  if (e.type === 'tool_end' && typeof e.name === 'string') {
    const expand = envExpandCell()
    // U3：优先用 core 预渲染的 cell
    if (expand && typeof e.cellExpanded === 'string' && e.cellExpanded.trim()) {
      return e.cellExpanded.trim()
    }
    if (
      !expand &&
      typeof e.cellCollapsed === 'string' &&
      e.cellCollapsed.trim()
    ) {
      return e.cellCollapsed.trim()
    }
    // 回落：summaryLine + 可选 unified（展开时）
    if (typeof e.summaryLine === 'string' && e.summaryLine.trim()) {
      if (
        expand &&
        typeof e.ansiUnified === 'string' &&
        e.ansiUnified.trim()
      ) {
        return `${e.summaryLine}\n${e.ansiUnified}`
      }
      if (!expand) {
        // 折叠：只取 summary 首行 + 提示
        const first = e.summaryLine.split(/\r?\n/)[0] ?? e.summaryLine
        const hasMore =
          e.summaryLine.includes('\n') ||
          e.ansiUnified ||
          (Array.isArray(e.files) && e.files.length > 0)
        if (hasMore) {
          return `${first}\n${DIM}  ▸ folded · /diff to browse${RESET}`
        }
        return first
      }
      return e.summaryLine
    }
    const ok = e.ok !== false
    const pathPart =
      typeof e.path === 'string' && e.path.trim() ? `  ${e.path}` : ''
    const a = e.added ?? 0
    const r = e.removed ?? 0
    const counts =
      e.added != null || e.removed != null
        ? `  \x1b[32m+${a}\x1b[0m/\x1b[31m-${r}\x1b[0m`
        : ''
    return ok
      ? `✓ ${e.name}${pathPart}${counts}`
      : `✗ ${e.name}${pathPart}`
  }
  return null
}

/**
 * 将事件格式化为应写入 stdout/stderr 的片段（可多段）。
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
 * 会话 onEvent 打印机：流式 text + thinking + 工具/cell 行。
 */
export function createSessionEventPrinter(opts: {
  writeOut: (s: string) => void
  writeErr?: (s: string) => void
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
