import { stripTerminalAnsi } from './terminalText.ts'

export type TerminalDock = {
  lines: string[]
  cursorRow: number
  cursorColumn: number
  showCursor?: boolean
}

export type TerminalSurface = {
  setDock(dock: TerminalDock): void
  clearDock(): void
  setActivity(line: string): boolean
  clearActivity(): boolean
  writeOutput(text: string): void
  writeError(text: string): void
  suspend(): void
  resume(): void
  isDockVisible(): boolean
  dispose(): void
}

const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const SAVE_CURSOR = '\u001b7'
const RESTORE_CURSOR = '\u001b8'

function updateLineStart(current: boolean, text: string): boolean {
  const plain = stripTerminalAnsi(text)
  if (!plain) return current
  return plain.endsWith('\n') || plain.endsWith('\r')
}

/**
 * Own the temporary rows below append-only terminal history.
 *
 * The history cursor is saved before painting. Appends erase only owned rows,
 * restore that cursor, write history, then save and repaint below it.
 */
export function createTerminalSurface(options: {
  writeOut: (text: string) => void
  writeErr?: (text: string) => void
}): TerminalSurface {
  const rawOut = options.writeOut
  const rawErr = options.writeErr ?? options.writeOut
  let dock: TerminalDock | undefined
  let activity: string | undefined
  let suspended = false
  let visible = false
  let visibleLineCount = 0
  let visibleCursorRow = 0
  let historyAtLineStart = true

  const composite = (): { lines: string[]; cursorRow: number } => {
    if (!dock) return { lines: [], cursorRow: 0 }
    const prefix = activity ? [activity, ''] : ['']
    return {
      lines: [...prefix, ...dock.lines],
      cursorRow:
        prefix.length +
        Math.max(0, Math.min(dock.cursorRow, dock.lines.length - 1)),
    }
  }

  const eraseAndRestore = (): string => {
    if (!visible || visibleLineCount <= 0) return ''
    let sequence = `${HIDE_CURSOR}\r`
    if (visibleCursorRow > 0) {
      sequence += `\u001b[${visibleCursorRow}A`
    }
    for (let index = 0; index < visibleLineCount; index++) {
      sequence += '\u001b[2K'
      if (index < visibleLineCount - 1) sequence += '\u001b[1B\r'
    }
    if (visibleLineCount > 1) {
      sequence += `\u001b[${visibleLineCount - 1}A`
    }
    sequence += `\r${RESTORE_CURSOR}`
    visible = false
    visibleLineCount = 0
    visibleCursorRow = 0
    return sequence
  }

  const paint = (): string => {
    if (!dock || suspended) return ''
    const rendered = composite()
    if (!rendered.lines.length) return ''

    let sequence = SAVE_CURSOR
    if (!historyAtLineStart) sequence += '\n'
    sequence += HIDE_CURSOR
    sequence += rendered.lines.join('\n')
    const rowsUp = rendered.lines.length - 1 - rendered.cursorRow
    if (rowsUp > 0) sequence += `\u001b[${rowsUp}A`
    sequence += '\r'
    const cursorColumn = Math.max(0, dock.cursorColumn)
    if (cursorColumn > 0) sequence += `\u001b[${cursorColumn}C`
    sequence += dock.showCursor === false ? HIDE_CURSOR : SHOW_CURSOR

    visible = true
    visibleLineCount = rendered.lines.length
    visibleCursorRow = rendered.cursorRow
    return sequence
  }

  const replaceTemporaryRegion = () => {
    if (!dock || suspended) return
    rawOut(`${eraseAndRestore()}${paint()}`)
  }

  const append = (
    text: string,
    target: (value: string) => void,
    sameStream: boolean,
  ) => {
    if (!text) return
    if (!visible) {
      target(text)
      historyAtLineStart = updateLineStart(historyAtLineStart, text)
      return
    }
    const before = eraseAndRestore()
    historyAtLineStart = updateLineStart(historyAtLineStart, text)
    const after = paint()
    if (sameStream) {
      rawOut(`${before}${text}${after}`)
      return
    }
    rawOut(before)
    target(text)
    rawOut(after)
  }

  const surface: TerminalSurface = {
    setDock(nextDock) {
      const before = eraseAndRestore()
      dock = nextDock
      activity = undefined
      suspended = false
      rawOut(`${before}${paint()}`)
    },
    clearDock() {
      const before = eraseAndRestore()
      dock = undefined
      activity = undefined
      suspended = false
      if (before) rawOut(`${before}${SHOW_CURSOR}`)
    },
    setActivity(line) {
      if (!dock || suspended) return false
      activity = line
      replaceTemporaryRegion()
      return true
    },
    clearActivity() {
      if (!dock || suspended) return false
      if (activity !== undefined) {
        activity = undefined
        replaceTemporaryRegion()
      }
      return true
    },
    writeOutput(text) {
      append(text, rawOut, true)
    },
    writeError(text) {
      append(text, rawErr, rawErr === rawOut)
    },
    suspend() {
      if (!dock || suspended) return
      const before = eraseAndRestore()
      suspended = true
      if (before) rawOut(`${before}${SHOW_CURSOR}`)
    },
    resume() {
      if (!dock || !suspended) return
      suspended = false
      rawOut(paint())
    },
    isDockVisible() {
      return visible && !suspended
    },
    dispose() {
      surface.clearDock()
    },
  }
  return surface
}
