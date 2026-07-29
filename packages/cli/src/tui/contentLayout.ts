export const TUI_CONTENT_GUTTER_CELLS = 4

function normalizeColumns(columns = 80): number {
  return Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80
}

export function resolveTuiContentGutter(columns = 80): number {
  const normalized = normalizeColumns(columns)
  if (normalized < 32) return 0
  if (normalized < 48) return 2
  return TUI_CONTENT_GUTTER_CELLS
}
