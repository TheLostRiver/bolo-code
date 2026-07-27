/**
 * Interactive CLI input: pure reducer/renderer plus a thin raw-mode driver.
 */

import * as readline from 'node:readline'
import {
  clipTerminalText,
  measureTerminalText,
  padTerminalText,
  splitTerminalGraphemes,
  terminalGraphemeWidth,
  wrapTerminalText,
} from './terminalText.ts'

export type TuiInputState = {
  value: string
  /** Grapheme index, not UTF-16 offset. */
  cursor: number
  history: string[]
  historyIndex: number | null
  historyDraft: string
}

export type TuiInputKey = {
  name?: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

export type TuiInputAction = 'submit' | 'exit' | 'clear_screen'

export type ApplyTuiInputKeyResult = {
  state: TuiInputState
  action?: TuiInputAction
  value?: string
}

export type TuiInputStatus = {
  permissionMode?: string
  providerId?: string
  providerKind?: string
  model?: string
  effortLevel?: string
}

export type RenderedTuiInputBox = {
  text: string
  lines: string[]
  cursorRow: number
  cursorColumn: number
}

export function createTuiInputState(options?: {
  value?: string
  history?: string[]
}): TuiInputState {
  const value = options?.value ?? ''
  return {
    value,
    cursor: splitTerminalGraphemes(value).length,
    history: [...(options?.history ?? [])],
    historyIndex: null,
    historyDraft: value,
  }
}

function withValue(
  state: TuiInputState,
  graphemes: string[],
  cursor: number,
): TuiInputState {
  return {
    ...state,
    value: graphemes.join(''),
    cursor: Math.max(0, Math.min(cursor, graphemes.length)),
    historyIndex: null,
  }
}

function insertText(state: TuiInputState, raw: string): TuiInputState {
  const text = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  if (!text) return state
  const before = splitTerminalGraphemes(state.value)
  const inserted = splitTerminalGraphemes(text)
  before.splice(state.cursor, 0, ...inserted)
  return withValue(state, before, state.cursor + inserted.length)
}

function recallHistory(
  state: TuiInputState,
  direction: -1 | 1,
): TuiInputState {
  if (!state.history.length) return state
  if (direction < 0) {
    const next =
      state.historyIndex == null
        ? state.history.length - 1
        : Math.max(0, state.historyIndex - 1)
    const draft =
      state.historyIndex == null ? state.value : state.historyDraft
    const value = state.history[next] ?? ''
    return {
      ...state,
      value,
      cursor: splitTerminalGraphemes(value).length,
      historyIndex: next,
      historyDraft: draft,
    }
  }
  if (state.historyIndex == null) return state
  const next = state.historyIndex + 1
  if (next >= state.history.length) {
    return {
      ...state,
      value: state.historyDraft,
      cursor: splitTerminalGraphemes(state.historyDraft).length,
      historyIndex: null,
    }
  }
  const value = state.history[next] ?? ''
  return {
    ...state,
    value,
    cursor: splitTerminalGraphemes(value).length,
    historyIndex: next,
  }
}

export function applyTuiInputKey(
  state: TuiInputState,
  key: TuiInputKey,
): ApplyTuiInputKeyResult {
  const name = key.name?.toLowerCase()
  const chars = splitTerminalGraphemes(state.value)

  if (
    (key.ctrl && name === 'j') ||
    (name === 'enter' && key.sequence === '\n')
  ) {
    return { state: insertText(state, '\n') }
  }
  if (key.ctrl && name === 'c') {
    return { state, action: 'exit' }
  }
  if (key.ctrl && name === 'l') {
    return { state, action: 'clear_screen' }
  }
  if (key.ctrl && name === 'a') {
    return { state: { ...state, cursor: 0 } }
  }
  if (key.ctrl && name === 'e') {
    return { state: { ...state, cursor: chars.length } }
  }
  if (key.ctrl && name === 'u') {
    return { state: withValue(state, chars.slice(state.cursor), 0) }
  }
  if (key.ctrl && name === 'k') {
    return {
      state: withValue(state, chars.slice(0, state.cursor), state.cursor),
    }
  }
  if (key.ctrl && name === 'w') {
    let start = state.cursor
    while (start > 0 && /\s/u.test(chars[start - 1] ?? '')) start--
    while (start > 0 && !/\s/u.test(chars[start - 1] ?? '')) start--
    chars.splice(start, state.cursor - start)
    return { state: withValue(state, chars, start) }
  }
  if (key.ctrl && name === 'd') {
    if (!chars.length) return { state, action: 'exit' }
    if (state.cursor < chars.length) chars.splice(state.cursor, 1)
    return { state: withValue(state, chars, state.cursor) }
  }

  if (name === 'return' || name === 'enter') {
    return { state, action: 'submit', value: state.value }
  }
  if (name === 'backspace') {
    if (state.cursor > 0) {
      chars.splice(state.cursor - 1, 1)
      return { state: withValue(state, chars, state.cursor - 1) }
    }
    return { state }
  }
  if (name === 'delete') {
    if (state.cursor < chars.length) chars.splice(state.cursor, 1)
    return { state: withValue(state, chars, state.cursor) }
  }
  if (name === 'left') {
    return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } }
  }
  if (name === 'right') {
    return {
      state: { ...state, cursor: Math.min(chars.length, state.cursor + 1) },
    }
  }
  if (name === 'home') return { state: { ...state, cursor: 0 } }
  if (name === 'end') {
    return { state: { ...state, cursor: chars.length } }
  }
  if (name === 'up') return { state: recallHistory(state, -1) }
  if (name === 'down') return { state: recallHistory(state, 1) }

  const sequence = key.sequence ?? ''
  if (
    sequence &&
    !key.ctrl &&
    !key.meta &&
    !sequence.includes('\u001b') &&
    !sequence.includes('\u0000')
  ) {
    return { state: insertText(state, sequence) }
  }
  return { state }
}

type WrappedInputLine = {
  text: string
  width: number
}

function wrapInputAtCursor(
  state: TuiInputState,
  width: number,
): {
  lines: WrappedInputLine[]
  cursorLine: number
  cursorWidth: number
} {
  const chars = splitTerminalGraphemes(state.value)
  const lines: WrappedInputLine[] = [{ text: '', width: 0 }]
  let cursorLine = 0
  let cursorWidth = 0

  for (let index = 0; index <= chars.length; index++) {
    let line = lines[lines.length - 1]!
    if (index === state.cursor) {
      cursorLine = lines.length - 1
      cursorWidth = line.width
    }
    if (index === chars.length) break
    const grapheme = chars[index]!
    if (grapheme === '\r') continue
    if (grapheme === '\n') {
      lines.push({ text: '', width: 0 })
      continue
    }
    const cellWidth = terminalGraphemeWidth(grapheme)
    if (line.text && line.width + cellWidth > width) {
      lines.push({ text: '', width: 0 })
      line = lines[lines.length - 1]!
      if (index === state.cursor) {
        cursorLine = lines.length - 1
        cursorWidth = 0
      }
    }
    line.text += grapheme
    line.width += cellWidth
  }
  return { lines, cursorLine, cursorWidth }
}

function borderLine(
  left: string,
  right: string,
  width: number,
  label = '',
): string {
  const inner = width - 2
  const text = label ? `─ ${label} ` : ''
  return `${left}${text}${'─'.repeat(Math.max(0, inner - measureTerminalText(text)))}${right}`
}

function formatInputStatus(status?: TuiInputStatus): string {
  if (!status) return ''
  const mode = status.permissionMode?.trim() || 'default'
  const provider = status.providerId?.trim() || status.providerKind?.trim() || ''
  const model = status.model?.trim() || ''
  const target =
    provider && model
      ? `${provider}/${model}`
      : provider || model || '(no model)'
  const effort = status.effortLevel?.trim() || 'auto'
  return `${mode} · ${target} · effort ${effort}`
}

export function renderTuiInputBox(options: {
  state: TuiInputState
  columns?: number
  status?: TuiInputStatus
  color?: boolean
  maxBodyRows?: number
  title?: string
}): RenderedTuiInputBox {
  const columns = Math.max(24, Math.floor(options.columns ?? 80))
  const frameWidth = Math.min(120, Math.max(24, columns - 1))
  const contentWidth = Math.max(8, frameWidth - 6)
  const maxBodyRows = Math.max(1, options.maxBodyRows ?? 4)
  const wrapped = wrapInputAtCursor(options.state, contentWidth)
  const start = Math.max(
    0,
    Math.min(
      wrapped.cursorLine - maxBodyRows + 1,
      wrapped.lines.length - maxBodyRows,
    ),
  )
  const visible = wrapped.lines.slice(start, start + maxBodyRows)
  if (!visible.length) visible.push({ text: '', width: 0 })

  const color = options.color !== false
  const border = color ? '\u001b[38;5;244m' : ''
  const prompt = color ? '\u001b[38;5;81m' : ''
  const dim = color ? '\u001b[2m' : ''
  const reset = color ? '\u001b[0m' : ''
  const lines: string[] = []
  lines.push(
    `${border}${borderLine('╭', '╮', frameWidth, options.title ?? 'Message')}${reset}`,
  )
  for (let index = 0; index < visible.length; index++) {
    const marker = start + index === 0 ? '❯ ' : '  '
    const body = padTerminalText(visible[index]!.text, contentWidth)
    lines.push(
      `${border}│${reset} ${prompt}${marker}${reset}${body} ${border}│${reset}`,
    )
  }
  lines.push(`${border}${borderLine('╰', '╯', frameWidth)}${reset}`)

  const status = clipTerminalText(`  ${formatInputStatus(options.status)}`, frameWidth)
  if (status.trim()) lines.push(`${dim}${status}${reset}`)
  lines.push(
    `${dim}${clipTerminalText('  Enter send · Ctrl+J newline · ↑↓ history · Ctrl+C exit', frameWidth)}${reset}`,
  )

  const cursorRow = 1 + wrapped.cursorLine - start
  const cursorColumn = 1 + 1 + 2 + wrapped.cursorWidth
  return {
    text: lines.join('\n'),
    lines,
    cursorRow,
    cursorColumn,
  }
}

export function renderUserMessage(
  prompt: string,
  options?: { columns?: number; color?: boolean },
): string {
  const columns = Math.min(120, Math.max(24, (options?.columns ?? 80) - 1))
  const contentWidth = Math.max(8, columns - 3)
  const lines = wrapTerminalText(prompt.trim(), contentWidth)
  const color = options?.color !== false
  const accent = color ? '\u001b[38;5;81m' : ''
  const reset = color ? '\u001b[0m' : ''
  return lines
    .map((line, index) =>
      index === 0
        ? `${accent}❯${reset} ${line}`
        : `  ${line}`,
    )
    .join('\n')
}

type RawInput = NodeJS.ReadStream & {
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
}

export type ReadTuiInputResult =
  | { type: 'submit'; value: string }
  | { type: 'exit' }
  | { type: 'aborted' }

export function canUseTuiInput(input: RawInput = process.stdin): boolean {
  return input.isTTY === true && typeof input.setRawMode === 'function'
}

export function shouldUseDynamicTui(options?: {
  isTty?: boolean
  input?: RawInput
  stdoutIsTty?: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  const env = options?.env ?? process.env
  const disabled =
    env.BOLO_TUI_LAYOUT === '0' ||
    env.BOLO_TUI_LAYOUT === 'false' ||
    env.BOLO_TUI_INPUT === '0' ||
    env.BOLO_TUI_INPUT === 'false' ||
    env.TERM === 'dumb'
  if (disabled) return false
  return (
    options?.isTty !== false &&
    canUseTuiInput(options?.input ?? process.stdin) &&
    (options?.stdoutIsTty ?? process.stdout.isTTY === true)
  )
}

/**
 * Short-lived raw editor. It exists only while the agent is idle; once a turn
 * starts stdin returns to normal signal handling and permission/picker panels
 * can own it without competing listeners.
 */
export async function readTuiInput(options: {
  input?: RawInput
  writeOut?: (text: string) => void
  columns?: number
  status?: TuiInputStatus
  history?: string[]
  signal?: AbortSignal
  color?: boolean
}): Promise<ReadTuiInputResult> {
  const input = options.input ?? process.stdin
  if (!canUseTuiInput(input)) {
    throw new Error('interactive TUI input requires a raw-mode TTY')
  }
  const writeOut = options.writeOut ?? ((text) => process.stdout.write(text))
  const wasRaw = input.isRaw === true
  let state = createTuiInputState({ history: options.history })
  let rendered: RenderedTuiInputBox | null = null
  let settled = false

  const clearRendered = () => {
    if (!rendered) return
    writeOut('\u001b[?25l\r')
    if (rendered.cursorRow > 0) {
      writeOut(`\u001b[${rendered.cursorRow}A`)
    }
    for (let index = 0; index < rendered.lines.length; index++) {
      writeOut('\u001b[2K')
      if (index < rendered.lines.length - 1) writeOut('\u001b[1B\r')
    }
    if (rendered.lines.length > 1) {
      writeOut(`\u001b[${rendered.lines.length - 1}A`)
    }
    writeOut('\r\u001b[?25h')
    rendered = null
  }

  const draw = () => {
    clearRendered()
    rendered = renderTuiInputBox({
      state,
      columns: options.columns ?? process.stdout.columns ?? 80,
      status: options.status,
      color: options.color,
    })
    writeOut('\u001b[?25l')
    writeOut(rendered.text)
    const rowsUp = rendered.lines.length - 1 - rendered.cursorRow
    if (rowsUp > 0) writeOut(`\u001b[${rowsUp}A`)
    writeOut('\r')
    if (rendered.cursorColumn > 0) {
      writeOut(`\u001b[${rendered.cursorColumn}C`)
    }
    writeOut('\u001b[?25h')
  }

  readline.emitKeypressEvents(input)
  input.setRawMode?.(true)
  input.resume()
  draw()

  return await new Promise<ReadTuiInputResult>((resolve) => {
    const cleanup = () => {
      input.removeListener('keypress', onKeypress)
      options.signal?.removeEventListener('abort', onAbort)
      clearRendered()
      if (!wasRaw) input.setRawMode?.(false)
      input.pause()
    }
    const finish = (result: ReadTuiInputResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onAbort = () => finish({ type: 'aborted' })
    const onKeypress = (sequence: string, key: readline.Key) => {
      const result = applyTuiInputKey(state, {
        name: key.name,
        sequence: sequence || key.sequence,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
      })
      state = result.state
      if (result.action === 'submit') {
        finish({ type: 'submit', value: result.value ?? state.value })
        return
      }
      if (result.action === 'exit') {
        finish({ type: 'exit' })
        return
      }
      if (result.action === 'clear_screen') {
        clearRendered()
        writeOut('\u001b[2J\u001b[H')
      }
      draw()
    }
    input.on('keypress', onKeypress)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}
