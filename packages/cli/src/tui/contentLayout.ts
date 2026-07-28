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

export function resolveTuiContentColumns(columns = 80): number {
  const normalized = normalizeColumns(columns)
  return Math.max(1, normalized - resolveTuiContentGutter(normalized))
}

export type TuiContentPrefixer = {
  format(text: string): string
  reset(): void
}

export function createTuiContentPrefixer(options?: {
  columns?: number
}): TuiContentPrefixer {
  const prefix = ' '.repeat(resolveTuiContentGutter(options?.columns))
  let lineStart = true

  return {
    format(text) {
      if (!prefix || !text) return text
      let rendered = ''
      for (const char of text) {
        if (lineStart && char !== '\n' && char !== '\r') {
          rendered += prefix
          lineStart = false
        }
        rendered += char
        if (char === '\n') lineStart = true
        else if (char !== '\r') lineStart = false
      }
      return rendered
    },
    reset() {
      lineStart = true
    },
  }
}

export function prefixTuiContentBlock(
  text: string,
  options?: { columns?: number },
): string {
  return createTuiContentPrefixer(options).format(text)
}
