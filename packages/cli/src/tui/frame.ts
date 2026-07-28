export const TUI_FRAME_MAX_COLUMNS = 160
export const TUI_WELCOME_MAX_COLUMNS = 100

/**
 * Shared outer width for content-oriented CLI surfaces.
 * Wide terminals keep a two-column gutter; very narrow terminals retain the
 * existing 24-column minimum used by the raw editor.
 */
export function resolveTuiFrameWidth(columns = 80): number {
  const normalized = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : 80
  return Math.min(TUI_FRAME_MAX_COLUMNS, Math.max(24, normalized - 2))
}

/**
 * One-time welcome surface width. The workbench stays compact on ultra-wide
 * terminals while content pages retain the larger shared frame.
 */
export function resolveTuiWelcomeWidth(columns = 80): number {
  return Math.min(TUI_WELCOME_MAX_COLUMNS, resolveTuiFrameWidth(columns))
}

/**
 * Bottom composer/dock width. Unlike capped content and welcome surfaces, the
 * dock follows the terminal.
 */
export function resolveTuiDockWidth(columns = 80): number {
  const normalized = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : 80
  return Math.max(24, normalized - 2)
}
