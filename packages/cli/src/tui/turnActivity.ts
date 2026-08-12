/**
 * One-line TTY activity indicator for the silent gaps between session events.
 */

import {
  clipTerminalText,
  measureTerminalText,
} from './terminalText.ts'
import type { TuiAnsiPalette } from './theme.ts'

export type TurnActivityEvent = {
  type: string
  name?: unknown
  phase?: unknown
  message?: unknown
  [key: string]: unknown
}

export type TurnActivityIndicator = {
  start: (label?: string) => void
  beforeEvent: (event: TurnActivityEvent) => void
  afterEvent: (event: TurnActivityEvent) => void
  finishThinkingSegment: () => number | undefined
  finish: (terminalReason?: string) => void
  isActive: () => boolean
  setPalette: (palette: TuiAnsiPalette | undefined) => void
}

const ACTIVITY_GLYPHS = ['✦', '✧', '✶', '✧'] as const

export function formatTurnActivityLine(options: {
  label: string
  elapsedMs: number
  frame: number
  color?: boolean
  columns?: number
  palette?: TuiAnsiPalette
}): string {
  const glyph =
    ACTIVITY_GLYPHS[
      Math.abs(Math.trunc(options.frame)) % ACTIVITY_GLYPHS.length
    ]!
  const seconds = Math.max(0, options.elapsedMs) / 1_000
  const elapsed = seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()
  const variants = [
    `${glyph} ${options.label} · ${elapsed}s · Esc interrupt`,
    `${glyph} ${options.label} · ${elapsed}s · Esc`,
    `${glyph} ${options.label} · ${elapsed}s`,
    `${glyph} ${options.label}`,
  ]
  const maxWidth =
    typeof options.columns === 'number' && Number.isFinite(options.columns)
      ? Math.max(1, Math.floor(options.columns))
      : undefined
  const plain =
    maxWidth == null
      ? variants[0]!
      : (variants.find((line) => measureTerminalText(line) <= maxWidth) ??
        clipTerminalText(variants[variants.length - 1]!, maxWidth))
  const color =
    options.color !== false &&
    (options.palette === undefined || options.palette.accent !== '')
  if (!color) return plain

  const accent = options.palette?.accent ?? '\u001b[38;5;81m'
  const dim = options.palette?.muted ?? '\u001b[2m'
  const reset = '\u001b[0m'
  const body = plain.slice(glyph.length)
  const dimAt = body.indexOf(' ·')
  if (dimAt < 0) return `${accent}${glyph}${reset}${body}`
  return `${accent}${glyph}${reset}${body.slice(0, dimAt)}${dim}${body.slice(dimAt)}${reset}`
}

export function createTurnActivityIndicator(options: {
  writeOut: (text: string) => void
  color?: boolean
  columns?: number | (() => number | undefined)
  now?: () => number
  intervalMs?: number
  renderFrame?: (line: string) => boolean
  clearFrame?: () => boolean
  palette?: TuiAnsiPalette
}): TurnActivityIndicator {
  const now = options.now ?? Date.now
  const intervalMs = Math.max(100, options.intervalMs ?? 250)
  let timer: ReturnType<typeof setInterval> | undefined
  let active = false
  let label = 'Thinking'
  let frame = 0
  let segmentStartedAt: number | undefined
  let segmentKind:
    | 'thinking'
    | 'tool'
    | 'search'
    | 'retry'
    | 'other'
    | undefined
  let activeToolName: string | undefined
  let palette = options.palette

  const erase = () => {
    if (options.clearFrame?.() === true) return
    options.writeOut('\r\u001b[2K')
  }
  const draw = () => {
    if (!active || segmentStartedAt == null) return
    const line = formatTurnActivityLine({
      label,
      elapsedMs: now() - segmentStartedAt,
      frame,
      color: options.color,
      palette,
      columns:
        typeof options.columns === 'function'
          ? options.columns()
          : options.columns,
    })
    if (options.renderFrame?.(line) !== true) {
      // One write avoids the visible blank frame produced by erase-then-draw.
      options.writeOut(`\r${line}\u001b[K`)
    }
    frame++
  }
  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const clear = () => {
    stopTimer()
    if (active) erase()
    active = false
  }
  const startSegment = (
    nextLabel: string,
    nextKind: NonNullable<typeof segmentKind>,
  ) => {
    stopTimer()
    label = nextLabel
    if (segmentStartedAt == null || segmentKind !== nextKind) {
      segmentStartedAt = now()
      segmentKind = nextKind
      frame = 0
    }
    active = true
    draw()
    timer = setInterval(draw, intervalMs)
    timer.unref?.()
  }
  const start = (nextLabel = 'Thinking') => {
    const nextKind =
      nextLabel === 'Thinking'
        ? 'thinking'
        : nextLabel.startsWith('Running')
          ? 'tool'
          : nextLabel.startsWith('Searching')
            ? 'search'
            : nextLabel.startsWith('Retrying')
              ? 'retry'
              : 'other'
    startSegment(nextLabel, nextKind)
  }
  const finishThinkingSegment = (): number | undefined => {
    if (segmentKind !== 'thinking' || segmentStartedAt == null) {
      return undefined
    }
    const elapsedMs = Math.max(0, now() - segmentStartedAt)
    clear()
    segmentStartedAt = undefined
    segmentKind = undefined
    frame = 0
    return elapsedMs
  }

  return {
    start,
    beforeEvent() {
      clear()
    },
    afterEvent(event) {
      const name = typeof event.name === 'string' ? event.name : ''
      if (event.type === 'reasoning') {
        startSegment('Thinking', 'thinking')
      } else if (event.type === 'tool_start') {
        activeToolName = name || undefined
        startSegment(name ? `Running ${name}` : 'Running tool', 'tool')
      } else if (event.type === 'tool_progress') {
        if (name) activeToolName = name
        const message =
          typeof event.message === 'string' ? event.message.trim() : ''
        const toolName = name || activeToolName
        startSegment(
          message
            ? `${toolName ? `${toolName} · ` : ''}${message}`
            : toolName
              ? `Running ${toolName}`
              : 'Running tool',
          'tool',
        )
      } else if (event.type === 'tool_end') {
        activeToolName = undefined
        startSegment('Thinking', 'thinking')
      } else if (event.type === 'phase' && event.phase === 'running') {
        startSegment(
          activeToolName ? `Running ${activeToolName}` : 'Thinking',
          activeToolName ? 'tool' : 'thinking',
        )
      } else if (event.type === 'web_search') {
        startSegment(
          event.phase === 'query' ? 'Searching the web' : 'Thinking',
          event.phase === 'query' ? 'search' : 'thinking',
        )
      } else if (event.type === 'model_retry') {
        startSegment('Retrying model request', 'retry')
      } else if (event.type === 'warning') {
        startSegment(
          activeToolName ? `Running ${activeToolName}` : 'Thinking',
          activeToolName ? 'tool' : 'thinking',
        )
      }
    },
    finishThinkingSegment,
    finish() {
      clear()
      segmentStartedAt = undefined
      segmentKind = undefined
      frame = 0
      activeToolName = undefined
    },
    isActive() {
      return active
    },
    setPalette(nextPalette) {
      palette = nextPalette
      if (active) draw()
    },
  }
}
