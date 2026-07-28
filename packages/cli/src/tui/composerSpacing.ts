export const TUI_COMPOSER_TOP_GAP_ROWS = 1

/** Keep the gap inside the same erase/repaint region as the composer cursor. */
export function addTuiComposerTopGap(region: {
  lines: readonly string[]
  cursorRow: number
}): { lines: string[]; cursorRow: number } {
  const gap = Array.from({ length: TUI_COMPOSER_TOP_GAP_ROWS }, () => '')
  const lines = [...gap, ...region.lines]
  if (region.lines.length === 0) {
    return { lines, cursorRow: Math.max(0, lines.length - 1) }
  }
  const localCursorRow = Math.max(
    0,
    Math.min(region.cursorRow, region.lines.length - 1),
  )
  return {
    lines,
    cursorRow: gap.length + localCursorRow,
  }
}
