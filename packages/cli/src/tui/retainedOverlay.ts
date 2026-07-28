import {
  type Component,
  type Focusable,
  type OverlayHandle,
} from '@earendil-works/pi-tui/dist/tui.js'
import { parseKey } from '@earendil-works/pi-tui/dist/keys.js'
import type { CliTuiOverlayState } from '../../../shared/src/index.ts'
import type {
  AskPermissionDecision,
  AskPermissionRequest,
} from './askPermissionTty.ts'
import {
  applyPermissionPanelKey,
  formatPermissionPanelScreen,
} from './permissionPanel.ts'

type PermissionSession = {
  mode: 'permission'
  request: AskPermissionRequest
  index: number
  resolve: (decision: AskPermissionDecision) => void
  signal?: AbortSignal
  onAbort?: () => void
  onInterrupt?: () => void
}

type OverlaySession = PermissionSession

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

  cancel(): void {
    if (this.active?.mode === 'permission') {
      this.finishPermission('deny')
    }
  }

  handleInput(data: string): void {
    const active = this.active
    if (!active) return
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
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const active = this.active
    if (!active) return []
    if (active.mode === 'permission') {
      return formatPermissionPanelScreen(active.request, active.index, {
        columns: width,
        color: this.options.color,
      }).split('\n')
    }
    return []
  }

  private finishPermission(decision: AskPermissionDecision): void {
    const active = this.active
    if (!active || active.mode !== 'permission') return
    this.active = undefined
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener('abort', active.onAbort)
    }
    this.options.setOverlayState({ mode: 'none' })
    this.handle?.setHidden(true)
    this.options.setInputEnabled(this.options.shouldKeepInput())
    this.options.requestRender()
    active.resolve(decision)
  }
}
