/**
 * One-line TTY activity indicator for the silent gaps between session events.
 */

import {
  clipTerminalText,
  measureTerminalText,
} from './terminalText.ts'

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
  finish: (terminalReason?: string) => void
  isActive: () => boolean
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function formatTurnActivityLine(options: {
  label: string
  elapsedMs: number
  frame: number
  color?: boolean
  columns?: number
}): string {
  const spinner = SPINNER[Math.abs(options.frame) % SPINNER.length]!
  const seconds = Math.max(0, options.elapsedMs) / 1_000
  const elapsed = seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()
  const variants = [
    `${spinner} ${options.label} · ${elapsed}s · Ctrl+C interrupt`,
    `${spinner} ${options.label} · ${elapsed}s · ^C`,
    `${spinner} ${options.label} · ${elapsed}s`,
    `${spinner} ${options.label}`,
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
  const color = options.color !== false
  if (!color) return plain

  const accent = color ? '\u001b[38;5;81m' : ''
  const dim = color ? '\u001b[2m' : ''
  const reset = color ? '\u001b[0m' : ''
  const body = plain.slice(spinner.length)
  const dimAt = body.indexOf(' ·')
  if (dimAt < 0) return `${accent}${spinner}${reset}${body}`
  return `${accent}${spinner}${reset}${body.slice(0, dimAt)}${dim}${body.slice(dimAt)}${reset}`
}

export function createTurnActivityIndicator(options: {
  writeOut: (text: string) => void
  color?: boolean
  columns?: number | (() => number | undefined)
  now?: () => number
  intervalMs?: number
  showCompletion?: boolean
}): TurnActivityIndicator {
  const now = options.now ?? Date.now
  const intervalMs = Math.max(60, options.intervalMs ?? 90)
  let timer: ReturnType<typeof setInterval> | undefined
  let active = false
  let label = 'Thinking'
  let frame = 0
  let turnStartedAt: number | undefined
  let activeToolName: string | undefined

  const erase = () => options.writeOut('\r\u001b[2K')
  const draw = () => {
    if (!active || turnStartedAt == null) return
    erase()
    options.writeOut(
      formatTurnActivityLine({
        label,
        elapsedMs: now() - turnStartedAt,
        frame,
        color: options.color,
        columns:
          typeof options.columns === 'function'
            ? options.columns()
            : options.columns,
      }),
    )
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
  const start = (nextLabel = 'Thinking') => {
    clear()
    label = nextLabel
    if (turnStartedAt == null) turnStartedAt = now()
    active = true
    draw()
    timer = setInterval(draw, intervalMs)
    timer.unref?.()
  }

  return {
    start,
    beforeEvent() {
      clear()
    },
    afterEvent(event) {
      const name = typeof event.name === 'string' ? event.name : ''
      if (event.type === 'tool_start') {
        activeToolName = name || undefined
        start(name ? `Running ${name}` : 'Running tool')
      } else if (event.type === 'tool_progress') {
        if (name) activeToolName = name
        const message =
          typeof event.message === 'string' ? event.message.trim() : ''
        start(message || (name ? `Running ${name}` : 'Running tool'))
      } else if (event.type === 'tool_end') {
        activeToolName = undefined
        start('Thinking')
      } else if (event.type === 'phase' && event.phase === 'running') {
        start(activeToolName ? `Running ${activeToolName}` : 'Thinking')
      } else if (event.type === 'web_search') {
        start(event.phase === 'query' ? 'Searching the web' : 'Thinking')
      } else if (event.type === 'model_retry') {
        start('Retrying model request')
      } else if (event.type === 'warning') {
        start(activeToolName ? `Running ${activeToolName}` : 'Thinking')
      }
    },
    finish(terminalReason = 'completed') {
      clear()
      if (
        turnStartedAt != null &&
        options.showCompletion !== false &&
        terminalReason === 'completed'
      ) {
        const elapsedMs = now() - turnStartedAt
        const seconds =
          elapsedMs < 10_000
            ? `${(elapsedMs / 1_000).toFixed(1)}s`
            : `${Math.round(elapsedMs / 1_000)}s`
        const dim = options.color === false ? '' : '\u001b[2m'
        const reset = options.color === false ? '' : '\u001b[0m'
        options.writeOut(`${dim}Done · ${seconds}${reset}\n`)
      }
      turnStartedAt = undefined
      frame = 0
      activeToolName = undefined
    },
    isActive() {
      return active
    },
  }
}
