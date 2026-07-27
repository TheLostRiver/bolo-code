/**
 * Terminal display-width helpers.
 *
 * Node does not expose wcwidth. This intentionally implements the subset the
 * CLI needs: ANSI is zero-width, combining/control code points are zero-width,
 * CJK and pictographs are two cells, everything else is one.
 */

const ANSI_PATTERN =
  /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g
const MARK_PATTERN = /^\p{Mark}+$/u
const PICTOGRAPH_PATTERN = /\p{Extended_Pictographic}/u

type SegmenterLike = {
  segment(input: string): Iterable<{ segment: string }>
}

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: 'grapheme' },
) => SegmenterLike

const Segmenter = (
  Intl as typeof Intl & { Segmenter?: SegmenterConstructor }
).Segmenter
const graphemeSegmenter = Segmenter
  ? new Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

export function stripTerminalAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function splitTerminalGraphemes(text: string): string[] {
  if (!text) return []
  if (!graphemeSegmenter) return Array.from(text)
  return Array.from(graphemeSegmenter.segment(text), (item) => item.segment)
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}

export function terminalGraphemeWidth(grapheme: string): number {
  if (!grapheme) return 0
  if (grapheme === '\n' || grapheme === '\r') return 0
  if (MARK_PATTERN.test(grapheme)) return 0
  const codePoints = Array.from(
    grapheme,
    (char) => char.codePointAt(0) ?? 0,
  )
  const regionalIndicators = codePoints.filter(
    (codePoint) => codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff,
  ).length
  if (regionalIndicators >= 2 || codePoints.includes(0x20e3)) return 2
  if (PICTOGRAPH_PATTERN.test(grapheme)) return 2

  let width = 0
  for (const codePoint of codePoints) {
    if (
      codePoint === 0 ||
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0x00 && codePoint < 0x20) ||
      (codePoint >= 0x7f && codePoint < 0xa0)
    ) {
      continue
    }
    width = Math.max(width, isWideCodePoint(codePoint) ? 2 : 1)
  }
  return width
}

export function measureTerminalText(text: string): number {
  const plain = stripTerminalAnsi(text)
  let width = 0
  for (const grapheme of splitTerminalGraphemes(plain)) {
    width += terminalGraphemeWidth(grapheme)
  }
  return width
}

export function clipTerminalText(text: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth))
  if (width === 0) return ''
  const plain = stripTerminalAnsi(text)
  if (measureTerminalText(plain) <= width) return plain
  if (width === 1) return '…'

  let out = ''
  let used = 0
  for (const grapheme of splitTerminalGraphemes(plain)) {
    const next = terminalGraphemeWidth(grapheme)
    if (used + next > width - 1) break
    out += grapheme
    used += next
  }
  return `${out}…`
}

export function padTerminalText(text: string, width: number): string {
  const clipped = clipTerminalText(text, width)
  return clipped + ' '.repeat(Math.max(0, width - measureTerminalText(clipped)))
}

export function wrapTerminalText(text: string, maxWidth: number): string[] {
  const width = Math.max(1, Math.floor(maxWidth))
  const lines: string[] = []
  let current = ''
  let used = 0

  const flush = () => {
    lines.push(current)
    current = ''
    used = 0
  }

  for (const grapheme of splitTerminalGraphemes(stripTerminalAnsi(text))) {
    if (grapheme === '\r') continue
    if (grapheme === '\n') {
      flush()
      continue
    }
    const cellWidth = terminalGraphemeWidth(grapheme)
    if (current && used + cellWidth > width) flush()
    current += grapheme
    used += cellWidth
  }
  lines.push(current)
  return lines.length ? lines : ['']
}
