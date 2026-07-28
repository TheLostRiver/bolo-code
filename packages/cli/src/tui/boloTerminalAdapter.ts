import type { Terminal } from '@earendil-works/pi-tui/dist/terminal.js'

export type BoloTerminalOutput = {
  columns?: number
  rows?: number
  on?: (event: 'resize', listener: () => void) => unknown
  removeListener?: (event: 'resize', listener: () => void) => unknown
}

export type BoloTerminalStats = {
  writes: number
  externalWrites: number
  filteredScrollbackClears: number
  concurrentWriteViolations: number
}

export type BoloTerminalAdapter = Terminal & {
  readonly renderEpoch: number
  getStats(): BoloTerminalStats
  setExternalOwner(active: boolean): void
  writeExternal(data: string): void
  waitForRender(afterEpoch: number, timeoutMs?: number): Promise<void>
}

type RenderWaiter = {
  afterEpoch: number
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CLEAR_SCROLLBACK = '\u001b[3J'
const SYNC_END = '\u001b[?2026l'

function positiveDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

function safeTitle(title: string): string {
  return title.replace(/[\u0007\u001b]/gu, '')
}

export function createBoloTerminalAdapter(options: {
  writeOut: (data: string) => void
  output: BoloTerminalOutput
  fallbackColumns?: number
  fallbackRows?: number
}): BoloTerminalAdapter {
  let resizeHandler: (() => void) | undefined
  let started = false
  let externalOwner = false
  let renderEpoch = 0
  const waiters = new Set<RenderWaiter>()
  const stats: BoloTerminalStats = {
    writes: 0,
    externalWrites: 0,
    filteredScrollbackClears: 0,
    concurrentWriteViolations: 0,
  }

  const settleRenderWaiters = () => {
    for (const waiter of [...waiters]) {
      if (renderEpoch <= waiter.afterEpoch) continue
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve()
    }
  }

  const sanitize = (data: string): string => {
    if (!data.includes(CLEAR_SCROLLBACK)) return data
    const matches = data.match(/\u001b\[3J/gu)
    stats.filteredScrollbackClears += matches?.length ?? 0
    return data.replaceAll(CLEAR_SCROLLBACK, '')
  }

  const emitRetained = (data: string): void => {
    if (!data) return
    if (externalOwner) {
      stats.concurrentWriteViolations += 1
      return
    }
    const safe = sanitize(data)
    if (!safe) return
    stats.writes += 1
    options.writeOut(safe)
    if (safe.includes(SYNC_END)) {
      renderEpoch += 1
      settleRenderWaiters()
    }
  }

  const stop = () => {
    if (started && resizeHandler) {
      options.output.removeListener?.('resize', resizeHandler)
    }
    started = false
    resizeHandler = undefined
    externalOwner = false
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.reject(new Error('retained terminal stopped before render completed'))
    }
  }

  const adapter: BoloTerminalAdapter = {
    start(_onInput, onResize) {
      if (started) return
      started = true
      resizeHandler = () => {
        if (!externalOwner) onResize()
      }
      options.output.on?.('resize', resizeHandler)
    },
    stop,
    async drainInput() {},
    write: emitRetained,
    get columns() {
      return positiveDimension(
        options.output.columns,
        options.fallbackColumns ?? 80,
      )
    },
    get rows() {
      return positiveDimension(options.output.rows, options.fallbackRows ?? 24)
    },
    get kittyProtocolActive() {
      return false
    },
    moveBy(lines) {
      if (lines > 0) emitRetained(`\u001b[${lines}B`)
      else if (lines < 0) emitRetained(`\u001b[${-lines}A`)
    },
    hideCursor() {
      emitRetained('\u001b[?25l')
    },
    showCursor() {
      emitRetained('\u001b[?25h')
    },
    clearLine() {
      emitRetained('\u001b[K')
    },
    clearFromCursor() {
      emitRetained('\u001b[J')
    },
    clearScreen() {
      emitRetained('\u001b[2J\u001b[H')
    },
    setTitle(title) {
      emitRetained(`\u001b]0;${safeTitle(title)}\u0007`)
    },
    setProgress(active) {
      emitRetained(active ? '\u001b]9;4;3\u0007' : '\u001b]9;4;0\u0007')
    },
    get renderEpoch() {
      return renderEpoch
    },
    getStats() {
      return { ...stats }
    },
    setExternalOwner(active) {
      externalOwner = active
    },
    writeExternal(data) {
      if (!data) return
      if (!externalOwner) stats.concurrentWriteViolations += 1
      const safe = sanitize(data)
      if (!safe) return
      stats.externalWrites += 1
      options.writeOut(safe)
    },
    waitForRender(afterEpoch, timeoutMs = 1_000) {
      if (renderEpoch > afterEpoch) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const waiter: RenderWaiter = {
          afterEpoch,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(
              new Error(
                `retained render did not complete after epoch ${afterEpoch}`,
              ),
            )
          }, timeoutMs),
        }
        waiters.add(waiter)
      })
    },
  }

  return adapter
}
