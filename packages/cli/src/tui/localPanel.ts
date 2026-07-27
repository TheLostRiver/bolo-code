/**
 * Repaint helper for temporary panels embedded in the conversation timeline.
 *
 * The cursor is left one row below the panel after paint. Clear moves back to
 * the first owned row, erases only those rows, and never homes or clears the
 * terminal globally.
 */

export type LocalPanelPainter = {
  paint: (screen: string) => void
  clear: () => void
}

export function createLocalPanelPainter(
  writeOut: (text: string) => void,
): LocalPanelPainter {
  let lineCount = 0

  const clear = () => {
    if (lineCount === 0) return
    writeOut('\u001b[?25l')
    writeOut(`\u001b[${lineCount}A\r`)
    for (let index = 0; index < lineCount; index++) {
      writeOut('\u001b[2K')
      if (index < lineCount - 1) writeOut('\u001b[1B\r')
    }
    if (lineCount > 1) writeOut(`\u001b[${lineCount - 1}A\r`)
    writeOut('\u001b[?25h')
    lineCount = 0
  }

  return {
    paint(screen) {
      clear()
      const rendered = screen.replace(/\n+$/u, '')
      if (!rendered) return
      lineCount = rendered.split('\n').length
      writeOut(`\u001b[?25l${rendered}\n\u001b[?25h`)
    },
    clear,
  }
}
