import type { Component } from './piCompat.ts'
import type {
  CliCommandPanelState,
  CliCommandSurfaceState,
  CliCommandSurfaceTone,
} from '../../../shared/src/index.ts'
import { resolveTuiDockWidth } from './frame.ts'
import {
  clipTerminalText,
  measureTerminalText,
  padTerminalText,
  wrapTerminalText,
} from './terminalText.ts'

export type FormatCliCommandSurfaceOptions = {
  columns?: number
  rows?: number
  color?: boolean
}

function normalizeDimension(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.floor(value!))
    : fallback
}

function frameLine(
  left: string,
  right: string,
  width: number,
  title?: string,
): string {
  if (width <= 1) return left
  if (width === 2) return `${left}${right}`
  const innerWidth = width - 2
  const label = title
    ? ` ${clipTerminalText(title, Math.max(1, innerWidth - 2))} `
    : ''
  const clippedLabel = clipTerminalText(label, innerWidth)
  return `${left}${clippedLabel}${'─'.repeat(
    Math.max(0, innerWidth - measureTerminalText(clippedLabel)),
  )}${right}`
}

function panelBodyLine(text: string, width: number): string {
  if (width < 4) return clipTerminalText(text, width)
  return `│ ${padTerminalText(text, width - 4)} │`
}

function renderCompactPanel(
  panel: CliCommandPanelState,
  frameWidth: number,
  maxHeight: number,
): string[] {
  if (maxHeight <= 0) return []
  const title = panel.title?.trim() || 'Command'
  if (maxHeight < 3 || frameWidth < 4) {
    return [clipTerminalText(`[${title}] ${panel.content}`, frameWidth)]
  }

  const bodyWidth = Math.max(1, frameWidth - 4)
  const wrapped = wrapTerminalText(panel.content, bodyWidth)
  const bodyLimit = maxHeight - 2
  const visible = wrapped.slice(0, bodyLimit)
  if (wrapped.length > bodyLimit && visible.length) {
    visible[visible.length - 1] = clipTerminalText(
      `${visible[visible.length - 1]}…`,
      bodyWidth,
    )
  }
  if (!visible.length) visible.push('')

  return [
    // 面板用单线框（┌┐└┘）——与输入框（composer）的双线框（╭╮╰╯）区分，
    // 避免 command surface 被误认为「第二个输入框」
    frameLine('┌', '┐', frameWidth, title),
    ...visible.map((line) => panelBodyLine(line, frameWidth)),
    frameLine('└', '┘', frameWidth),
  ]
}

export function doesCliCommandPanelOverflow(
  content: string,
  options: FormatCliCommandSurfaceOptions = {},
): boolean {
  const columns = normalizeDimension(options.columns, 80)
  const rows = normalizeDimension(options.rows, 24)
  const frameWidth = Math.min(columns, resolveTuiDockWidth(columns))
  const maxHeight = Math.min(10, Math.floor(rows * 0.4))
  if (maxHeight < 3 || frameWidth < 4) {
    return measureTerminalText(content) > frameWidth || content.includes('\n')
  }
  const bodyWidth = Math.max(1, frameWidth - 4)
  const bodyLimit = maxHeight - 2
  return wrapTerminalText(content, bodyWidth).length > bodyLimit
}

function tonePrefix(tone: CliCommandSurfaceTone): string {
  switch (tone) {
    case 'success':
      return '✓'
    case 'warning':
      return '!'
    case 'error':
      return '×'
    case 'info':
      return '•'
  }
}

function toneColor(tone: CliCommandSurfaceTone): string {
  switch (tone) {
    case 'success':
      return '\u001b[38;5;114m'
    case 'warning':
      return '\u001b[38;5;221m'
    case 'error':
      return '\u001b[38;5;203m'
    case 'info':
      return '\u001b[38;5;81m'
  }
}

export function formatCliCommandSurface(
  state: CliCommandSurfaceState,
  options: FormatCliCommandSurfaceOptions = {},
): string[] {
  const columns = normalizeDimension(options.columns, 80)
  const rows = normalizeDimension(options.rows, 24)
  const frameWidth = Math.min(columns, resolveTuiDockWidth(columns))
  const color = options.color !== false
  const reset = color ? '\u001b[0m' : ''
  const border = color ? '\u001b[38;5;244m' : ''
  const lines: string[] = []

  if (state.panel) {
    const maxPanelHeight = Math.min(10, Math.floor(rows * 0.4))
    const panelLines = renderCompactPanel(
      state.panel,
      frameWidth,
      maxPanelHeight,
    )
    for (const line of panelLines) {
      lines.push(color ? `${border}${line}${reset}` : line)
    }
  }

  if (state.toast) {
    // 多行 toast：逐行拆渲染（行内含 \n 会破坏终端布局——渲染行数必须
    // 与终端实际占行一致）；前缀只加首行。
    // 净化：bare ESC（stripTerminalAnsi 只清 CSI/OSC 完整序列——残余裸
    // ESC 如 ESC E 会加行/清屏破坏行数不变式）、C0 VT/FF（xterm 换行）
    // 与 C1 控制区（\u0080-\u009f——xterm 将 \u009b 当 CSI 前缀）一并剥离；
    // \r 消除（行中回车会覆盖行首）。
    const sanitized = state.toast.content
      .replace(/\x1b/g, '')
      .replace(/[\u000b\u000c]/g, '')
      .replace(/[\u0080-\u009f]/g, '')
      .replace(/\r/g, '')
    const prefix = `${tonePrefix(state.toast.tone)} `
    const body = sanitized.split('\n').map((l) => l.trimEnd())
    // 行数上限（受界于 40% 视口——panel 为 min(10, 40%)−2；toast 略宽但
    // 有界——防止病理多行内容洪泛/挤走 footer）
    const maxToastRows = Math.max(1, Math.floor(rows * 0.4))
    const visible = body.slice(0, maxToastRows)
    const first = clipTerminalText(`${prefix}${visible[0] ?? ''}`, frameWidth)
    lines.push(
      color ? `${toneColor(state.toast.tone)}${first}${reset}` : first,
    )
    for (const rest of visible.slice(1)) {
      const clipped = clipTerminalText(rest, frameWidth)
      // 空行保留（渲染为空行）——行数与终端占行严格一致
      lines.push(
        color
          ? `${toneColor(state.toast.tone)}${clipped}${reset}`
          : clipped,
      )
    }
  }

  return lines
}

export class RetainedCommandSurface implements Component {
  private state: CliCommandSurfaceState

  constructor(
    state: CliCommandSurfaceState,
    private readonly options: {
      color: boolean
      getViewportRows: () => number
    },
  ) {
    this.state = state
  }

  setState(state: CliCommandSurfaceState): void {
    this.state = state
  }

  invalidate(): void {}

  render(width: number): string[] {
    return formatCliCommandSurface(this.state, {
      columns: width,
      rows: this.options.getViewportRows(),
      color: this.options.color,
    })
  }
}
