import type { Terminal as XtermTerminalType } from '@xterm/headless'
import xterm from '@xterm/headless'

const XtermTerminal = xterm.Terminal

export type HeadlessTerminalLine = {
  index: number
  text: string
  isWrapped: boolean
}

export type HeadlessTerminalSnapshot = {
  columns: number
  rows: number
  cursor: { column: number; row: number }
  baseY: number
  viewportY: number
  lines: HeadlessTerminalLine[]
}

/**
 * Real VT/cell-buffer harness for CLI layout tests.
 *
 * Unlike the legacy TestTerminalScreen reducer, xterm performs terminal
 * auto-wrap, wide-cell accounting, scrollback, resize reflow and cursor
 * semantics. Product code only sees write(); tests inspect the resulting
 * physical buffer after flush().
 */
export class HeadlessTerminalHarness {
  readonly columns: number
  readonly rows: number
  private readonly terminal: XtermTerminalType

  constructor(options?: {
    columns?: number
    rows?: number
    scrollback?: number
  }) {
    this.columns = options?.columns ?? 80
    this.rows = options?.rows ?? 24
    this.terminal = new XtermTerminal({
      cols: this.columns,
      rows: this.rows,
      scrollback: options?.scrollback ?? 1_000,
      allowProposedApi: true,
      disableStdin: true,
    })
  }

  write = (text: string): void => {
    this.terminal.write(text)
  }

  async flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.terminal.write('', resolve)
    })
  }

  resize(columns: number, rows: number): void {
    this.terminal.resize(columns, rows)
  }

  snapshot(): HeadlessTerminalSnapshot {
    const buffer = this.terminal.buffer.active
    const lines: HeadlessTerminalLine[] = []
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)
      lines.push({
        index,
        text: line?.translateToString(true) ?? '',
        isWrapped: line?.isWrapped ?? false,
      })
    }
    return {
      columns: this.terminal.cols,
      rows: this.terminal.rows,
      cursor: {
        column: buffer.cursorX,
        row: buffer.cursorY,
      },
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      lines,
    }
  }

  viewport(): HeadlessTerminalLine[] {
    const snapshot = this.snapshot()
    return snapshot.lines.slice(
      snapshot.viewportY,
      snapshot.viewportY + snapshot.rows,
    )
  }

  dispose(): void {
    this.terminal.dispose()
  }
}
