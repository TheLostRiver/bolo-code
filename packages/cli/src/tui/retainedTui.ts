import path from 'node:path'
import {
  Container,
  TUI,
  type Component,
  type OverlayHandle,
} from '@earendil-works/pi-tui/dist/tui.js'
import { Text } from '@earendil-works/pi-tui/dist/components/text.js'
import { parseKey } from '@earendil-works/pi-tui/dist/keys.js'
import { getBoloHomeDir } from '../../../config/src/paths.ts'
import {
  createCliCommandSurfaceState,
  createCliTuiViewState,
  projectCliTuiSessionEvent,
  reduceCliTuiViewState,
  type AskQuestion,
  type ChatMessage,
  type CliCommandPanelInput,
  type CliCommandPanelState,
  type CliCommandSurfaceAction,
  type CliCommandSurfaceState,
  type CliCommandToastInput,
  type CliCommandToastState,
  type CliTuiSessionEvent,
  type CliTuiViewAction,
  type CliTuiViewState,
  type RuntimePagerSuccess,
} from '../../../shared/src/index.ts'
import type { AskUserQuestionOutcome } from '../../../tools/src/index.ts'
import { runCleanupSteps } from '../cleanup.ts'
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
  CliCommandSurfaceEffect,
  createDefaultCliCommandSurfaceTimers,
  type CliCommandSurfaceTimers,
} from './commandSurfaceEffect.ts'
import {
  RetainedComposer,
  RetainedComposerFooter,
  type RetainedComposerConfig,
} from './retainedComposer.ts'
import { RetainedCommandSurface } from './retainedCommandSurface.ts'
import {
  RetainedOverlayHost,
  type RetainedDiffOverlayOptions,
  type RetainedDiffOverlayResult,
  type RetainedPagerOverlayOptions,
  type RetainedPickerOverlayMode,
  type RetainedTextPagerOverlayOptions,
} from './retainedOverlay.ts'
import {
  RetainedTranscript,
} from './retainedTranscript.ts'
import { resolveTuiContentGutter } from './contentLayout.ts'
import { createTurnActivityIndicator } from './turnActivity.ts'
import type {
  AskPermissionDecision,
  AskPermissionRequest,
} from './askPermissionTty.ts'
import type {
  ArrowPickItem,
  ArrowPickResult,
} from './arrowPicker.ts'

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
  setRunningInterruptHandler(handler?: () => void): void
  readInput(options?: { signal?: AbortSignal }): Promise<ReadTuiInputResult>
  showCommandPanel(panel: CliCommandPanelInput): CliCommandPanelState
  showCommandToast(toast: CliCommandToastInput): CliCommandToastState
  getCommandSurfaceState(): CliCommandSurfaceState
  resetCommandSurface(): void
  restoreMessages(messages: readonly ChatMessage[]): void
  getState(): CliTuiViewState
  start(): Promise<void>
  stop(): Promise<void>
  flush(): Promise<void>
  runPermissionOverlay(options: {
    request: AskPermissionRequest
    signal?: AbortSignal
    onInterrupt?: () => void
  }): Promise<AskPermissionDecision>
  runQuestionOverlay(options: {
    questions: readonly AskQuestion[]
    signal?: AbortSignal
  }): Promise<AskUserQuestionOutcome>
  runPickerOverlay(options: {
    mode: RetainedPickerOverlayMode
    items: ArrowPickItem[]
    title?: string
    initialIndex?: number
    signal?: AbortSignal
  }): Promise<ArrowPickResult>
  runDiffOverlay(
    options: RetainedDiffOverlayOptions,
  ): Promise<RetainedDiffOverlayResult>
  runPagerOverlay(
    options: RetainedPagerOverlayOptions,
  ): Promise<RuntimePagerSuccess>
  runTextPagerOverlay(
    options: RetainedTextPagerOverlayOptions,
  ): Promise<RuntimePagerSuccess>
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
  private readonly commandSurface: RetainedCommandSurface
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
    getViewportRows: () => number,
  ) {
    super()
    this.welcome = new WelcomeComponent(env)
    this.transcript = new RetainedTranscript({ env, getViewportRows })
    this.activity = activity
    this.composer = composer
    this.commandSurface = new RetainedCommandSurface(
      createCliCommandSurfaceState(),
      { color, getViewportRows },
    )
    this.footer = new RetainedComposerFooter(
      composer,
      color,
    )
    this.addChild(this.welcome)
    this.addChild(this.transcript)
    this.addChild(this.compatibilityOutput)
    this.addChild(this.activity)
    this.addChild(this.composer)
    this.addChild(this.commandSurface)
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
    this.commandSurface.setState(state.commandSurface)
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
      append(this.commandSurface.render(width), 0)
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
  commandSurfaceTimers?: CliCommandSurfaceTimers
  /** Standalone overlays (for example runtime pager) do not render the REPL root. */
  rootVisible?: boolean
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
  let streamedAssistantText = false
  let turnActivityEnabled = true
  let runningInterruptHandler: (() => void) | undefined
  let root: RetainedRoot
  let tui: TUI
  let overlayHandle: OverlayHandle | undefined
  let commandSurfaceEffect: CliCommandSurfaceEffect

  const requestRender = (): void => {
    if (started && !stopped) tui.requestRender()
  }
  const requestComponentRender = (): void => {
    root.childChanged()
    requestRender()
  }
  const composer = new RetainedComposer({
    color,
    requestRender: requestComponentRender,
    onInputSettled: () => {
      if (!runningInterruptHandler) adapter.setInputEnabled(false)
    },
    onInputMutation: () => {
      apply({ type: 'command_surface', action: { type: 'accepted_input' } })
    },
    onIdleEscape: () => {
      apply({ type: 'command_surface', action: { type: 'escape' } })
    },
    onRunningInterrupt: () => runningInterruptHandler?.(),
    clearScreen: () => {
      adapter.clearScreen()
      if (started && !stopped) tui.requestRender(true)
    },
  })
  const activityView = new RetainedActivity(requestComponentRender)
  root = new RetainedRoot(
    env,
    composer,
    activityView,
    color,
    () => adapter.rows,
  )
  root.setVisible(options.rootVisible !== false)
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
    commandSurfaceEffect.sync(state.commandSurface)
    requestRender()
  }
  commandSurfaceEffect = new CliCommandSurfaceEffect(
    (action: CliCommandSurfaceAction) =>
      apply({ type: 'command_surface', action }),
    options.commandSurfaceTimers ?? createDefaultCliCommandSurfaceTimers(),
  )
  const overlay = new RetainedOverlayHost({
    color,
    setOverlayState: (next) => apply({ type: 'set_overlay', overlay: next }),
    requestRender: requestComponentRender,
    setInputEnabled: (active) => adapter.setInputEnabled(active),
    shouldKeepInput: () =>
      composer.isReading() || runningInterruptHandler !== undefined,
    getColumns: () => adapter.columns,
    getRows: () => adapter.rows,
  })
  const removeRunningInterruptInputListener = tui.addInputListener((data) => {
    const handler = runningInterruptHandler
    if (
      !handler ||
      composer.getMode() !== 'running' ||
      overlay.isActive()
    ) {
      return
    }
    const key = parseKey(data)
    if (key !== 'escape' && key !== 'ctrl+c') return
    handler()
    return { consume: true }
  })

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
    if (!started || stopped) return
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
    setRunningInterruptHandler(handler) {
      runningInterruptHandler = handler
      if (!handler && !composer.isReading()) adapter.setInputEnabled(false)
    },
    readInput(inputOptions) {
      if (stopped) {
        return Promise.resolve({ type: 'aborted' })
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
    showCommandPanel(panel) {
      apply({
        type: 'command_surface',
        action: { type: 'show_panel', panel },
      })
      return state.commandSurface.panel!
    },
    showCommandToast(toast) {
      apply({
        type: 'command_surface',
        action: { type: 'show_toast', toast },
      })
      return state.commandSurface.toast!
    },
    getCommandSurfaceState() {
      return state.commandSurface
    },
    resetCommandSurface() {
      apply({
        type: 'command_surface',
        action: { type: 'reset' },
      })
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
      try {
        tui.start()
        overlayHandle = tui.showOverlay(overlay, {
          width: '100%',
          maxHeight: options.rootVisible === false ? '100%' : '90%',
          anchor: 'bottom-center',
          margin: {
            left: 1,
            right: 1,
            bottom: options.rootVisible === false ? 0 : 2,
          },
          visible: () => overlay.isActive(),
        })
        overlay.attach(overlayHandle)
        overlayHandle.setHidden(true)
        await flush()
      } catch (error) {
        try {
          await controller.stop()
        } catch {
          /* preserve the renderer start error */
        }
        throw error
      }
    },
    async stop() {
      if (stopped) return
      stopped = true
      const activeOverlayHandle = overlayHandle
      const shouldStopTui = started
      overlayHandle = undefined
      started = false
      runCleanupSteps([
        () => activity.finish(),
        () => overlay.cancel(),
        () => activeOverlayHandle?.hide(),
        () => {
          runningInterruptHandler = undefined
        },
        () => removeRunningInterruptInputListener(),
        () => commandSurfaceEffect.dispose(),
        () => composer.cancelInput(),
        () => adapter.setInputEnabled(false),
        () => {
          if (shouldStopTui) tui.stop()
        },
        () => root.close(),
      ])
    },
    flush,
    runPermissionOverlay(overlayOptions) {
      if (stopped) return Promise.resolve('deny')
      return overlay.runPermission(overlayOptions)
    },
    runQuestionOverlay(overlayOptions) {
      if (stopped) return Promise.resolve({ kind: 'cancelled' })
      return overlay.runQuestion(overlayOptions)
    },
    runPickerOverlay(overlayOptions) {
      if (stopped) {
        return Promise.resolve({
          ok: false,
          reason: 'cancel',
          message: 'cancelled',
        })
      }
      return overlay.runPicker(overlayOptions)
    },
    runDiffOverlay(overlayOptions) {
      if (stopped) {
        return Promise.resolve(
          overlayOptions.mode === 'approve'
            ? { ok: true, decision: 'deny' }
            : { ok: true, reason: 'quit' },
        )
      }
      return overlay.runDiff(overlayOptions)
    },
    runPagerOverlay(overlayOptions) {
      if (stopped) {
        return Promise.resolve({
          ok: true,
          reason: 'interrupt',
          page: 0,
          pageCount: 1,
        })
      }
      return overlay.runPager(overlayOptions)
    },
    runTextPagerOverlay(overlayOptions) {
      if (stopped) {
        return Promise.resolve({
          ok: true,
          reason: 'interrupt',
          page: 0,
          pageCount: 1,
        })
      }
      return overlay.runTextPager(overlayOptions)
    },
    writeOutput(text) {
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
