import {
  type Component,
  type Focusable,
  type OverlayHandle,
} from '@earendil-works/pi-tui/dist/tui.js'
import { parseKey } from '@earendil-works/pi-tui/dist/keys.js'
import { Input } from '@earendil-works/pi-tui/dist/components/input.js'
import type {
  AskQuestion,
  AskUserQuestionSelection,
  CliTuiOverlayState,
  RuntimePagerKey,
  RuntimePagerSuccess,
  RuntimeQueryView,
} from '../../../shared/src/index.ts'
import { applyRuntimePagerKey } from '../../../shared/src/index.ts'
import type { AskUserQuestionOutcome } from '../../../tools/src/index.ts'
import {
  applyDiffViewKey,
  formatDiffViewScreen,
  type DiffViewModel,
} from '../../../core/src/diffViewModel.ts'
import {
  renderRuntimeText,
  type RuntimeTextRenderOptions,
} from '../../../core/src/runtimeTextView.ts'
import type {
  AskPermissionDecision,
  AskPermissionRequest,
} from './askPermissionTty.ts'
import {
  applyArrowPickerKey,
  formatArrowPickerScreen,
  type ArrowPickItem,
  type ArrowPickResult,
} from './arrowPicker.ts'
import {
  applyPermissionPanelKey,
  formatPermissionPanelScreen,
} from './permissionPanel.ts'
import {
  applyQuestionPickerKey,
  createQuestionPickerState,
  formatQuestionPickerScreen,
  type QuestionPickerState,
} from './questionPicker.ts'
import type {
  DiffPaneApproveResult,
  DiffPaneBrowseResult,
} from './diffPane.ts'
import {
  formatTextPagerScreen,
  resolveEmbeddedTextPagerPageSize,
  type TextPagerContent,
} from './textPager.ts'
import {
  clipTerminalText,
  wrapTerminalText,
} from './terminalText.ts'

type OverlaySessionBase = {
  signal?: AbortSignal
  onAbort?: () => void
}

type PermissionSession = OverlaySessionBase & {
  mode: 'permission'
  request: AskPermissionRequest
  index: number
  resolve: (decision: AskPermissionDecision) => void
  onInterrupt?: () => void
}

type QuestionSession = OverlaySessionBase & {
  mode: 'question'
  questions: readonly AskQuestion[]
  state: QuestionPickerState
  selections: AskUserQuestionSelection[]
  customInput?: Input
  resolve: (outcome: AskUserQuestionOutcome) => void
}

export type RetainedPickerOverlayMode =
  | 'picker'
  | 'provider'
  | 'effort'

export type RetainedCatalogOverlayIdentity = {
  readonly key: string
  readonly generation: number
  readonly sessionId: string
  readonly cwd: string
}

export type RetainedCatalogOverlayOptions = OverlaySessionBase & {
  key: string
  sessionId: string
  cwd: string
  title: string
  loadingText: string
}

export type RetainedCatalogOverlayUpdate = {
  key: string
  sessionId: string
  cwd: string
  title?: string
  items: readonly ArrowPickItem[]
  emptyMessage?: string
}

export type RetainedCatalogOverlayHandle = {
  readonly identity: RetainedCatalogOverlayIdentity
  readonly result: Promise<ArrowPickResult>
  replace(update: RetainedCatalogOverlayUpdate): boolean
  dismiss(): boolean
}

type PickerSession = OverlaySessionBase & {
  mode: RetainedPickerOverlayMode
  items: ArrowPickItem[]
  title?: string
  index: number
  resolve: (result: ArrowPickResult) => void
}

type CatalogSession = OverlaySessionBase & {
  mode: 'catalog'
  identity: RetainedCatalogOverlayIdentity
  title: string
  loadingText: string
  phase: 'loading' | 'result'
  items: ArrowPickItem[]
  emptyMessage?: string
  index: number
  resolve: (result: ArrowPickResult) => void
}

export type RetainedDiffOverlayOptions = OverlaySessionBase & {
  model: DiffViewModel
  mode: 'browse' | 'approve'
  toolName?: string
  onInterrupt?: () => void
}

export type RetainedDiffOverlayResult =
  | DiffPaneBrowseResult
  | DiffPaneApproveResult

type DiffSession = OverlaySessionBase & {
  mode: 'diff'
  viewMode: 'browse' | 'approve'
  model: DiffViewModel
  toolName?: string
  toast?: string
  resolve: (result: RetainedDiffOverlayResult) => void
  onInterrupt?: () => void
}

export type RetainedPagerOverlayOptions = OverlaySessionBase & {
  view: RuntimeQueryView
  pageSize?: number
  filter?: RuntimeTextRenderOptions['filter']
  onInterrupt?: () => void
}

export type RetainedTextPagerOverlayOptions =
  OverlaySessionBase &
    TextPagerContent & {
      pageSize?: number
      onInterrupt?: () => void
    }

export type RetainedOverlayPresentation =
  | 'none'
  | 'modal'
  | 'embedded-pager'

type PagerSource =
  | {
      kind: 'runtime'
      view: RuntimeQueryView
      filter?: RuntimeTextRenderOptions['filter']
    }
  | ({
      kind: 'text'
    } & TextPagerContent)

type PagerSession = OverlaySessionBase & {
  mode: 'pager'
  source: PagerSource
  page: number
  pageCount: number
  pageSize: number
  resolve: (result: RuntimePagerSuccess) => void
  onInterrupt?: () => void
}

type OverlaySession =
  | PermissionSession
  | QuestionSession
  | PickerSession
  | CatalogSession
  | DiffSession
  | PagerSession

function isPickerSession(
  session: OverlaySession | undefined,
): session is PickerSession {
  return (
    session?.mode === 'picker' ||
    session?.mode === 'provider' ||
    session?.mode === 'effort'
  )
}

function decodePanelKey(data: string): string {
  const key = parseKey(data)
  if (key === 'ctrl+c') return 'ctrl-c'
  if (key === 'ctrl+d') return 'eof'
  if (key === 'escape' || key === 'esc') return 'esc'
  if (key === 'enter' || key === 'return') return 'enter'
  if (key === 'backspace') return 'backspace'
  if (key === 'space') return ' '
  if (
    key === 'up' ||
    key === 'down' ||
    key === 'left' ||
    key === 'right' ||
    key === 'pageUp' ||
    key === 'pageDown' ||
    key === 'home' ||
    key === 'end'
  ) {
    return key
  }
  if (data.length === 1) return data
  return 'none'
}

function wrapPanelScreen(screen: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width))
  return screen.split('\n').flatMap((line) => {
    if (!line) return ['']
    return wrapTerminalText(line, safeWidth)
  })
}

function catalogPageSize(rows: number): number {
  const safeRows = Math.max(1, Math.floor(rows))
  return safeRows < 5 ? safeRows : Math.max(1, safeRows - 4)
}

function applyCatalogPickerKey(
  index: number,
  length: number,
  key: string,
  pageSize: number,
): { index: number; done?: 'select' | 'cancel' } {
  if (length <= 0) return { index: 0, done: 'cancel' }
  if (key === 'home') return { index: 0 }
  if (key === 'end') return { index: length - 1 }
  if (key === 'pageUp') {
    return { index: Math.max(0, index - pageSize) }
  }
  if (key === 'pageDown') {
    return { index: Math.min(length - 1, index + pageSize) }
  }
  return applyArrowPickerKey(index, length, key)
}

function formatCatalogPickerScreen(
  session: CatalogSession,
  width: number,
  rows: number,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const safeRows = Math.max(1, Math.floor(rows))
  const pageSize = catalogPageSize(safeRows)
  const maxStart = Math.max(0, session.items.length - pageSize)
  const start = Math.min(
    maxStart,
    Math.floor(session.index / pageSize) * pageSize,
  )
  const end = Math.min(session.items.length, start + pageSize)
  const itemLines = session.items.slice(start, end).map((item, offset) => {
    const absoluteIndex = start + offset
    const mark = absoluteIndex === session.index ? '›' : ' '
    return clipTerminalText(
      `${mark} ${absoluteIndex + 1}. ${item.label}`,
      safeWidth,
    )
  })
  if (safeRows < 5) return itemLines.slice(0, safeRows)
  return [
    clipTerminalText(session.title, safeWidth),
    '',
    ...itemLines,
    '',
    clipTerminalText(
      `${start + 1}-${end} of ${session.items.length} · ↑/↓ · PgUp/PgDn · Enter · q`,
      safeWidth,
    ),
  ]
}

export class RetainedOverlayHost implements Component, Focusable {
  focused = false
  private active: OverlaySession | undefined
  private handle: OverlayHandle | undefined
  private nextCatalogGeneration = 1

  constructor(
    private readonly options: {
      color: boolean
      setOverlayState: (overlay: CliTuiOverlayState) => void
      requestRender: () => void
      setInputEnabled: (active: boolean) => void
      shouldKeepInput: () => boolean
      getColumns: () => number
      getRows: () => number
      embedPagers?: boolean
      onPresentationChange?: (
        presentation: RetainedOverlayPresentation,
      ) => void
    },
  ) {}

  attach(handle: OverlayHandle): void {
    this.handle = handle
  }

  isActive(): boolean {
    return this.active !== undefined
  }

  runPermission(options: {
    request: AskPermissionRequest
    signal?: AbortSignal
    onInterrupt?: () => void
  }): Promise<AskPermissionDecision> {
    if (this.active) {
      return Promise.reject(
        new Error(`overlay already active: ${this.active.mode}`),
      )
    }
    if (options.signal?.aborted) return Promise.resolve('deny')

    return new Promise<AskPermissionDecision>((resolve) => {
      const session: PermissionSession = {
        mode: 'permission',
        request: options.request,
        index: 2,
        resolve,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onInterrupt
          ? { onInterrupt: options.onInterrupt }
          : {}),
      }
      if (options.signal) {
        session.onAbort = () => this.finishPermission('deny')
        options.signal.addEventListener('abort', session.onAbort, {
          once: true,
        })
      }
      this.active = session
      this.options.setOverlayState({
        mode: 'permission',
        request: {
          id: options.request.toolUseId,
          name: options.request.toolName,
          input: options.request.toolInput,
        },
      })
      this.handle?.setHidden(false)
      try {
        this.options.setInputEnabled(true)
      } catch {
        this.finishPermission('deny')
        return
      }
      this.options.requestRender()
    })
  }

  runQuestion(options: {
    questions: readonly AskQuestion[]
    signal?: AbortSignal
  }): Promise<AskUserQuestionOutcome> {
    if (this.active) {
      return Promise.reject(
        new Error(`overlay already active: ${this.active.mode}`),
      )
    }
    if (!options.questions.length || options.signal?.aborted) {
      return Promise.resolve({ kind: 'cancelled' })
    }

    return new Promise<AskUserQuestionOutcome>((resolve) => {
      const session: QuestionSession = {
        mode: 'question',
        questions: options.questions,
        state: createQuestionPickerState(options.questions),
        selections: [],
        resolve,
        ...(options.signal ? { signal: options.signal } : {}),
      }
      if (options.signal) {
        session.onAbort = () =>
          this.finishQuestion({ kind: 'cancelled' })
        options.signal.addEventListener('abort', session.onAbort, {
          once: true,
        })
      }
      this.active = session
      this.open({ mode: 'question' })
    })
  }

  runPicker(options: {
    mode: RetainedPickerOverlayMode
    items: ArrowPickItem[]
    title?: string
    initialIndex?: number
    signal?: AbortSignal
  }): Promise<ArrowPickResult> {
    if (this.active) {
      return Promise.reject(
        new Error(`overlay already active: ${this.active.mode}`),
      )
    }
    if (!options.items.length) {
      return Promise.resolve({
        ok: false,
        reason: 'cancel',
        message: 'empty list',
      })
    }
    if (options.signal?.aborted) {
      return Promise.resolve({
        ok: false,
        reason: 'cancel',
        message: 'cancelled',
      })
    }
    const max = options.items.length - 1
    const index =
      options.initialIndex != null &&
      Number.isFinite(options.initialIndex)
        ? Math.max(0, Math.min(max, Math.floor(options.initialIndex)))
        : 0

    return new Promise<ArrowPickResult>((resolve) => {
      const session: PickerSession = {
        mode: options.mode,
        items: options.items,
        index,
        resolve,
        ...(options.title ? { title: options.title } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }
      if (options.signal) {
        session.onAbort = () =>
          this.finishPicker({
            ok: false,
            reason: 'cancel',
            message: 'cancelled',
          })
        options.signal.addEventListener('abort', session.onAbort, {
          once: true,
        })
      }
      this.active = session
      this.open({ mode: options.mode })
    })
  }

  openCatalog(
    options: RetainedCatalogOverlayOptions,
  ): RetainedCatalogOverlayHandle {
    if (options.signal?.aborted) {
      const identity: RetainedCatalogOverlayIdentity = {
        key: options.key,
        generation: this.nextCatalogGeneration++,
        sessionId: options.sessionId,
        cwd: options.cwd,
      }
      return {
        identity,
        result: Promise.resolve({
          ok: false,
          reason: 'cancel',
          message: 'cancelled',
        }),
        replace: () => false,
        dismiss: () => false,
      }
    }
    const current = this.active
    const replacing =
      current?.mode === 'catalog' &&
      current.identity.key === options.key
    if (current && !replacing) {
      throw new Error(`overlay already active: ${current.mode}`)
    }

    if (replacing) {
      this.detachAbort(current)
      current.resolve({
        ok: false,
        reason: 'cancel',
        message: 'replaced',
      })
    }

    const identity: RetainedCatalogOverlayIdentity = {
      key: options.key,
      generation: this.nextCatalogGeneration++,
      sessionId: options.sessionId,
      cwd: options.cwd,
    }
    let resolveResult!: (result: ArrowPickResult) => void
    const result = new Promise<ArrowPickResult>((resolve) => {
      resolveResult = resolve
    })
    const session: CatalogSession = {
      mode: 'catalog',
      identity,
      title: options.title,
      loadingText: options.loadingText,
      phase: 'loading',
      items: [],
      index: 0,
      resolve: resolveResult,
      ...(options.signal ? { signal: options.signal } : {}),
    }
    if (options.signal) {
      session.onAbort = () =>
        this.finishCatalog(session, {
          ok: false,
          reason: 'cancel',
          message: 'cancelled',
        })
      options.signal.addEventListener('abort', session.onAbort, {
        once: true,
      })
    }
    this.active = session
    if (replacing) {
      this.options.setOverlayState({ mode: 'picker' })
      this.options.requestRender()
    } else {
      this.open({ mode: 'picker' })
    }

    return {
      identity,
      result,
      replace: (update) => this.replaceCatalog(session, update),
      dismiss: () =>
        this.finishCatalog(session, {
          ok: false,
          reason: 'cancel',
          message: 'dismissed',
        }),
    }
  }

  runDiff(
    options: RetainedDiffOverlayOptions,
  ): Promise<RetainedDiffOverlayResult> {
    if (this.active) {
      return Promise.reject(
        new Error(`overlay already active: ${this.active.mode}`),
      )
    }
    if (!options.model.files.length) {
      return Promise.resolve({
        ok: false,
        reason: 'empty',
        message: 'No file changes to show in panel.',
      })
    }
    if (options.signal?.aborted) {
      return Promise.resolve(
        options.mode === 'approve'
          ? { ok: true, decision: 'deny' }
          : { ok: true, reason: 'quit' },
      )
    }

    return new Promise<RetainedDiffOverlayResult>((resolve) => {
      const session: DiffSession = {
        mode: 'diff',
        viewMode: options.mode,
        model: options.model,
        resolve,
        ...(options.toolName ? { toolName: options.toolName } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onInterrupt
          ? { onInterrupt: options.onInterrupt }
          : {}),
      }
      if (options.signal) {
        session.onAbort = () =>
          this.finishDiff(
            session.viewMode === 'approve'
              ? { ok: true, decision: 'deny' }
              : { ok: true, reason: 'quit' },
          )
        options.signal.addEventListener('abort', session.onAbort, {
          once: true,
        })
      }
      this.active = session
      this.open({ mode: 'diff' })
    })
  }

  runPager(
    options: RetainedPagerOverlayOptions,
  ): Promise<RuntimePagerSuccess> {
    if (this.active) {
      return Promise.reject(
        new Error(`overlay already active: ${this.active.mode}`),
      )
    }
    const pageSize =
      options.pageSize ??
      Math.max(1, Math.floor(this.options.getRows()) - 6)
    const initial = renderRuntimeText(options.view, {
      columns: this.options.getColumns(),
      page: 0,
      pageSize,
      color: this.options.color,
      filter: options.filter,
    })
    if (initial.pageCount <= 1) {
      return Promise.resolve({
        ok: true,
        reason: 'single-page',
        page: initial.page,
        pageCount: initial.pageCount,
      })
    }
    if (options.signal?.aborted) {
      return Promise.resolve({
        ok: true,
        reason: 'interrupt',
        page: initial.page,
        pageCount: initial.pageCount,
      })
    }

    return new Promise<RuntimePagerSuccess>((resolve) => {
      const session: PagerSession = {
        mode: 'pager',
        source: {
          kind: 'runtime',
          view: options.view,
          ...(options.filter ? { filter: options.filter } : {}),
        },
        page: initial.page,
        pageCount: initial.pageCount,
        pageSize,
        resolve,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onInterrupt
          ? { onInterrupt: options.onInterrupt }
          : {}),
      }
      if (options.signal) {
        session.onAbort = () => this.finishPager('interrupt')
        options.signal.addEventListener('abort', session.onAbort, {
          once: true,
        })
      }
      this.active = session
      this.open({ mode: 'pager' })
    })
  }

  runTextPager(
    options: RetainedTextPagerOverlayOptions,
  ): Promise<RuntimePagerSuccess> {
    if (this.active) {
      return Promise.reject(
        new Error(`overlay already active: ${this.active.mode}`),
      )
    }
    const pageSize =
      options.pageSize ??
      resolveEmbeddedTextPagerPageSize(this.options.getRows())
    const initial = formatTextPagerScreen({
      title: options.title,
      content: options.content,
      columns: this.options.getColumns(),
      page: 0,
      pageSize,
      color: this.options.color,
    })
    if (options.signal?.aborted) {
      return Promise.resolve({
        ok: true,
        reason: 'interrupt',
        page: initial.page,
        pageCount: initial.pageCount,
      })
    }

    return new Promise<RuntimePagerSuccess>((resolve) => {
      const session: PagerSession = {
        mode: 'pager',
        source: {
          kind: 'text',
          key: options.key,
          title: options.title,
          content: options.content,
        },
        page: initial.page,
        pageCount: initial.pageCount,
        pageSize,
        resolve,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onInterrupt
          ? { onInterrupt: options.onInterrupt }
          : {}),
      }
      if (options.signal) {
        session.onAbort = () => this.finishPager('interrupt')
        options.signal.addEventListener('abort', session.onAbort, {
          once: true,
        })
      }
      this.active = session
      this.open({ mode: 'pager' })
    })
  }

  cancel(): void {
    if (this.active?.mode === 'permission') {
      this.finishPermission('deny')
    } else if (this.active?.mode === 'question') {
      this.finishQuestion({ kind: 'cancelled' })
    } else if (isPickerSession(this.active)) {
      this.finishPicker({
        ok: false,
        reason: 'cancel',
        message: 'cancelled',
      })
    } else if (this.active?.mode === 'catalog') {
      this.finishCatalog(this.active, {
        ok: false,
        reason: 'cancel',
        message: 'cancelled',
      })
    } else if (this.active?.mode === 'diff') {
      this.finishDiff(
        this.active.viewMode === 'approve'
          ? { ok: true, decision: 'deny' }
          : { ok: true, reason: 'quit' },
      )
    } else if (this.active?.mode === 'pager') {
      this.finishPager('interrupt')
    }
  }

  handleInput(data: string): void {
    const active = this.active
    if (!active) return
    if (active.mode === 'question' && active.customInput) {
      active.customInput.handleInput(data)
      this.options.requestRender()
      return
    }
    const key = decodePanelKey(data)
    if (active.mode === 'permission') {
      if (key === 'ctrl-c') active.onInterrupt?.()
      const next = applyPermissionPanelKey(active.index, key)
      active.index = next.index
      if (next.decision) {
        this.finishPermission(next.decision)
      } else if (key !== 'none') {
        this.options.requestRender()
      }
      return
    }
    if (active.mode === 'question') {
      const next = applyQuestionPickerKey(active.state, key)
      active.state = next.state
      if (!next.done) {
        if (key !== 'none') this.options.requestRender()
        return
      }
      if (next.done.kind === 'cancelled') {
        this.finishQuestion({ kind: 'cancelled' })
        return
      }
      if (next.done.kind === 'custom') {
        this.startCustomQuestionInput(active)
        return
      }
      this.acceptQuestionSelection(active, next.done.selection)
      return
    }
    if (isPickerSession(active)) {
      const next = applyArrowPickerKey(
        active.index,
        active.items.length,
        key,
      )
      active.index = next.index
      if (next.done === 'select') {
        this.finishPicker({
          ok: true,
          id: active.items[active.index]!.id,
          index: active.index,
        })
      } else if (next.done === 'cancel') {
        this.finishPicker({
          ok: false,
          reason: 'cancel',
          message: 'cancelled',
        })
      } else if (key !== 'none') {
        this.options.requestRender()
      }
      return
    }
    if (active.mode === 'catalog') {
      if (active.phase === 'loading' || !active.items.length) {
        if (
          key === 'esc' ||
          key === 'q' ||
          key === 'ctrl-c' ||
          key === 'enter'
        ) {
          this.finishCatalog(active, {
            ok: false,
            reason: 'cancel',
            message: 'cancelled',
          })
        }
        return
      }
      const next = applyCatalogPickerKey(
        active.index,
        active.items.length,
        key,
        catalogPageSize(this.options.getRows()),
      )
      active.index = next.index
      if (next.done === 'select') {
        this.finishCatalog(active, {
          ok: true,
          id: active.items[active.index]!.id,
          index: active.index,
        })
      } else if (next.done === 'cancel') {
        this.finishCatalog(active, {
          ok: false,
          reason: 'cancel',
          message: 'cancelled',
        })
      } else if (key !== 'none') {
        this.options.requestRender()
      }
      return
    }
    if (active.mode === 'diff') {
      if (key === 'ctrl-c') active.onInterrupt?.()
      const next = applyDiffViewKey(active.model, key, {
        mode: active.viewMode,
      })
      active.model = next.vm
      active.toast = next.toast
      if (active.viewMode === 'approve') {
        if (
          next.done === 'allow' ||
          next.done === 'deny' ||
          next.done === 'allow_always'
        ) {
          this.finishDiff({ ok: true, decision: next.done })
          return
        }
      } else if (next.done === 'quit') {
        this.finishDiff({ ok: true, reason: 'quit' })
        return
      }
      if (key !== 'none') this.options.requestRender()
      return
    }
    if (active.mode === 'pager') {
      const pagerKey = toRuntimePagerKey(key)
      if (pagerKey === 'none') return
      const next = applyRuntimePagerKey(
        active.page,
        active.pageCount,
        pagerKey,
      )
      active.page = next.page
      if (next.done) {
        if (next.done === 'interrupt') active.onInterrupt?.()
        this.finishPager(next.done)
      } else {
        this.options.requestRender()
      }
    }
  }

  invalidate(): void {
    if (this.active?.mode === 'question') {
      this.active.customInput?.invalidate()
    }
  }

  render(width: number): string[] {
    const active = this.active
    if (!active || this.presentation(active) === 'embedded-pager') return []
    return this.renderActive(active, width)
  }

  renderEmbeddedPager(width: number): string[] {
    const active = this.active
    if (!active || this.presentation(active) !== 'embedded-pager') return []
    return this.renderActive(active, width)
  }

  private renderActive(active: OverlaySession, width: number): string[] {
    if (active.mode === 'permission') {
      return formatPermissionPanelScreen(active.request, active.index, {
        columns: width,
        color: this.options.color,
      }).split('\n')
    }
    if (active.mode === 'question') {
      const lines = wrapPanelScreen(
        formatQuestionPickerScreen(active.state),
        width,
      )
      if (active.customInput) {
        active.customInput.focused = this.focused
        lines.push('', 'Your answer')
        lines.push(
          ...active.customInput
            .render(Math.max(1, width - 2))
            .map((line) => `> ${line}`),
        )
        lines.push('Enter submit · Esc back')
      }
      return lines
    }
    if (isPickerSession(active)) {
      return wrapPanelScreen(
        formatArrowPickerScreen(active.items, active.index, {
          title: active.title,
        }),
        width,
      )
    }
    if (active.mode === 'catalog') {
      if (active.phase === 'loading') {
        return wrapPanelScreen(
          [
            active.title,
            '',
            active.loadingText,
            '',
            'Esc cancel',
          ].join('\n'),
          width,
        ).slice(0, Math.max(1, Math.floor(this.options.getRows())))
      }
      if (!active.items.length) {
        return wrapPanelScreen(
          [
            active.title,
            '',
            active.emptyMessage ?? 'No items.',
            '',
            'Esc close',
          ].join('\n'),
          width,
        ).slice(0, Math.max(1, Math.floor(this.options.getRows())))
      }
      return formatCatalogPickerScreen(
        active,
        width,
        this.options.getRows(),
      )
    }
    if (active.mode === 'diff') {
      return formatDiffViewScreen(active.model, {
        rows: Math.max(8, this.options.getRows() - 4),
        cols: width,
        toast: active.toast,
        mode: active.viewMode,
        toolName: active.toolName,
      }).split('\n')
    }
    if (active.mode === 'pager') {
      const rendered =
        active.source.kind === 'runtime'
          ? renderRuntimeText(active.source.view, {
              columns: width,
              page: active.page,
              pageSize: active.pageSize,
              color: this.options.color,
              filter: active.source.filter,
            })
          : formatTextPagerScreen({
              title: active.source.title,
              content: active.source.content,
              columns: width,
              page: active.page,
              pageSize: active.pageSize,
              color: this.options.color,
            })
      active.page = rendered.page
      active.pageCount = rendered.pageCount
      return rendered.text.split('\n')
    }
    return []
  }

  private open(overlay: CliTuiOverlayState): void {
    const presentation = this.presentation(this.active)
    this.options.setOverlayState(overlay)
    this.handle?.setHidden(presentation !== 'modal')
    try {
      this.options.setInputEnabled(true)
    } catch {
      this.cancel()
      return
    }
    this.options.onPresentationChange?.(presentation)
    this.options.requestRender()
  }

  private close(active: OverlaySession): void {
    const presentation = this.presentation(active)
    this.detachAbort(active)
    if (active.mode === 'question' && active.customInput) {
      active.customInput.focused = false
    }
    this.options.setOverlayState({ mode: 'none' })
    if (presentation === 'modal') this.handle?.setHidden(true)
    try {
      this.options.setInputEnabled(this.options.shouldKeepInput())
    } catch {
      // The panel result must settle even if the terminal cannot restore raw mode.
    }
    this.options.onPresentationChange?.('none')
    this.options.requestRender()
  }

  private presentation(
    active: OverlaySession | undefined,
  ): RetainedOverlayPresentation {
    if (!active) return 'none'
    return active.mode === 'pager' && this.options.embedPagers
      ? 'embedded-pager'
      : 'modal'
  }

  private finishPermission(decision: AskPermissionDecision): void {
    const active = this.active
    if (!active || active.mode !== 'permission') return
    this.active = undefined
    this.close(active)
    active.resolve(decision)
  }

  private acceptQuestionSelection(
    active: QuestionSession,
    selection: AskUserQuestionSelection,
  ): void {
    active.selections.push(selection)
    const nextIndex = active.state.qIndex + 1
    if (nextIndex >= active.questions.length) {
      this.finishQuestion({
        kind: 'answered',
        selections: active.selections,
      })
      return
    }
    active.state = createQuestionPickerState(
      active.questions,
      nextIndex,
    )
    this.options.requestRender()
  }

  private startCustomQuestionInput(active: QuestionSession): void {
    const input = new Input()
    input.focused = this.focused
    input.onEscape = () => {
      if (this.active !== active) return
      input.focused = false
      active.customInput = undefined
      active.state = {
        ...active.state,
        notice: 'custom answer cancelled — pick an option or try again',
      }
      this.options.requestRender()
    }
    input.onSubmit = (value) => {
      if (this.active !== active) return
      const text = value.trim()
      input.focused = false
      active.customInput = undefined
      if (!text) {
        active.state = {
          ...active.state,
          notice: 'nothing typed — pick an option or type an answer',
        }
        this.options.requestRender()
        return
      }
      this.acceptQuestionSelection(active, {
        selected: [text],
        custom: true,
      })
    }
    active.customInput = input
    this.options.requestRender()
  }

  private finishQuestion(outcome: AskUserQuestionOutcome): void {
    const active = this.active
    if (!active || active.mode !== 'question') return
    this.active = undefined
    this.close(active)
    active.resolve(outcome)
  }

  private finishPicker(result: ArrowPickResult): void {
    const active = this.active
    if (!isPickerSession(active)) return
    this.active = undefined
    this.close(active)
    active.resolve(result)
  }

  private replaceCatalog(
    session: CatalogSession,
    update: RetainedCatalogOverlayUpdate,
  ): boolean {
    if (this.active !== session) return false
    if (
      update.key !== session.identity.key ||
      update.sessionId !== session.identity.sessionId ||
      update.cwd !== session.identity.cwd
    ) {
      this.finishCatalog(session, {
        ok: false,
        reason: 'cancel',
        message: 'stale request',
      })
      return false
    }
    session.phase = 'result'
    session.items = [...update.items]
    session.index = 0
    if (update.title !== undefined) session.title = update.title
    session.emptyMessage = update.emptyMessage
    this.options.requestRender()
    return true
  }

  private finishCatalog(
    session: CatalogSession,
    result: ArrowPickResult,
  ): boolean {
    if (this.active !== session) return false
    this.active = undefined
    this.close(session)
    session.resolve(result)
    return true
  }

  private detachAbort(active: OverlaySession): void {
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener('abort', active.onAbort)
    }
  }

  private finishDiff(result: RetainedDiffOverlayResult): void {
    const active = this.active
    if (!active || active.mode !== 'diff') return
    this.active = undefined
    this.close(active)
    active.resolve(result)
  }

  private finishPager(
    reason: Exclude<RuntimePagerSuccess['reason'], 'single-page'>,
  ): void {
    const active = this.active
    if (!active || active.mode !== 'pager') return
    this.active = undefined
    this.close(active)
    active.resolve({
      ok: true,
      reason,
      page: active.page,
      pageCount: active.pageCount,
    })
  }
}

function toRuntimePagerKey(key: string): RuntimePagerKey {
  if (key === 'ctrl-c') return 'ctrl-c'
  if (key === 'eof') return 'eof'
  if (key === 'esc' || key === 'q' || key === 'Q') return 'quit'
  if (
    key === 'down' ||
    key === 'right' ||
    key === 'pageDown' ||
    key === 'n' ||
    key === 'N' ||
    key === 'j' ||
    key === 'l' ||
    key === ' '
  ) {
    return 'next'
  }
  if (
    key === 'up' ||
    key === 'left' ||
    key === 'pageUp' ||
    key === 'p' ||
    key === 'P' ||
    key === 'k' ||
    key === 'h' ||
    key === 'b' ||
    key === 'B'
  ) {
    return 'previous'
  }
  return 'none'
}
