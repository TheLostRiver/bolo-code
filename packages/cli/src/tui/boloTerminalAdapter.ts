import type { Terminal } from '@earendil-works/pi-tui/dist/terminal.js'
import { StdinBuffer } from '@earendil-works/pi-tui/dist/stdin-buffer.js'

export type BoloTerminalInput = {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
  on: (
    event: 'data',
    listener: (data: string | Buffer) => void,
  ) => unknown
  removeListener: (
    event: 'data',
    listener: (data: string | Buffer) => void,
  ) => unknown
  resume: () => unknown
  pause: () => unknown
}

export type BoloTerminalOutput = {
  columns?: number
  rows?: number
  on?: (event: 'resize', listener: () => void) => unknown
  removeListener?: (event: 'resize', listener: () => void) => unknown
}

export type BoloTerminalStats = {
  writes: number
  externalWrites: number
  inputEvents: number
  pasteTransactions: number
  filteredScrollbackClears: number
  concurrentWriteViolations: number
}

export type BoloTerminalAdapter = Terminal & {
  readonly renderEpoch: number
  getStats(): BoloTerminalStats
  setExternalOwner(active: boolean): void
  setInputEnabled(active: boolean): void
  isInputEnabled(): boolean
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
const BRACKETED_PASTE_ENABLE = '\u001b[?2004h'
const BRACKETED_PASTE_DISABLE = '\u001b[?2004l'
const BRACKETED_PASTE_START = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'

function positiveDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

function safeTitle(title: string): string {
  return title.replace(/[\u0007\u001b]/gu, '')
}

export function createBoloTerminalAdapter(options: {
  writeOut: (data: string) => void
  input?: BoloTerminalInput
  output: BoloTerminalOutput
  fallbackColumns?: number
  fallbackRows?: number
}): BoloTerminalAdapter {
  let resizeHandler: (() => void) | undefined
  let inputHandler: ((data: string) => void) | undefined
  let inputDataHandler: ((data: string | Buffer) => void) | undefined
  let inputBuffer: StdinBuffer | undefined
  let started = false
  let externalOwner = false
  let inputRequested = false
  let inputActive = false
  let inputWasRaw = false
  let renderEpoch = 0
  const waiters = new Set<RenderWaiter>()
  const stats: BoloTerminalStats = {
    writes: 0,
    externalWrites: 0,
    inputEvents: 0,
    pasteTransactions: 0,
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

  const releaseInput = () => {
    if (!inputActive) return
    inputActive = false
    const input = options.input
    if (input && inputDataHandler) {
      input.removeListener('data', inputDataHandler)
    }
    inputDataHandler = undefined
    inputBuffer?.destroy()
    inputBuffer = undefined
    emitRetained(BRACKETED_PASTE_DISABLE)
    if (input && !inputWasRaw) input.setRawMode?.(false)
    input?.pause()
  }

  const acquireInput = () => {
    if (
      inputActive ||
      !inputRequested ||
      !started ||
      externalOwner ||
      !inputHandler
    ) {
      return
    }
    const input = options.input
    if (
      !input ||
      input.isTTY !== true ||
      typeof input.setRawMode !== 'function'
    ) {
      throw new Error('retained Composer input requires a raw-mode TTY')
    }

    const buffer = new StdinBuffer()
    buffer.on('data', (data) => {
      if (!inputActive || externalOwner || !inputHandler) return
      stats.inputEvents += 1
      inputHandler(data)
    })
    buffer.on('paste', (data) => {
      if (!inputActive || externalOwner || !inputHandler) return
      stats.pasteTransactions += 1
      inputHandler(`${BRACKETED_PASTE_START}${data}${BRACKETED_PASTE_END}`)
    })
    const dataHandler = (data: string | Buffer) => buffer.process(data)
    const wasRaw = input.isRaw === true
    let listenerAttached = false
    let rawModeAttempted = false
    let pasteEnabled = false
    try {
      input.on('data', dataHandler)
      listenerAttached = true
      rawModeAttempted = true
      input.setRawMode(true)
      inputBuffer = buffer
      inputDataHandler = dataHandler
      inputWasRaw = wasRaw
      inputActive = true
      emitRetained(BRACKETED_PASTE_ENABLE)
      pasteEnabled = true
      input.resume()
    } catch (error) {
      inputActive = false
      if (listenerAttached) {
        try {
          input.removeListener('data', dataHandler)
        } catch {
          /* preserve the acquisition error */
        }
      }
      buffer.destroy()
      inputBuffer = undefined
      inputDataHandler = undefined
      if (pasteEnabled) {
        try {
          emitRetained(BRACKETED_PASTE_DISABLE)
        } catch {
          /* preserve the acquisition error */
        }
      }
      if (rawModeAttempted && !wasRaw) {
        try {
          input.setRawMode(false)
        } catch {
          /* preserve the acquisition error */
        }
      }
      try {
        input.pause()
      } catch {
        /* preserve the acquisition error */
      }
      throw error
    }
  }

  const stop = () => {
    inputRequested = false
    releaseInput()
    if (started && resizeHandler) {
      options.output.removeListener?.('resize', resizeHandler)
    }
    started = false
    resizeHandler = undefined
    inputHandler = undefined
    externalOwner = false
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.reject(new Error('retained terminal stopped before render completed'))
    }
  }

  const adapter: BoloTerminalAdapter = {
    start(onInput, onResize) {
      if (started) return
      started = true
      inputHandler = onInput
      resizeHandler = () => {
        if (!externalOwner) onResize()
      }
      options.output.on?.('resize', resizeHandler)
      acquireInput()
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
      if (active) releaseInput()
      externalOwner = active
      if (!active) acquireInput()
    },
    setInputEnabled(active) {
      inputRequested = active
      if (active) acquireInput()
      else releaseInput()
    },
    isInputEnabled() {
      return inputActive
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
