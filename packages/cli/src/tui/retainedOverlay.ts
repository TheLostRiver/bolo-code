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
} from '../../../shared/src/index.ts'
import type { AskUserQuestionOutcome } from '../../../tools/src/index.ts'
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
import { wrapTerminalText } from './terminalText.ts'

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

type PickerSession = OverlaySessionBase & {
  mode: 'provider' | 'effort'
  items: ArrowPickItem[]
  title?: string
  index: number
  resolve: (result: ArrowPickResult) => void
}

type OverlaySession =
  | PermissionSession
  | QuestionSession
  | PickerSession

function decodePanelKey(data: string): string {
  const key = parseKey(data)
  if (key === 'ctrl+c') return 'ctrl-c'
  if (key === 'escape' || key === 'esc') return 'esc'
  if (key === 'enter' || key === 'return') return 'enter'
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

export class RetainedOverlayHost implements Component, Focusable {
  focused = false
  private active: OverlaySession | undefined
  private handle: OverlayHandle | undefined

  constructor(
    private readonly options: {
      color: boolean
      setOverlayState: (overlay: CliTuiOverlayState) => void
      requestRender: () => void
      setInputEnabled: (active: boolean) => void
      shouldKeepInput: () => boolean
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
    mode: 'provider' | 'effort'
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

  cancel(): void {
    if (this.active?.mode === 'permission') {
      this.finishPermission('deny')
    } else if (this.active?.mode === 'question') {
      this.finishQuestion({ kind: 'cancelled' })
    } else if (
      this.active?.mode === 'provider' ||
      this.active?.mode === 'effort'
    ) {
      this.finishPicker({
        ok: false,
        reason: 'cancel',
        message: 'cancelled',
      })
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
    if (active.mode === 'provider' || active.mode === 'effort') {
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
    }
  }

  invalidate(): void {
    if (this.active?.mode === 'question') {
      this.active.customInput?.invalidate()
    }
  }

  render(width: number): string[] {
    const active = this.active
    if (!active) return []
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
    if (active.mode === 'provider' || active.mode === 'effort') {
      return wrapPanelScreen(
        formatArrowPickerScreen(active.items, active.index, {
          title: active.title,
        }),
        width,
      )
    }
    return []
  }

  private open(overlay: CliTuiOverlayState): void {
    this.options.setOverlayState(overlay)
    this.handle?.setHidden(false)
    try {
      this.options.setInputEnabled(true)
    } catch {
      this.cancel()
      return
    }
    this.options.requestRender()
  }

  private close(active: OverlaySession): void {
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener('abort', active.onAbort)
    }
    if (active.mode === 'question' && active.customInput) {
      active.customInput.focused = false
    }
    this.options.setOverlayState({ mode: 'none' })
    this.handle?.setHidden(true)
    try {
      this.options.setInputEnabled(this.options.shouldKeepInput())
    } catch {
      // The panel result must settle even if the terminal cannot restore raw mode.
    }
    this.options.requestRender()
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
    if (
      !active ||
      (active.mode !== 'provider' && active.mode !== 'effort')
    ) {
      return
    }
    this.active = undefined
    this.close(active)
    active.resolve(result)
  }
}
