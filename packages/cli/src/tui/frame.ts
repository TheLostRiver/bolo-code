export const TUI_FRAME_MAX_COLUMNS = 160

/**
 * Shared outer width for framed CLI surfaces.
 * Wide terminals keep a two-column gutter; very narrow terminals retain the
 * existing 24-column minimum used by the raw editor.
 */
export function resolveTuiFrameWidth(columns = 80): number {
  const normalized = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : 80
  return Math.min(TUI_FRAME_MAX_COLUMNS, Math.max(24, normalized - 2))
}
