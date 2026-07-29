import type {
  CliCommandPanelState,
  CliCommandSurfaceAction,
  CliCommandSurfaceState,
  CliCommandSurfaceToken,
  CliCommandToastState,
} from '../../../shared/src/index.ts'

export type CliCommandSurfaceTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

type ActiveTimer = CliCommandSurfaceToken & {
  handle: unknown
  delayMs: number
}

function sameTimer(
  timer: ActiveTimer | undefined,
  value:
    | (CliCommandPanelState & { ttlMs?: number })
    | CliCommandToastState
    | undefined,
): boolean {
  if (!timer || !value) return false
  return (
    timer.key === value.key &&
    timer.generation === value.generation &&
    timer.delayMs === value.ttlMs
  )
}

export class CliCommandSurfaceEffect {
  private panelTimer: ActiveTimer | undefined
  private toastTimer: ActiveTimer | undefined

  constructor(
    private readonly dispatch: (action: CliCommandSurfaceAction) => void,
    private readonly timers: CliCommandSurfaceTimers,
  ) {}

  sync(state: CliCommandSurfaceState): void {
    this.panelTimer = this.syncTimer(
      'panel',
      this.panelTimer,
      state.panel,
    )
    this.toastTimer = this.syncTimer(
      'toast',
      this.toastTimer,
      state.toast,
    )
  }

  dispose(): void {
    this.cancel(this.panelTimer)
    this.cancel(this.toastTimer)
    this.panelTimer = undefined
    this.toastTimer = undefined
  }

  private syncTimer(
    kind: 'panel' | 'toast',
    active: ActiveTimer | undefined,
    value:
      | (CliCommandPanelState & { ttlMs?: number })
      | CliCommandToastState
      | undefined,
  ): ActiveTimer | undefined {
    if (sameTimer(active, value)) return active
    this.cancel(active)
    const delayMs = value?.ttlMs
    if (!value || delayMs === undefined) return undefined

    const token = {
      key: value.key,
      generation: value.generation,
    }
    const handle = this.timers.setTimeout(() => {
      const current =
        kind === 'panel' ? this.panelTimer : this.toastTimer
      if (
        current?.key !== token.key ||
        current.generation !== token.generation
      ) {
        return
      }
      this.timers.clearTimeout(current.handle)
      if (kind === 'panel') this.panelTimer = undefined
      else this.toastTimer = undefined
      this.dispatch({
        type: kind === 'panel' ? 'expire_panel' : 'expire_toast',
        ...token,
      })
    }, delayMs)
    return { ...token, handle, delayMs }
  }

  private cancel(timer: ActiveTimer | undefined): void {
    if (timer) this.timers.clearTimeout(timer.handle)
  }
}

export function createDefaultCliCommandSurfaceTimers(): CliCommandSurfaceTimers {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}
