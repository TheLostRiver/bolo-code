import type { Component } from '@earendil-works/pi-tui/dist/tui.js'
import { resolveTuiContentGutter } from './contentLayout.ts'
import { clipTerminalText } from './terminalText.ts'

export class RetainedActivity implements Component {
  private line = ''

  constructor(private readonly requestRender: () => void) {}

  setLine(line: string): boolean {
    if (this.line === line) return true
    this.line = line
    this.requestRender()
    return true
  }

  clear(): boolean {
    if (!this.line) return true
    this.line = ''
    this.requestRender()
    return true
  }

  getLine(): string {
    return this.line
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.line) return []
    const normalizedWidth = Math.max(1, Math.floor(width))
    const gutter = resolveTuiContentGutter(normalizedWidth)
    const contentWidth = Math.max(1, normalizedWidth - gutter)
    return [
      `${' '.repeat(gutter)}${clipTerminalText(this.line, contentWidth)}`,
    ]
  }
}
