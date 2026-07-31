import {
  CURSOR_MARKER,
  parseKey,
  type Component,
  type Focusable,
} from './piCompat.ts'
import type { SlashCommandCandidate } from '../../../core/src/index.ts'
import type { CliTuiComposerMode } from '../../../shared/src/index.ts'
import {
  applyTuiInputKey,
  configureTuiInputState,
  createTuiInputState,
  insertTuiInputText,
  renderTuiInputBox,
  renderTuiInputFooter,
  type ReadTuiInputResult,
  type TuiInputKey,
  type TuiInputState,
  type TuiInputStatus,
} from './inputBox.ts'

const BRACKETED_PASTE_START = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'
const MAX_UNDO_SNAPSHOTS = 100

export type RetainedComposerConfig = {
  history?: readonly string[]
  slashCandidates?: readonly SlashCommandCandidate[]
  status?: TuiInputStatus
}

type PendingInput = {
  resolve: (result: ReadTuiInputResult) => void
  signal?: AbortSignal
  onAbort: () => void
}

function cloneStatus(status: TuiInputStatus | undefined): TuiInputStatus | undefined {
  if (!status) return undefined
  return {
    ...status,
    ...(status.usage ? { usage: { ...status.usage } } : {}),
  }
}

function decodeTuiInputKey(data: string): {
  id?: string
  key: TuiInputKey
} {
  const id = parseKey(data)
  if (!id) return { key: { sequence: data } }

  let name = id
  let ctrl = false
  let shift = false
  let meta = false
  while (true) {
    const modifier = /^(ctrl|shift|alt|super)\+/u.exec(name)?.[1]
    if (!modifier) break
    name = name.slice(modifier.length + 1)
    if (modifier === 'ctrl') ctrl = true
    else if (modifier === 'shift') shift = true
    else meta = true
  }
  return {
    id,
    key: {
      name,
      sequence: data,
      ...(ctrl ? { ctrl: true } : {}),
      ...(shift ? { shift: true } : {}),
      ...(meta ? { meta: true } : {}),
    },
  }
}

export class RetainedComposer implements Component, Focusable {
  focused = false
  private state = createTuiInputState()
  private status: TuiInputStatus | undefined
  private mode: CliTuiComposerMode = 'editing'
  private readonly undoStack: TuiInputState[] = []
  private pending: PendingInput | undefined

  constructor(
    private readonly options: {
      color: boolean
      requestRender: () => void
      onInputSettled: () => void
      onInputMutation: () => void
      onIdleEscape: () => void
      onRunningInterrupt: () => void
      clearScreen: () => void
    },
  ) {}

  configure(config: RetainedComposerConfig): void {
    this.state = configureTuiInputState(this.state, config)
    this.status = cloneStatus(config.status)
    this.options.requestRender()
  }

  setMode(mode: CliTuiComposerMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.options.requestRender()
  }

  getMode(): CliTuiComposerMode {
    return this.mode
  }

  getState(): TuiInputState {
    return this.state
  }

  getStatus(): TuiInputStatus | undefined {
    return this.status
  }

  isReading(): boolean {
    return this.pending !== undefined
  }

  readInput(options?: { signal?: AbortSignal }): Promise<ReadTuiInputResult> {
    if (this.pending) {
      throw new Error('retained Composer already owns an input request')
    }
    if (this.mode !== 'editing') {
      throw new Error(`retained Composer cannot read input while ${this.mode}`)
    }
    return new Promise<ReadTuiInputResult>((resolve) => {
      const onAbort = () => this.finish({ type: 'aborted' })
      this.pending = {
        resolve,
        ...(options?.signal ? { signal: options.signal } : {}),
        onAbort,
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true })
      this.options.requestRender()
      if (options?.signal?.aborted) onAbort()
    })
  }

  cancelInput(): void {
    this.finish({ type: 'aborted' })
  }

  handleInput(data: string): void {
    if (!data) return
    if (this.mode === 'running') {
      const key = parseKey(data)
      if (key === 'escape' || key === 'ctrl+c') {
        this.options.onRunningInterrupt()
      }
      return
    }
    if (!this.pending || this.mode !== 'editing') return
    if (
      data.startsWith(BRACKETED_PASTE_START) &&
      data.endsWith(BRACKETED_PASTE_END)
    ) {
      const pasted = data.slice(
        BRACKETED_PASTE_START.length,
        -BRACKETED_PASTE_END.length,
      )
      const next = insertTuiInputText(this.state, pasted)
      if (next.value !== this.state.value) {
        this.pushUndo(this.state)
        this.state = next
        this.options.onInputMutation()
        this.options.requestRender()
      }
      return
    }

    const decoded = decodeTuiInputKey(data)
    if (decoded.id === 'ctrl+z' || decoded.id === 'ctrl+_') {
      this.undo()
      return
    }
    const hadSlashMenu = this.state.slashMenu !== null
    const previousValue = this.state.value
    const result = applyTuiInputKey(this.state, decoded.key)
    const valueChanged = result.state.value !== previousValue
    if (valueChanged) this.pushUndo(this.state)
    this.state = result.state
    if (
      valueChanged &&
      decoded.id !== 'up' &&
      decoded.id !== 'down'
    ) {
      this.options.onInputMutation()
    }
    if (decoded.id === 'escape' && !hadSlashMenu) {
      this.options.onIdleEscape()
    }

    if (result.action === 'submit') {
      const value = result.value ?? this.state.value
      const history = this.state.history
      const slashCandidates = this.state.slashCandidates
      this.state = createTuiInputState({ history, slashCandidates })
      this.undoStack.length = 0
      this.finish({ type: 'submit', value })
      return
    }
    if (result.action === 'exit') {
      this.finish({ type: 'exit' })
      return
    }
    if (result.action === 'clear_screen') this.options.clearScreen()
    this.options.requestRender()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const editing = this.mode === 'editing'
    return renderTuiInputBox({
      state: this.state,
      columns: width,
      status: this.status,
      color: this.options.color,
      mode: editing ? 'idle' : 'running',
      includeFooter: false,
      ...(editing && this.focused && this.pending
        ? { cursorMarker: CURSOR_MARKER }
        : {}),
    }).lines
  }

  private pushUndo(state: TuiInputState): void {
    this.undoStack.push(state)
    if (this.undoStack.length > MAX_UNDO_SNAPSHOTS) this.undoStack.shift()
  }

  private undo(): void {
    const previous = this.undoStack.pop()
    if (!previous) return
    const valueChanged = previous.value !== this.state.value
    this.state = previous
    if (valueChanged) this.options.onInputMutation()
    this.options.requestRender()
  }

  private finish(result: ReadTuiInputResult): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    pending.signal?.removeEventListener('abort', pending.onAbort)
    this.options.onInputSettled()
    this.options.requestRender()
    pending.resolve(result)
  }
}

export class RetainedComposerFooter implements Component {
  constructor(
    private readonly composer: RetainedComposer,
    private readonly color: boolean,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderTuiInputFooter({
      state: this.composer.getState(),
      columns: width,
      status: this.composer.getStatus(),
      color: this.color,
      mode: this.composer.getMode() === 'editing' ? 'idle' : 'running',
    }).lines
  }
}
