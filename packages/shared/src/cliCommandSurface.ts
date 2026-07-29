/**
 * OI-15B · renderer-neutral slash command surface state.
 *
 * Timers, terminal dimensions and components belong to CLI effects/renderers.
 * The reducer only owns one panel, one toast and monotonic generations.
 */

export type CliCommandSurfaceTone =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'

export type CliCommandPanelInput = {
  key: string
  title?: string
  content: string
  dismissOnInput: boolean
  dismissOnEscape: boolean
  ttlMs?: number
  overflow: 'compact' | 'pager'
}

export type CliCommandToastInput = {
  key: string
  content: string
  tone: CliCommandSurfaceTone
  ttlMs: number
}

export type CliCommandSurfaceToken = {
  key: string
  generation: number
}

export type CliCommandPanelState = CliCommandPanelInput &
  CliCommandSurfaceToken

export type CliCommandToastState = CliCommandToastInput &
  CliCommandSurfaceToken

export type CliCommandSurfaceState = {
  panel?: CliCommandPanelState
  toast?: CliCommandToastState
  nextGeneration: number
}

export type CliCommandSurfaceAction =
  | { type: 'show_panel'; panel: CliCommandPanelInput }
  | { type: 'dismiss_panel' }
  | ({ type: 'expire_panel' } & CliCommandSurfaceToken)
  | { type: 'show_toast'; toast: CliCommandToastInput }
  | { type: 'dismiss_toast' }
  | ({ type: 'expire_toast' } & CliCommandSurfaceToken)
  | { type: 'accepted_input' }
  | { type: 'escape' }
  | { type: 'reset' }

export function createCliCommandSurfaceState(
  nextGeneration = 1,
): CliCommandSurfaceState {
  return {
    nextGeneration: Math.max(1, Math.floor(nextGeneration)),
  }
}

function allocateGeneration(state: CliCommandSurfaceState): {
  generation: number
  nextGeneration: number
} {
  return {
    generation: state.nextGeneration,
    nextGeneration: state.nextGeneration + 1,
  }
}

function matchesToken(
  value: CliCommandSurfaceToken | undefined,
  action: CliCommandSurfaceToken,
): boolean {
  return (
    value?.key === action.key &&
    value.generation === action.generation
  )
}

export function reduceCliCommandSurfaceState(
  state: CliCommandSurfaceState,
  action: CliCommandSurfaceAction,
): CliCommandSurfaceState {
  switch (action.type) {
    case 'show_panel': {
      const allocated = allocateGeneration(state)
      return {
        ...state,
        panel: {
          ...action.panel,
          generation: allocated.generation,
        },
        nextGeneration: allocated.nextGeneration,
      }
    }
    case 'dismiss_panel':
      return state.panel ? { ...state, panel: undefined } : state
    case 'expire_panel':
      return matchesToken(state.panel, action)
        ? { ...state, panel: undefined }
        : state
    case 'show_toast': {
      const allocated = allocateGeneration(state)
      return {
        ...state,
        toast: {
          ...action.toast,
          generation: allocated.generation,
        },
        nextGeneration: allocated.nextGeneration,
      }
    }
    case 'dismiss_toast':
      return state.toast ? { ...state, toast: undefined } : state
    case 'expire_toast':
      return matchesToken(state.toast, action)
        ? { ...state, toast: undefined }
        : state
    case 'accepted_input': {
      const panel =
        state.panel?.dismissOnInput === false ? state.panel : undefined
      if (panel === state.panel && state.toast === undefined) return state
      return {
        ...state,
        panel,
        toast: undefined,
      }
    }
    case 'escape':
      return state.panel?.dismissOnEscape
        ? { ...state, panel: undefined }
        : state
    case 'reset':
      return state.panel || state.toast
        ? {
            nextGeneration: state.nextGeneration,
          }
        : state
  }
}
