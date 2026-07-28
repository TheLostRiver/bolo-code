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
  type BoloTerminalInput,
  type BoloTerminalAdapter,
  type BoloTerminalOutput,
  type BoloTerminalStats,
} from './boloTerminalAdapter.ts'
import type { ReadTuiInputResult } from './inputBox.ts'
import {
  renderInkLayout,
  type InkLayoutOptions,
} from './inkLayout.ts'
import { RetainedActivity } from './retainedActivity.ts'
import {
  RetainedComposer,
  RetainedComposerFooter,
  type RetainedComposerConfig,
} from './retainedComposer.ts'
import {
  RetainedTranscript,
} from './retainedTranscript.ts'
import { resolveTuiContentGutter } from './contentLayout.ts'
import { createTurnActivityIndicator } from './turnActivity.ts'

export type RetainedWelcomeOptions = Omit<
  InkLayoutOptions,
  'columns' | 'env'
>

export type CliTuiController = {
  readonly root: Component
  readonly composer: RetainedComposer
  readonly printer: SessionEventPrinter
  configureWelcome(options: RetainedWelcomeOptions): void
  setWelcomeVisible(visible: boolean): void
  configureComposer(options: RetainedComposerConfig): void
  readInput(options?: { signal?: AbortSignal }): Promise<ReadTuiInputResult>
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
  private readonly transcript: RetainedTranscript
  private readonly activity: RetainedActivity
  private readonly composer: RetainedComposer
  private readonly footer: RetainedComposerFooter
  private readonly compatibilityOutput = new Text('', 1, 0)
  private outputText = ''
  private visible = true
  private revision = 0
  private renderedRevision = -1
  private readonly waiters = new Set<RevisionWaiter>()

  constructor(
    env: NodeJS.ProcessEnv,
    composer: RetainedComposer,
    activity: RetainedActivity,
    color: boolean,
  ) {
    super()
    this.welcome = new WelcomeComponent(env)
    this.transcript = new RetainedTranscript({ env })
    this.activity = activity
    this.composer = composer
    this.footer = new RetainedComposerFooter(
      composer,
      color,
    )
    this.addChild(this.welcome)
    this.addChild(this.transcript)
    this.addChild(this.compatibilityOutput)
    this.addChild(this.activity)
    this.addChild(this.composer)
    this.addChild(this.footer)
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
    this.transcript.setState(state)
    this.composer.setMode(state.composer.mode)
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

  childChanged(): void {
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
    const lines: string[] = []
    if (this.visible) {
      const append = (section: string[], gap: number): void => {
        if (!section.length) return
        if (lines.length && gap > 0) {
          lines.push(...Array.from({ length: gap }, () => ''))
        }
        lines.push(...section)
      }
      append(this.welcome.render(width), 0)
      append(this.transcript.render(width), 1)
      append(this.compatibilityOutput.render(width), 1)
      append(this.activity.render(width), 1)
      append(this.composer.render(width), 1)
      append(this.footer.render(width), 0)
    }
    this.renderedRevision = this.revision
    for (const waiter of [...this.waiters]) {
      if (this.renderedRevision < waiter.revision) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve()
    }
    return lines
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
  input?: BoloTerminalInput
  output: BoloTerminalOutput
  env?: NodeJS.ProcessEnv
  fallbackColumns?: number
  fallbackRows?: number
  color?: boolean
  showThinking?: boolean | (() => boolean)
  explainError?: (message: string) => string
  now?: () => number
  activityIntervalMs?: number
}): CliTuiController {
  const env = options.env ?? process.env
  const color = options.color ?? env.NO_COLOR === undefined
  const adapter: BoloTerminalAdapter = createBoloTerminalAdapter({
    writeOut: options.writeOut,
    input: options.input,
    output: options.output,
    fallbackColumns: options.fallbackColumns,
    fallbackRows: options.fallbackRows,
  })
  let state = createCliTuiViewState()
  let started = false
  let stopped = false
  let suspended = false
  let streamedAssistantText = false
  let turnActivityEnabled = true
  let root: RetainedRoot
  let tui: TUI

  const requestRender = (): void => {
    if (started && !stopped && !suspended) tui.requestRender()
  }
  const requestComponentRender = (): void => {
    root.childChanged()
    requestRender()
  }
  const composer = new RetainedComposer({
    color,
    requestRender: requestComponentRender,
    onInputSettled: () => adapter.setInputEnabled(false),
    clearScreen: () => {
      adapter.clearScreen()
      if (started && !stopped && !suspended) tui.requestRender(true)
    },
  })
  const activityView = new RetainedActivity(requestComponentRender)
  root = new RetainedRoot(env, composer, activityView, color)
  tui = new TUI(
    adapter,
    true,
    path.join(getBoloHomeDir(), 'logs', 'tui'),
  )
  tui.setClearOnShrink(false)
  tui.addChild(root)
  tui.setFocus(composer)
  const now = options.now ?? Date.now
  const activity = createTurnActivityIndicator({
    writeOut: () => {
      throw new Error('retained activity attempted a direct terminal write')
    },
    color,
    columns: () =>
      Math.max(1, adapter.columns - resolveTuiContentGutter(adapter.columns)),
    now,
    intervalMs: options.activityIntervalMs,
    renderFrame: (line) => activityView.setLine(line),
    clearFrame: () => activityView.clear(),
  })

  const apply = (action: CliTuiViewAction): void => {
    state = reduceCliTuiViewState(state, action)
    root.setState(state)
    requestRender()
  }

  const finishThinkingSegment = (record: boolean): void => {
    const elapsedMs = activity.finishThinkingSegment()
    if (record && elapsedMs !== undefined) {
      apply({ type: 'finish_thinking_segment', elapsedMs })
    }
  }

  const eventFinishesThinking = (event: CliSessionEvent): boolean =>
    event.type === 'reasoning_end' ||
    (event.type === 'text' &&
      typeof event.text === 'string' &&
      event.text.length > 0) ||
    event.type === 'summary' ||
    event.type === 'tool_start' ||
    event.type === 'tool_progress' ||
    event.type === 'tool_end' ||
    event.type === 'web_search' ||
    event.type === 'permission_request' ||
    event.type === 'error' ||
    event.type === 'warning' ||
    event.type === 'ptl_retry' ||
    event.type === 'model_retry' ||
    event.type === 'done'

  const printer: SessionEventPrinter = {
    beginTurn(turnOptions) {
      streamedAssistantText = false
      activity.finish()
      turnActivityEnabled = turnOptions?.activity !== false
      apply({
        type: 'begin_turn',
        ...(turnOptions?.prompt !== undefined
          ? { prompt: turnOptions.prompt }
          : {}),
        ...(turnOptions?.echoUser !== undefined
          ? { echoUser: turnOptions.echoUser }
          : {}),
      })
      if (turnActivityEnabled) activity.start('Thinking')
    },
    onEvent(event: CliSessionEvent) {
      const showThinking = shouldShowThinking(options.showThinking)
      if (turnActivityEnabled) activity.beforeEvent(event)
      try {
        if (turnActivityEnabled && eventFinishesThinking(event)) {
          finishThinkingSegment(showThinking)
        }
        if (
          (event.type === 'reasoning' || event.type === 'reasoning_end') &&
          !showThinking
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
        state = reduceCliTuiViewState(
          state,
          projectCliTuiSessionEvent(projected as CliTuiSessionEvent),
        )
        if (
          event.type === 'text' &&
          typeof event.text === 'string' &&
          event.text.length > 0 &&
          state.activeTurnId !== null
        ) {
          streamedAssistantText = true
        }
        root.setState(state)
        requestRender()
      } finally {
        if (turnActivityEnabled) activity.afterEvent(event)
      }
    },
    endTurn(endOptions) {
      if (turnActivityEnabled) {
        finishThinkingSegment(shouldShowThinking(options.showThinking))
        activity.finish(endOptions?.terminalReason ?? 'completed')
      }
      apply({
        type: 'end_turn',
        terminal: {
          reason: endOptions?.terminalReason ?? 'completed',
        },
      })
      turnActivityEnabled = true
    },
    didStreamText() {
      return streamedAssistantText
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
    composer,
    printer,
    configureWelcome(welcomeOptions) {
      root.configureWelcome(welcomeOptions)
      requestRender()
    },
    setWelcomeVisible(visible) {
      root.setWelcomeVisible(visible)
      requestRender()
    },
    configureComposer(composerOptions) {
      composer.configure(composerOptions)
    },
    readInput(inputOptions) {
      if (stopped) {
        return Promise.resolve({ type: 'aborted' })
      }
      if (suspended) {
        throw new Error('retained Composer cannot begin input while suspended')
      }
      const pending = composer.readInput(inputOptions)
      if (!composer.isReading()) return pending
      try {
        adapter.setInputEnabled(true)
      } catch (error) {
        composer.cancelInput()
        throw error
      }
      return pending
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
      activity.finish()
      composer.cancelInput()
      adapter.setInputEnabled(false)
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
