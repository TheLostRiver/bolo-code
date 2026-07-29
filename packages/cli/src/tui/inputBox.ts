/**
 * Interactive CLI input: pure reducer/renderer plus a thin raw-mode driver.
 */

import {
  filterSlashCommandCandidates,
  type SlashCommandCandidate,
} from '../../../core/src/index.ts'
import {
  clipTerminalText,
  measureTerminalText,
  padTerminalText,
  splitTerminalGraphemes,
  stripTerminalAnsi,
  terminalGraphemeWidth,
  wrapTerminalText,
} from './terminalText.ts'
import { resolveTuiDockWidth } from './frame.ts'

export type TuiInputState = {
  value: string
  /** Grapheme index, not UTF-16 offset. */
  cursor: number
  history: string[]
  historyIndex: number | null
  historyDraft: string
  slashCandidates: SlashCommandCandidate[]
  slashMenu: TuiSlashMenuState | null
}

export type TuiSlashMenuState = {
  items: SlashCommandCandidate[]
  selectedIndex: number
  query: string
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
  usage?: TuiInputUsage
}

export type TuiInputUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  estimated?: boolean
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
  slashCandidates?: readonly SlashCommandCandidate[]
}): TuiInputState {
  const value = options?.value ?? ''
  const state: TuiInputState = {
    value,
    cursor: splitTerminalGraphemes(value).length,
    history: [...(options?.history ?? [])],
    historyIndex: null,
    historyDraft: value,
    slashCandidates: [...(options?.slashCandidates ?? [])],
    slashMenu: null,
  }
  return refreshSlashMenu(state)
}

export function configureTuiInputState(
  state: TuiInputState,
  options: {
    history?: readonly string[]
    slashCandidates?: readonly SlashCommandCandidate[]
  },
): TuiInputState {
  return refreshSlashMenu({
    ...state,
    ...(options.history
      ? {
          history: [...options.history],
          historyIndex: null,
          historyDraft: state.value,
        }
      : {}),
    ...(options.slashCandidates
      ? { slashCandidates: [...options.slashCandidates] }
      : {}),
  })
}

function isSlashCompletionContext(state: TuiInputState): boolean {
  const chars = splitTerminalGraphemes(state.value)
  return (
    state.cursor === chars.length &&
    state.value.startsWith('/') &&
    !state.value.startsWith('//') &&
    !/\s/u.test(state.value.slice(1))
  )
}

function refreshSlashMenu(
  state: TuiInputState,
  previous = state.slashMenu,
): TuiInputState {
  if (!isSlashCompletionContext(state)) {
    return state.slashMenu === null ? state : { ...state, slashMenu: null }
  }
  const items = filterSlashCommandCandidates(
    state.slashCandidates,
    state.value,
  )
  const selectedName =
    previous?.query === state.value
      ? previous.items[previous.selectedIndex]?.name
      : undefined
  const preservedIndex = selectedName
    ? items.findIndex((candidate) => candidate.name === selectedName)
    : -1
  return {
    ...state,
    slashMenu: {
      items,
      selectedIndex: preservedIndex >= 0 ? preservedIndex : 0,
      query: state.value,
    },
  }
}

function withValue(
  state: TuiInputState,
  graphemes: string[],
  cursor: number,
): TuiInputState {
  return refreshSlashMenu({
    ...state,
    value: graphemes.join(''),
    cursor: Math.max(0, Math.min(cursor, graphemes.length)),
    historyIndex: null,
  })
}

function withCursor(state: TuiInputState, cursor: number): TuiInputState {
  const chars = splitTerminalGraphemes(state.value)
  return refreshSlashMenu({
    ...state,
    cursor: Math.max(0, Math.min(cursor, chars.length)),
  })
}

function selectSlashMenuItem(
  state: TuiInputState,
  direction: -1 | 1,
): TuiInputState {
  const menu = state.slashMenu
  if (!menu || menu.items.length === 0) return state
  const selectedIndex =
    (menu.selectedIndex + direction + menu.items.length) % menu.items.length
  return {
    ...state,
    slashMenu: { ...menu, selectedIndex },
  }
}

function completeSlashMenuItem(state: TuiInputState): TuiInputState | null {
  const menu = state.slashMenu
  const candidate = menu?.items[menu.selectedIndex]
  if (!candidate) return null
  const value = `/${candidate.name} `
  return {
    ...state,
    value,
    cursor: splitTerminalGraphemes(value).length,
    historyIndex: null,
    slashMenu: null,
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

export function insertTuiInputText(
  state: TuiInputState,
  raw: string,
): TuiInputState {
  return insertText(state, raw)
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
    return refreshSlashMenu({
      ...state,
      value,
      cursor: splitTerminalGraphemes(value).length,
      historyIndex: next,
      historyDraft: draft,
    })
  }
  if (state.historyIndex == null) return state
  const next = state.historyIndex + 1
  if (next >= state.history.length) {
    return refreshSlashMenu({
      ...state,
      value: state.historyDraft,
      cursor: splitTerminalGraphemes(state.historyDraft).length,
      historyIndex: null,
    })
  }
  const value = state.history[next] ?? ''
  return refreshSlashMenu({
    ...state,
    value,
    cursor: splitTerminalGraphemes(value).length,
    historyIndex: next,
  })
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
    return { state: withCursor(state, 0) }
  }
  if (key.ctrl && name === 'e') {
    return { state: withCursor(state, chars.length) }
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

  if (name === 'escape' && state.slashMenu) {
    return { state: { ...state, slashMenu: null } }
  }
  if (name === 'return' || name === 'enter') {
    const completed = completeSlashMenuItem(state)
    if (completed) return { state: completed }
    return { state, action: 'submit', value: state.value }
  }
  if (name === 'tab' && state.slashMenu) {
    const completed = completeSlashMenuItem(state)
    return { state: completed ?? state }
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
    return { state: withCursor(state, state.cursor - 1) }
  }
  if (name === 'right') {
    return { state: withCursor(state, state.cursor + 1) }
  }
  if (name === 'home') return { state: withCursor(state, 0) }
  if (name === 'end') {
    return { state: withCursor(state, chars.length) }
  }
  if (name === 'up' && state.slashMenu) {
    return { state: selectSlashMenuItem(state, -1) }
  }
  if (name === 'down' && state.slashMenu) {
    return { state: selectSlashMenuItem(state, 1) }
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
  ghostText?: string
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

function resolveSlashArgumentHint(state: TuiInputState): string {
  const chars = splitTerminalGraphemes(state.value)
  if (state.cursor !== chars.length) return ''
  const match = /^\/([^\s/]+) $/u.exec(state.value)
  if (!match) return ''
  const commandName = match[1]!.toLowerCase()
  return (
    state.slashCandidates
      .find((candidate) => candidate.name.toLowerCase() === commandName)
      ?.argumentHint?.trim() ?? ''
  )
}

function appendInputGhostHint(
  lines: WrappedInputLine[],
  hint: string,
  width: number,
): void {
  const line = lines[lines.length - 1]
  if (!line || !hint) return
  const available = Math.max(0, width - line.width)
  if (!available) return
  const ghostText = clipTerminalText(hint, available)
  if (!ghostText) return
  line.ghostText = ghostText
  line.width += measureTerminalText(ghostText)
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

export function formatTuiTokenCount(value: number): string {
  const normalized = Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0
  if (normalized < 1_000) return String(normalized)
  const divisor = normalized >= 1_000_000 ? 1_000_000 : 1_000
  const suffix = divisor === 1_000_000 ? 'm' : 'k'
  const scaled = normalized / divisor
  const precision = scaled < 100 ? 1 : 0
  return `${scaled.toFixed(precision).replace(/\.0$/u, '')}${suffix}`
}

type FooterSegment = {
  text: string
  tone?: 'bold' | 'dim'
}

function footerSegmentsWidth(segments: readonly FooterSegment[]): number {
  return measureTerminalText(segments.map((segment) => segment.text).join(''))
}

function renderFooterSegments(
  segments: readonly FooterSegment[],
  color: boolean,
): string {
  if (!color) return segments.map((segment) => segment.text).join('')
  return segments
    .map((segment) => {
      const start =
        segment.tone === 'bold'
          ? '\u001b[1m'
          : segment.tone === 'dim'
            ? '\u001b[2m'
            : ''
      return start ? `${start}${segment.text}\u001b[0m` : segment.text
    })
    .join('')
}

function valueSegment(text: string): FooterSegment {
  return { text, tone: 'bold' }
}

function separatorSegment(text = ' · '): FooterSegment {
  return { text, tone: 'dim' }
}

function renderStatusFooter(options: {
  status?: TuiInputStatus
  width: number
  color: boolean
}): string {
  const { status, width, color } = options
  if (!status) return ''
  const mode = status.permissionMode?.trim() || 'default'
  const provider = status.providerId?.trim() || status.providerKind?.trim() || ''
  const model = status.model?.trim() || ''
  const target =
    provider && model
      ? `${provider}/${model}`
      : provider || model || '(no model)'
  const effort = status.effortLevel?.trim() || 'auto'
  const full = [
    valueSegment(mode),
    separatorSegment(),
    valueSegment(target),
    separatorSegment(' · effort '),
    valueSegment(effort),
  ]
  const identityCandidates: FooterSegment[][] = [
    full,
    [
      valueSegment(target),
      separatorSegment(' · effort '),
      valueSegment(effort),
    ],
    [valueSegment(target)],
    [
      valueSegment(mode),
      separatorSegment(),
      valueSegment(effort),
    ],
    [valueSegment(mode)],
  ]
  const usage = status.usage
  const usageSegments = usage
    ? [
        valueSegment(
          `${usage.estimated ? '~' : ''}↓${formatTuiTokenCount(
            usage.inputTokens,
          )} ↑${formatTuiTokenCount(usage.outputTokens)}`,
        ),
      ]
    : []
  const available = Math.max(0, width - 2)
  const usageWidth = footerSegmentsWidth(usageSegments)
  let selected: FooterSegment[] = []
  for (const candidate of identityCandidates) {
    const gap = candidate.length > 0 && usageSegments.length > 0 ? 2 : 0
    if (
      footerSegmentsWidth(candidate) + gap + usageWidth <=
      available
    ) {
      selected = candidate
      break
    }
  }

  if (!usageSegments.length && !selected.length) {
    const clipped = clipTerminalText(target, available)
    selected = clipped ? [valueSegment(clipped)] : []
  }
  const leftWidth = footerSegmentsWidth(selected)
  const gap =
    selected.length > 0 && usageSegments.length > 0
      ? Math.max(2, available - leftWidth - usageWidth)
      : usageSegments.length > 0
        ? Math.max(0, available - usageWidth)
        : 0
  return `  ${renderFooterSegments(selected, color)}${' '.repeat(
    gap,
  )}${renderFooterSegments(usageSegments, color)}`
}

function keySegment(text: string): FooterSegment {
  return { text, tone: 'bold' }
}

function actionSegment(text: string): FooterSegment {
  return { text, tone: 'dim' }
}

function renderShortcutFooter(options: {
  menuOpen: boolean
  mode?: 'idle' | 'running'
  width: number
  color: boolean
}): string {
  const { menuOpen, mode, width, color } = options
  const enterSend = [keySegment('Enter'), actionSegment(' send')]
  const interrupt = [keySegment('Ctrl+C'), actionSegment(' interrupt')]
  const candidates: FooterSegment[][] = menuOpen
    ? [
        [
          keySegment('↑↓'),
          actionSegment(' select'),
          separatorSegment(),
          keySegment('Tab/Enter'),
          actionSegment(' complete'),
          separatorSegment(),
          keySegment('Esc'),
          actionSegment(' close'),
        ],
        [
          keySegment('Tab/Enter'),
          actionSegment(' complete'),
          separatorSegment(),
          keySegment('Esc'),
          actionSegment(' close'),
        ],
        [keySegment('Esc'), actionSegment(' close')],
      ]
    : mode === 'running'
      ? [
          [
            actionSegment('Working'),
            separatorSegment(),
            ...interrupt,
          ],
          interrupt,
          [actionSegment('Working')],
        ]
      : [
          [
            ...enterSend,
            separatorSegment(),
            keySegment('Ctrl+J'),
            actionSegment(' newline'),
            separatorSegment(),
            keySegment('↑↓'),
            actionSegment(' history'),
            separatorSegment(),
            keySegment('Ctrl+C'),
            actionSegment(' exit'),
          ],
          [
            ...enterSend,
            separatorSegment(),
            keySegment('↑↓'),
            actionSegment(' history'),
            separatorSegment(),
            keySegment('Ctrl+C'),
            actionSegment(' exit'),
          ],
          [
            ...enterSend,
            separatorSegment(),
            keySegment('Ctrl+C'),
            actionSegment(' exit'),
          ],
          enterSend,
          [keySegment('Ctrl+C'), actionSegment(' exit')],
        ]
  const available = Math.max(0, width - 2)
  const selected =
    candidates.find(
      (candidate) => footerSegmentsWidth(candidate) <= available,
    ) ?? []
  return `  ${renderFooterSegments(selected, color)}`
}

function formatSlashCandidateLabel(candidate: SlashCommandCandidate): string {
  const usage = candidate.usage ? ` ${candidate.usage}` : ''
  const source =
    candidate.source === 'builtin'
      ? ''
      : ` [${candidate.sourceLabel ?? candidate.source}]`
  return `/${candidate.name}${usage}${source}`
}

function renderSlashMenuRows(options: {
  menu: TuiSlashMenuState
  frameWidth: number
  maxRows: number
  color: boolean
  border: string
  prompt: string
  dim: string
  reset: string
}): string[] {
  const {
    menu,
    frameWidth,
    maxRows,
    color,
    border,
    prompt,
    dim,
    reset,
  } = options
  const rows: string[] = []
  rows.push(
    `${border}${borderLine('├', '┤', frameWidth, `Commands · ${menu.items.length}`)}${reset}`,
  )
  const bodyWidth = Math.max(4, frameWidth - 4)
  if (!menu.items.length) {
    const empty = padTerminalText('  No matching commands', bodyWidth)
    rows.push(
      `${border}│${reset} ${dim}${empty}${reset} ${border}│${reset}`,
    )
    return rows
  }

  const start = Math.max(
    0,
    Math.min(
      menu.selectedIndex - maxRows + 1,
      Math.max(0, menu.items.length - maxRows),
    ),
  )
  const visible = menu.items.slice(start, start + maxRows)
  for (let offset = 0; offset < visible.length; offset++) {
    const index = start + offset
    const candidate = visible[offset]!
    const selected = index === menu.selectedIndex
    const marker = selected ? '❯ ' : '  '
    const available = Math.max(2, bodyWidth - measureTerminalText(marker))
    const label = formatSlashCandidateLabel(candidate)
    let content: string
    if (available < 24) {
      content = clipTerminalText(label, available)
    } else {
      const labelWidth = Math.min(
        Math.max(10, Math.floor(available * 0.42)),
        Math.max(10, available - 10),
      )
      const descriptionWidth = Math.max(0, available - labelWidth - 1)
      content = `${padTerminalText(
        clipTerminalText(label, labelWidth),
        labelWidth,
      )} ${clipTerminalText(candidate.description, descriptionWidth)}`
    }
    const body = padTerminalText(`${marker}${content}`, bodyWidth)
    const selectedStart = color && selected ? '\u001b[7m' : ''
    const selectedEnd = color && selected ? reset : ''
    const tone = selected ? prompt : ''
    rows.push(
      `${border}│${reset} ${selectedStart}${tone}${body}${selectedEnd} ${border}│${reset}`,
    )
  }
  return rows
}

function insertZeroWidthMarker(
  text: string,
  cell: number,
  marker: string,
): string {
  if (!marker) return text
  const target = Math.max(0, Math.floor(cell))
  const output: string[] = []
  let width = 0
  let inserted = false
  for (const grapheme of splitTerminalGraphemes(text)) {
    if (!inserted && width >= target) {
      output.push(marker)
      inserted = true
    }
    output.push(grapheme)
    width += terminalGraphemeWidth(grapheme)
  }
  if (!inserted) output.push(marker)
  return output.join('')
}

export type RenderedTuiInputFooter = {
  text: string
  lines: string[]
}

export function renderTuiInputFooter(options: {
  state: TuiInputState
  columns?: number
  status?: TuiInputStatus
  color?: boolean
  mode?: 'idle' | 'running'
}): RenderedTuiInputFooter {
  const columns = Math.max(24, Math.floor(options.columns ?? 80))
  const frameWidth = resolveTuiDockWidth(columns)
  const color = options.color !== false
  const lines: string[] = []
  const status = renderStatusFooter({
    status: options.status,
    width: frameWidth,
    color,
  })
  if (stripTerminalAnsi(status).trim()) lines.push(status)
  lines.push(
    renderShortcutFooter({
      menuOpen: options.state.slashMenu !== null,
      mode: options.mode,
      width: frameWidth,
      color,
    }),
  )
  return { text: lines.join('\n'), lines }
}

export function renderTuiInputBox(options: {
  state: TuiInputState
  columns?: number
  status?: TuiInputStatus
  color?: boolean
  maxBodyRows?: number
  maxMenuRows?: number
  title?: string
  mode?: 'idle' | 'running'
  includeFooter?: boolean
  cursorMarker?: string
}): RenderedTuiInputBox {
  const columns = Math.max(24, Math.floor(options.columns ?? 80))
  const frameWidth = resolveTuiDockWidth(columns)
  const contentWidth = Math.max(8, frameWidth - 6)
  const maxBodyRows = Math.max(1, options.maxBodyRows ?? 4)
  const wrapped = wrapInputAtCursor(options.state, contentWidth)
  appendInputGhostHint(
    wrapped.lines,
    resolveSlashArgumentHint(options.state),
    contentWidth,
  )
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
    const inputLine = visible[index]!
    const inputText =
      options.cursorMarker && start + index === wrapped.cursorLine
        ? insertZeroWidthMarker(
            inputLine.text,
            wrapped.cursorWidth,
            options.cursorMarker,
          )
        : inputLine.text
    const ghost = inputLine.ghostText
      ? `${dim}${inputLine.ghostText}${reset}`
      : ''
    const body = `${inputText}${ghost}${' '.repeat(
      Math.max(0, contentWidth - inputLine.width),
    )}`
    lines.push(
      `${border}│${reset} ${prompt}${marker}${reset}${body} ${border}│${reset}`,
    )
  }
  if (options.state.slashMenu) {
    lines.push(
      ...renderSlashMenuRows({
        menu: options.state.slashMenu,
        frameWidth,
        maxRows: Math.max(1, options.maxMenuRows ?? 6),
        color,
        border,
        prompt,
        dim,
        reset,
      }),
    )
  }
  lines.push(`${border}${borderLine('╰', '╯', frameWidth)}${reset}`)

  if (options.includeFooter !== false) {
    lines.push(
      ...renderTuiInputFooter({
        state: options.state,
        columns,
        status: options.status,
        color,
        mode: options.mode,
      }).lines,
    )
  }

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
  const frameWidth = resolveTuiDockWidth(options?.columns ?? 80)
  const contentWidth = Math.max(1, frameWidth - 4)
  const lines = wrapTerminalText(prompt.trim(), contentWidth)
  const color = options?.color !== false
  const userStyle = color ? '\u001b[48;5;236m\u001b[38;5;252m' : ''
  const reset = color ? '\u001b[0m' : ''
  return lines
    .map((line, index) => {
      const prefix = index === 0 ? ' ❯ ' : '   '
      const row = `${prefix}${padTerminalText(line, contentWidth)} `
      return `${userStyle}${row}${reset}`
    })
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
