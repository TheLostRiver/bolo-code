import { StdinBuffer, type Terminal } from './piCompat.ts'
import { runCleanupSteps } from '../cleanup.ts'
import {
  SGR_MOUSE_DISABLE,
  SGR_MOUSE_ENABLE,
  DA2_QUERY,
  createDefaultTerminalCapabilities,
  isDa2Response,
  parseDa2Response,
  resolveTerminalCapabilities,
  type TerminalCapabilities,
} from '../../../shared/src/index.ts'

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
  inputEvents: number
  pasteTransactions: number
  filteredScrollbackClears: number
}

export type BoloTerminalAdapter = Terminal & {
  readonly renderEpoch: number
  getStats(): BoloTerminalStats
  setInputEnabled(active: boolean): void
  isInputEnabled(): boolean
  waitForRender(afterEpoch: number, timeoutMs?: number): Promise<void>
  /** TERM-1：终端能力探测结果（DA2 响应优先，env 回退，超时保守默认） */
  getTerminalCapabilities(): TerminalCapabilities
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
  env?: NodeJS.ProcessEnv
}): BoloTerminalAdapter {
  let resizeHandler: (() => void) | undefined
  let inputHandler: ((data: string) => void) | undefined
  let inputDataHandler: ((data: string | Buffer) => void) | undefined
  let inputBuffer: StdinBuffer | undefined
  let started = false
  let inputRequested = false
  let inputActive = false
  let inputWasRaw = false
  let mouseReportingEnabled = false
  let renderEpoch = 0
  // TERM-1：探测结果与超时兜底 timer
  let terminalCapabilities: TerminalCapabilities =
    createDefaultTerminalCapabilities()
  let da2Timer: ReturnType<typeof setTimeout> | undefined
  const waiters = new Set<RenderWaiter>()
  const stats: BoloTerminalStats = {
    writes: 0,
    inputEvents: 0,
    pasteTransactions: 0,
    filteredScrollbackClears: 0,
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
    const dataHandler = inputDataHandler
    const buffer = inputBuffer
    inputDataHandler = undefined
    inputBuffer = undefined
    runCleanupSteps([
      () => {
        if (input && dataHandler) input.removeListener('data', dataHandler)
      },
      () => {
        if (da2Timer) {
          clearTimeout(da2Timer)
          da2Timer = undefined
        }
      },
      () => buffer?.destroy(),
      () => emitRetained(BRACKETED_PASTE_DISABLE),
      () => {
        if (mouseReportingEnabled) {
          mouseReportingEnabled = false
          emitRetained(SGR_MOUSE_DISABLE)
        }
      },
      () => {
        if (input && !inputWasRaw) input.setRawMode?.(false)
      },
      () => input?.pause(),
    ])
  }

  const acquireInput = () => {
    if (
      inputActive ||
      !inputRequested ||
      !started ||
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
      if (!inputActive || !inputHandler) return
      // TERM-1：DA2 响应在 adapter 层拦截，不进输入处理
      if (isDa2Response(data)) {
        terminalCapabilities = resolveTerminalCapabilities(
          parseDa2Response(data),
          options.env ?? {},
        )
        if (da2Timer) {
          clearTimeout(da2Timer)
          da2Timer = undefined
        }
        return
      }
      stats.inputEvents += 1
      inputHandler(data)
    })
    buffer.on('paste', (data) => {
      if (!inputActive || !inputHandler) return
      stats.pasteTransactions += 1
      inputHandler(`${BRACKETED_PASTE_START}${data}${BRACKETED_PASTE_END}`)
    })
    const dataHandler = (data: string | Buffer) => buffer.process(data)
    const wasRaw = input.isRaw === true
    let listenerAttached = false
    let rawModeAttempted = false
    let pasteEnabled = false
    try {
      listenerAttached = true
      input.on('data', dataHandler)
      rawModeAttempted = true
      input.setRawMode(true)
      inputBuffer = buffer
      inputDataHandler = dataHandler
      inputWasRaw = wasRaw
      inputActive = true
      pasteEnabled = true
      emitRetained(BRACKETED_PASTE_ENABLE)
      if (options.env?.TERM !== 'dumb') {
        mouseReportingEnabled = true
        emitRetained(SGR_MOUSE_ENABLE)
      }
      // TERM-1：非阻塞 DA2 查询；dumb/能力不足不发查询，走保守默认。
      // 超时后 env 回退，迟到响应仍会被拦截更新
      if (options.env?.TERM !== 'dumb') {
        terminalCapabilities = resolveTerminalCapabilities(
          undefined,
          options.env ?? {},
        )
        emitRetained(DA2_QUERY)
        da2Timer = setTimeout(() => {
          da2Timer = undefined
          // 超时：保持 env 推断（不覆盖迟到响应——响应到达时会更新）
        }, 300)
      }
      input.resume()
    } catch (error) {
      inputActive = false
      inputBuffer = undefined
      inputDataHandler = undefined
      try {
        runCleanupSteps([
          () => {
            if (da2Timer) {
              clearTimeout(da2Timer)
              da2Timer = undefined
            }
          },
          () => {
            if (listenerAttached) input.removeListener('data', dataHandler)
          },
          () => buffer.destroy(),
          () => {
            if (pasteEnabled) emitRetained(BRACKETED_PASTE_DISABLE)
          },
          () => {
            if (mouseReportingEnabled) {
              mouseReportingEnabled = false
              emitRetained(SGR_MOUSE_DISABLE)
            }
          },
          () => {
            if (rawModeAttempted && !wasRaw) input.setRawMode?.(false)
          },
          () => input.pause(),
        ])
      } catch {
        /* preserve the acquisition error */
      }
      throw error
    }
  }

  const stop = () => {
    inputRequested = false
    const activeResizeHandler = resizeHandler
    const pendingWaiters = [...waiters]
    const stoppedError = new Error(
      'retained terminal stopped before render completed',
    )
    runCleanupSteps([
      releaseInput,
      () => {
        if (started && activeResizeHandler) {
          options.output.removeListener?.('resize', activeResizeHandler)
        }
      },
      () => {
        started = false
        resizeHandler = undefined
        inputHandler = undefined
      },
      ...pendingWaiters.map((waiter) => () => {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        waiter.reject(stoppedError)
      }),
    ])
  }

  const adapter: BoloTerminalAdapter = {
    start(onInput, onResize) {
      if (started) return
      started = true
      inputHandler = onInput
      resizeHandler = onResize
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
    setInputEnabled(active) {
      inputRequested = active
      if (active) acquireInput()
      else releaseInput()
    },
    isInputEnabled() {
      return inputActive
    },
    getTerminalCapabilities() {
      return { ...terminalCapabilities }
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
