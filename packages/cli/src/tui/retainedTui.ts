import path from 'node:path'
import {
  Container,
  TUI,
  Text,
  parseKey,
  type Component,
  type Focusable,
  type OverlayHandle,
} from './piCompat.ts'
import { getBoloHomeDir } from '../../../config/src/paths.ts'
import {
  buildPaletteAnsi,
  getTuiPalette,
  isTuiThemeId,
  resolveTuiTheme,
} from './theme.ts'
import type { ComposerAnsiPalette } from './inputBox.ts'
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
  type CliTuiToolPresentationRecord,
  type CliTuiViewAction,
  type CliTuiViewState,
  type CliToolDisplayMode,
  type RuntimePagerSuccess,
  parseSgrMouseSequence,
  createWheelNormalizer,
  WHEEL_CADENCE_MS,
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
  type RetainedCatalogOverlayHandle,
  type RetainedCatalogOverlayOptions,
  type RetainedDiffOverlayOptions,
  type RetainedDiffOverlayResult,
  type RetainedPagerOverlayOptions,
  type RetainedPickerOverlayMode,
  type RetainedTextPagerOverlayOptions,
} from './retainedOverlay.ts'
import { createToolResultFilePagerSource } from './fileTextPager.ts'
import {
  RetainedTranscript,
  type RetainedToolCatalogItem,
  type RetainedToolPagerContent,
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

export type RetainedToolHistoryResult =
  | { ok: false; reason: 'empty' | 'cancel' }
  | {
      ok: true
      blockId: string
      pager: RuntimePagerSuccess
    }

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
  restoreMessages(
    messages: readonly ChatMessage[],
    toolPresentations?: readonly CliTuiToolPresentationRecord[],
  ): void
  getState(): CliTuiViewState
  toggleToolDisplayMode(): CliToolDisplayMode | undefined
  setToolPagerContext(context?: { cwd: string; sessionId: string }): void
  runToolHistoryOverlay(options?: {
    signal?: AbortSignal
    cwd?: string
    sessionId?: string
  }): Promise<RetainedToolHistoryResult>
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
    onPreview?: (index: number) => void
  }): Promise<ArrowPickResult>
  /** /theme 预览：临时切换 palette 并重渲染（不落盘） */
  previewTheme(id: string): void
  /** 取消 /theme：恢复进入会话时的 palette */
  resetThemePreview(): void
  openCatalogOverlay(
    options: RetainedCatalogOverlayOptions,
  ): RetainedCatalogOverlayHandle
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
  /** TERM-1：终端能力探测结果（DA2/env/保守默认） */
  getTerminalCapabilities(): import('../../../shared/src/index.ts').TerminalCapabilities
}

type RevisionWaiter = {
  revision: number
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * pi-tui 把 base 内容渲染到屏幕 [viewportTop, viewportTop + rows) 的窗口；
 * `previousViewportTop` 是 doRender 后的私有字段。升级 pi-tui 时在
 * piCompat 收口处检查该字段是否仍存在。
 */
function tuiViewportTop(tui: TUI): number {
  const value = (
    tui as unknown as { previousViewportTop?: number }
  ).previousViewportTop
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 0
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
  private embeddedPager: Component | undefined
  private readonly compatibilityOutput = new Text('', 1, 0)
  private outputText = ''
  private visible = true
  private revision = 0
  private renderedRevision = -1
  private toolHitRegions: Array<{
    blockId: string
    startLine: number
    endLine: number
  }> = []
  private readonly waiters = new Set<RevisionWaiter>()

  /** REN-2：transcript 分片渲染是否未完成（转发） */
  isRenderIncomplete(): boolean {
    return this.transcript.isRenderIncomplete()
  }

  constructor(
    env: NodeJS.ProcessEnv,
    composer: RetainedComposer,
    activity: RetainedActivity,
    color: boolean,
    palette: ComposerAnsiPalette | undefined,
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
      palette,
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

  toggleToolDisplayMode(): CliToolDisplayMode | undefined {
    const mode = this.transcript.toggleToolDisplayMode()
    if (mode) this.markDirty()
    return mode
  }

  getToolCatalogItems(): RetainedToolCatalogItem[] {
    return this.transcript.getToolCatalogItems()
  }

  getToolPagerContent(
    blockId: string,
  ): RetainedToolPagerContent | undefined {
    return this.transcript.getToolPagerContent(blockId)
  }

  /** REN-1：markdown fidelity 问题汇总（controller 上报 warning） */
  getFidelityIssues(): ReadonlyMap<
    string,
    readonly import('../../../shared/src/index.ts').MarkdownFidelityIssue[]
  > {
    return this.transcript.getFidelityIssues()
  }

  /** REN-1：块 markdown 源指纹（warning 去重 key） */
  getBlockSourceFingerprint(blockId: string): string {
    return this.transcript.getBlockSourceFingerprint(blockId)
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.markDirty()
  }

  setEmbeddedPager(component: Component): void {
    if (this.embeddedPager === component) return
    if (this.embeddedPager) this.removeChild(this.embeddedPager)
    this.embeddedPager = component
    this.addChild(component)
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
    const toolHitRegions: Array<{
      blockId: string
      startLine: number
      endLine: number
    }> = []
    if (this.visible) {
      let line = 0
      const append = (section: string[], gap: number): void => {
        if (!section.length) return
        if (line > 0 && gap > 0) {
          lines.push(...Array.from({ length: gap }, () => ''))
          line += gap
        }
        lines.push(...section)
        line += section.length
      }
      append(this.welcome.render(width), 0)
      const transcriptStart = line
      append(this.transcript.render(width), 1)
      for (const [blockId, range] of this.transcript.getBlockHitLines()) {
        toolHitRegions.push({
          blockId,
          startLine: transcriptStart + range.start,
          endLine: transcriptStart + range.end,
        })
      }
      append(this.compatibilityOutput.render(width), 1)
      append(this.activity.render(width), 1)
      append(this.composer.render(width), 1)
      append(this.embeddedPager?.render(width) ?? [], 0)
      append(this.commandSurface.render(width), 0)
      append(this.footer.render(width), 0)
    }
    this.toolHitRegions = toolHitRegions
    this.renderedRevision = this.revision
    for (const waiter of [...this.waiters]) {
      if (this.renderedRevision < waiter.revision) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve()
    }
    return lines
  }

  /** 布局行（0-based，相对 root 顶部）命中哪个可点击 tool block。 */
  resolveToolHitAt(layoutLine: number): string | undefined {
    for (const region of this.toolHitRegions) {
      if (layoutLine >= region.startLine && layoutLine < region.endLine) {
        return region.blockId
      }
    }
    return undefined
  }

  private markDirty(): void {
    this.revision += 1
    this.invalidate()
  }
}

class RetainedOverlayView implements Component, Focusable {
  focused = false

  constructor(
    private readonly host: RetainedOverlayHost,
    private readonly presentation: 'modal' | 'embedded-pager',
  ) {}

  handleInput(data: string): void {
    this.host.focused = this.focused
    this.host.handleInput(data)
  }

  invalidate(): void {
    this.host.invalidate()
  }

  render(width: number): string[] {
    this.host.focused = this.focused
    return this.presentation === 'embedded-pager'
      ? this.host.renderEmbeddedPager(width)
      : this.host.render(width)
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
  /** 持久化主题 id（/theme 写入 config）；env.BOLO_THEME 优先 */
  theme?: string
}): CliTuiController {
  const env = options.env ?? process.env
  const color = options.color ?? env.NO_COLOR === undefined
  // 主题 palette：默认极光；/theme 预览时临时替换并触发重渲染，取消后恢复
  const theme = resolveTuiTheme({ env, theme: options.theme })
  let palette = buildPaletteAnsi(theme.palette, theme.trueColor, color)
  const adapter: BoloTerminalAdapter = createBoloTerminalAdapter({
    writeOut: options.writeOut,
    input: options.input,
    output: options.output,
    fallbackColumns: options.fallbackColumns,
    fallbackRows: options.fallbackRows,
    env,
  })
  let state = createCliTuiViewState()
  let started = false
  let stopped = false
  let streamedAssistantText = false
  let turnActivityEnabled = true
  let runningInterruptHandler: (() => void) | undefined
  let toolPagerContext: { cwd: string; sessionId: string } | undefined
  // REN-1：已上报的 fidelity 问题（blockId:kind 去重）
  const reportedFidelityIssues = new Set<string>()
  let root: RetainedRoot
  let tui: TUI
  let overlayHandle: OverlayHandle | undefined
  let embeddedPagerView: RetainedOverlayView
  let commandSurfaceEffect: CliCommandSurfaceEffect
  // TERM-3：滚轮规范化状态机（16ms 帧合并 + 加速度分带）
  const wheelNormalizer = createWheelNormalizer()
  // TERM-3：帧缓冲——帧内增量累积，帧末一次性 clamp 3 页滚动
  // （逐事件 clamp 会让 6 事件风暴仍达 13 页步跳底）
  const wheelFrame = {
    start: -Infinity,
    dir: undefined as 'up' | 'down' | undefined,
    lines: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const flushWheelFrame = (): void => {
    if (wheelFrame.lines > 0 && overlay.isActive()) {
      const steps = Math.min(3, wheelFrame.lines)
      overlay.scrollPager(
        wheelFrame.dir === 'down' ? steps : -steps,
      )
    }
    wheelFrame.lines = 0
    wheelFrame.dir = undefined
    if (wheelFrame.timer !== undefined) {
      clearTimeout(wheelFrame.timer)
      wheelFrame.timer = undefined
    }
  }
  const feedWheel = (direction: 'up' | 'down'): void => {
    const at = Date.now()
    if (
      at - wheelFrame.start > WHEEL_CADENCE_MS ||
      (wheelFrame.dir !== undefined && wheelFrame.dir !== direction)
    ) {
      flushWheelFrame()
      wheelFrame.start = at
    }
    wheelFrame.dir = direction
    wheelFrame.lines += wheelNormalizer.push({ direction, at }).scrollLines
    if (wheelFrame.timer === undefined) {
      wheelFrame.timer = setTimeout(flushWheelFrame, WHEEL_CADENCE_MS + 1)
    }
  }

  const requestRender = (): void => {
    if (started && !stopped) tui.requestRender()
  }
  const requestComponentRender = (): void => {
    root.childChanged()
    requestRender()
  }
  const composer = new RetainedComposer({
    color,
    palette,
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
    palette,
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
    embedPagers: options.rootVisible !== false,
    onPresentationChange: (presentation) => {
      if (presentation === 'embedded-pager') {
        tui.setFocus(embeddedPagerView)
      } else if (presentation === 'none' && options.rootVisible !== false) {
        tui.setFocus(composer)
      }
    },
  })
  const modalOverlayView = new RetainedOverlayView(overlay, 'modal')
  embeddedPagerView = new RetainedOverlayView(overlay, 'embedded-pager')
  root.setEmbeddedPager(embeddedPagerView)
  const removeMouseInputListener = tui.addInputListener((data) => {
    const mouse = parseSgrMouseSequence(data)
    if (!mouse) return
    if (mouse.kind === 'wheel') {
      // TERM-3：滚轮规范化（16ms 帧合并 + 加速度分带）→ 帧末 clamp 滚动 pager
      feedWheel(mouse.direction)
      return { consume: true }
    }
    if (mouse.kind !== 'press') return { consume: true }
    const presentation = overlay.getPresentation()
    if (presentation === 'modal') return { consume: true }
    const pagerKey = overlay.getActivePagerKey()
    if (presentation === 'embedded-pager' && pagerKey === undefined) {
      // runtime pager 占用 embedded 槽：不打断它，也不静默尝试失败
      return { consume: true }
    }
    const layoutLine = mouse.y - 1 + tuiViewportTop(tui)
    const blockId = root.resolveToolHitAt(layoutLine)
    if (!blockId) return { consume: true }
    if (pagerKey === `tool:${blockId}`) {
      overlay.dismissActivePager()
      requestRender()
    } else {
      if (pagerKey !== undefined) overlay.dismissActivePager()
      void openToolPagerFor(blockId).catch(() => {
        // 被其它 overlay 占用或 pager 已关闭：保持现状，键盘路径永远等价可用。
      })
    }
    return { consume: true }
  })
  const removeToolDisplayInputListener = tui.addInputListener((data) => {
    if (overlay.isActive() || parseKey(data) !== 'ctrl+o') return
    const mode = root.toggleToolDisplayMode()
    if (!mode) return
    requestRender()
    return { consume: true }
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

  const openToolPagerFor = (
    blockId: string,
    toolOptions?: {
      signal?: AbortSignal
      cwd?: string
      sessionId?: string
    },
  ): Promise<RuntimePagerSuccess> => {
    const pager = root.getToolPagerContent(blockId)
    if (!pager) {
      return Promise.resolve({
        ok: true,
        reason: 'quit',
        page: 0,
        pageCount: 1,
      })
    }
    const context = toolPagerContext
    const cwd = toolOptions?.cwd ?? context?.cwd
    const sessionId = toolOptions?.sessionId ?? context?.sessionId
    return pager.fullResult && cwd && sessionId
      ? overlay.runLazyTextPager({
          key: pager.key,
          title: pager.title,
          fallbackContent: pager.content,
          loadPage: createToolResultFilePagerSource({
            cwd,
            sessionId,
            reference: pager.fullResult,
          }).loadPage,
          ...(toolOptions?.signal ? { signal: toolOptions.signal } : {}),
        })
      : overlay.runTextPager({
          key: pager.key,
          title: pager.title,
          content: pager.content,
          ...(toolOptions?.signal ? { signal: toolOptions.signal } : {}),
        })
  }

  const runToolHistoryOverlay = async (toolOptions?: {
    signal?: AbortSignal
    cwd?: string
    sessionId?: string
  }): Promise<RetainedToolHistoryResult> => {
    const items = root.getToolCatalogItems()
    if (!items.length) {
      apply({
        type: 'command_surface',
        action: {
          type: 'show_toast',
          toast: {
            key: 'tools:empty',
            content: 'No tool results yet.',
            tone: 'info',
            ttlMs: 5_000,
          },
        },
      })
      return { ok: false, reason: 'empty' }
    }
    const picked = await overlay.runPicker({
      mode: 'picker',
      items,
      title: 'Tool results',
      ...(toolOptions?.signal ? { signal: toolOptions.signal } : {}),
    })
    if (!picked.ok) return { ok: false, reason: 'cancel' }
    const result = await openToolPagerFor(picked.id, toolOptions)
    return {
      ok: true,
      blockId: picked.id,
      pager: result,
    }
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
    if (!started || stopped) return
    const revision = root.currentRevision()
    tui.requestRender()
    await root.waitForRevision(revision)
    // REN-2：分片续帧——每帧 setImmediate 让路（输入事件优先）后继续渲染，
    // 直到完成（flush 语义保持：返回 = 渲染完整）
    while (root.isRenderIncomplete() && !stopped) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      const next = root.currentRevision()
      tui.requestRender()
      await root.waitForRevision(next)
    }
    // REN-1：markdown fidelity 自检——新问题以 warning 事件上报（不静默吞掉）。
    // 去重 key 含内容指纹：同一块内容变化后再次丢失会重新上报。
    for (const [blockId, issues] of root.getFidelityIssues()) {
      for (const issue of issues) {
        const fingerprint = root.getBlockSourceFingerprint(blockId)
        const key = `${blockId}:${issue.kind}:${fingerprint}`
        if (reportedFidelityIssues.has(key)) continue
        reportedFidelityIssues.add(key)
        printer.onEvent({
          type: 'warning',
          message:
            `markdown fidelity: block ${blockId} intended ${issue.intent} ` +
            `${issue.kind}(s) but none rendered`,
        })
      }
    }
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
    restoreMessages(messages, toolPresentations) {
      apply({
        type: 'restore_messages',
        messages,
        ...(toolPresentations ? { toolPresentations } : {}),
      })
    },
    getState() {
      return state
    },
    toggleToolDisplayMode() {
      const mode = root.toggleToolDisplayMode()
      if (mode) requestRender()
      return mode
    },
    setToolPagerContext(context) {
      toolPagerContext = context
    },
    runToolHistoryOverlay(toolOptions) {
      if (stopped) return Promise.resolve({ ok: false, reason: 'cancel' })
      return runToolHistoryOverlay(toolOptions)
    },
    async start() {
      if (started || stopped) return
      started = true
      try {
        tui.start()
        overlayHandle = tui.showOverlay(modalOverlayView, {
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
        () => removeMouseInputListener(),
        () => flushWheelFrame(),
        () => removeToolDisplayInputListener(),
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
    /** /theme 预览：临时切换 palette 并重渲染（不落盘） */
    previewTheme(id: string) {
      if (isTuiThemeId(id)) {
        palette = buildPaletteAnsi(
          getTuiPalette(id),
          theme.trueColor,
          color,
        )
        requestComponentRender()
      }
    },
    /** 取消 /theme：恢复进入会话时的 palette */
    resetThemePreview() {
      palette = buildPaletteAnsi(theme.palette, theme.trueColor, color)
      requestComponentRender()
    },
    openCatalogOverlay(overlayOptions) {
      if (stopped) {
        return {
          identity: {
            key: overlayOptions.key,
            generation: 0,
            sessionId: overlayOptions.sessionId,
            cwd: overlayOptions.cwd,
          },
          result: Promise.resolve({
            ok: false,
            reason: 'cancel',
            message: 'cancelled',
          }),
          replace: () => false,
          dismiss: () => false,
        }
      }
      return overlay.openCatalog(overlayOptions)
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
    getTerminalCapabilities() {
      return adapter.getTerminalCapabilities()
    },
  }

  return controller
}
