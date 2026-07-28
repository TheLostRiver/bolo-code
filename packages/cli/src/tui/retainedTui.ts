import path from 'node:path'
import {
  Container,
  TUI,
  type Component,
} from '@earendil-works/pi-tui/dist/tui.js'
import { Text } from '@earendil-works/pi-tui/dist/components/text.js'
import { getBoloHomeDir } from '../../../config/src/paths.ts'
import {
  createCliTuiViewState,
  projectCliTuiSessionEvent,
  reduceCliTuiViewState,
  type ChatMessage,
  type CliTuiSessionEvent,
  type CliTuiViewAction,
  type CliTuiViewState,
} from '../../../shared/src/index.ts'
import {
  type CliSessionEvent,
  type SessionEventPrinter,
} from './formatSessionEvent.ts'
import {
  createBoloTerminalAdapter,
  type BoloTerminalAdapter,
  type BoloTerminalOutput,
  type BoloTerminalStats,
} from './boloTerminalAdapter.ts'
import {
  renderInkLayout,
  type InkLayoutOptions,
} from './inkLayout.ts'

export type RetainedWelcomeOptions = Omit<
  InkLayoutOptions,
  'columns' | 'env'
>

export type CliTuiController = {
  readonly root: Component
  readonly printer: SessionEventPrinter
  configureWelcome(options: RetainedWelcomeOptions): void
  setWelcomeVisible(visible: boolean): void
  restoreMessages(messages: readonly ChatMessage[]): void
  getState(): CliTuiViewState
  start(): Promise<void>
  stop(): Promise<void>
  flush(): Promise<void>
  suspendForLegacyPanel(): Promise<void>
  resumeFromLegacyPanel(): Promise<void>
  isSuspended(): boolean
  writeOutput(text: string): void
  writeError(text: string): void
  getRenderEpoch(): number
  waitForRender(afterEpoch: number, timeoutMs?: number): Promise<void>
  getTerminalStats(): BoloTerminalStats
}

type RevisionWaiter = {
  revision: number
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class WelcomeComponent implements Component {
  private options: RetainedWelcomeOptions = {
    version: '0.0.1',
    headline: 'Welcome to Bolo Code',
  }
  private visible = true

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  configure(options: RetainedWelcomeOptions): void {
    this.options = { ...options }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.visible) return []
    return renderInkLayout({
      ...this.options,
      columns: width,
      env: this.env,
    }).split(/\r?\n/gu)
  }
}

class RetainedRoot extends Container {
  private readonly welcome: WelcomeComponent
  private readonly status = new Text('', 1, 0)
  private readonly compatibilityOutput = new Text('', 1, 0)
  private state = createCliTuiViewState()
  private outputText = ''
  private visible = true
  private revision = 0
  private renderedRevision = -1
  private readonly waiters = new Set<RevisionWaiter>()

  constructor(env: NodeJS.ProcessEnv) {
    super()
    this.welcome = new WelcomeComponent(env)
    this.addChild(this.welcome)
    this.addChild(this.status)
    this.addChild(this.compatibilityOutput)
    this.refreshStatus()
    this.markDirty()
  }

  configureWelcome(options: RetainedWelcomeOptions): void {
    this.welcome.configure(options)
    this.markDirty()
  }

  setWelcomeVisible(visible: boolean): void {
    this.welcome.setVisible(visible)
    this.markDirty()
  }

  setState(state: CliTuiViewState): void {
    this.state = state
    this.refreshStatus()
    this.markDirty()
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.markDirty()
  }

  appendCompatibilityOutput(text: string): void {
    if (!text) return
    this.outputText = `${this.outputText}${text}`.slice(-65_536)
    this.compatibilityOutput.setText(this.outputText.trimEnd())
    this.markDirty()
  }

  currentRevision(): number {
    return this.revision
  }

  waitForRevision(revision: number, timeoutMs = 1_000): Promise<void> {
    if (this.renderedRevision >= revision) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: RevisionWaiter = {
        revision,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(
            new Error(
              `retained root did not render revision ${revision}`,
            ),
          )
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  close(): void {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.reject(new Error('retained root stopped before render completed'))
    }
  }

  override render(width: number): string[] {
    const lines = this.visible ? super.render(width) : []
    this.renderedRevision = this.revision
    for (const waiter of [...this.waiters]) {
      if (this.renderedRevision < waiter.revision) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve()
    }
    return lines
  }

  private refreshStatus(): void {
    const turnLabel =
      this.state.turns.length === 1
        ? '1 turn'
        : `${this.state.turns.length} turns`
    this.status.setText(
      `Bolo · ${this.state.phase} · ${turnLabel}`,
    )
  }

  private markDirty(): void {
    this.revision += 1
    this.invalidate()
  }
}

function shouldShowThinking(
  option: boolean | (() => boolean) | undefined,
): boolean {
  if (typeof option === 'function') return option() !== false
  return option !== false
}

export function createRetainedTuiController(options: {
  writeOut: (text: string) => void
  writeErr?: (text: string) => void
  output: BoloTerminalOutput
  env?: NodeJS.ProcessEnv
  fallbackColumns?: number
  fallbackRows?: number
  showThinking?: boolean | (() => boolean)
  explainError?: (message: string) => string
}): CliTuiController {
  const env = options.env ?? process.env
  const adapter: BoloTerminalAdapter = createBoloTerminalAdapter({
    writeOut: options.writeOut,
    output: options.output,
    fallbackColumns: options.fallbackColumns,
    fallbackRows: options.fallbackRows,
  })
  const root = new RetainedRoot(env)
  const tui = new TUI(
    adapter,
    false,
    path.join(getBoloHomeDir(), 'logs', 'tui'),
  )
  tui.setClearOnShrink(false)
  tui.addChild(root)

  let state = createCliTuiViewState()
  let started = false
  let stopped = false
  let suspended = false

  const requestRender = (): void => {
    if (started && !stopped && !suspended) tui.requestRender()
  }

  const apply = (action: CliTuiViewAction): void => {
    state = reduceCliTuiViewState(state, action)
    root.setState(state)
    requestRender()
  }

  const printer: SessionEventPrinter = {
    beginTurn(turnOptions) {
      apply({
        type: 'begin_turn',
        ...(turnOptions?.prompt !== undefined
          ? { prompt: turnOptions.prompt }
          : {}),
        ...(turnOptions?.echoUser !== undefined
          ? { echoUser: turnOptions.echoUser }
          : {}),
      })
    },
    onEvent(event: CliSessionEvent) {
      if (
        (event.type === 'reasoning' || event.type === 'reasoning_end') &&
        !shouldShowThinking(options.showThinking)
      ) {
        return
      }
      const projected =
        event.type === 'error' &&
        typeof event.message === 'string' &&
        options.explainError
          ? {
              ...event,
              message: options.explainError(event.message),
            }
          : event
      const next = reduceCliTuiViewState(
        state,
        projectCliTuiSessionEvent(
          projected as CliTuiSessionEvent,
        ),
      ) as CliTuiViewState | undefined
      if (!next) return
      state = next
      root.setState(state)
      requestRender()
    },
    endTurn(endOptions) {
      apply({
        type: 'end_turn',
        terminal: {
          reason: endOptions?.terminalReason ?? 'completed',
        },
      })
    },
    didStreamText() {
      // OI-14D will render streaming transcript blocks. Until then the
      // caller must still emit the completed assistant fallback.
      return false
    },
  }

  const flush = async (): Promise<void> => {
    if (!started || stopped || suspended) return
    const revision = root.currentRevision()
    tui.requestRender()
    await root.waitForRevision(revision)
  }

  const controller: CliTuiController = {
    root,
    printer,
    configureWelcome(welcomeOptions) {
      root.configureWelcome(welcomeOptions)
      requestRender()
    },
    setWelcomeVisible(visible) {
      root.setWelcomeVisible(visible)
      requestRender()
    },
    restoreMessages(messages) {
      apply({ type: 'restore_messages', messages })
    },
    getState() {
      return state
    },
    async start() {
      if (started || stopped) return
      started = true
      tui.start()
      await flush()
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (suspended) {
        suspended = false
        adapter.setExternalOwner(false)
      }
      if (started) tui.stop()
      root.close()
    },
    flush,
    async suspendForLegacyPanel() {
      if (!started || stopped || suspended) return
      root.setVisible(false)
      const revision = root.currentRevision()
      tui.requestRender()
      await root.waitForRevision(revision)
      adapter.setExternalOwner(true)
      suspended = true
    },
    async resumeFromLegacyPanel() {
      if (!started || stopped || !suspended) return
      adapter.setExternalOwner(false)
      suspended = false
      root.setVisible(true)
      const revision = root.currentRevision()
      tui.requestRender(true)
      await root.waitForRevision(revision)
    },
    isSuspended() {
      return suspended
    },
    writeOutput(text) {
      if (suspended) {
        adapter.writeExternal(text)
        return
      }
      root.appendCompatibilityOutput(text)
      requestRender()
    },
    writeError(text) {
      controller.writeOutput(text)
    },
    getRenderEpoch() {
      return adapter.renderEpoch
    },
    waitForRender(afterEpoch, timeoutMs) {
      return adapter.waitForRender(afterEpoch, timeoutMs)
    },
    getTerminalStats() {
      return adapter.getStats()
    },
  }

  return controller
}
