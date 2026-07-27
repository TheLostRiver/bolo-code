import {
  measureTerminalText,
  padTerminalText,
} from './terminalText.ts'

/**
 * Remove file indentation while preserving the internal geometry of terminal
 * art. Production uses an embedded copy so the single-file CLI never depends
 * on the caller's working directory.
 */
export function normalizeTuiArt(source: string): string[] {
  const lines = source
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))

  while (lines.length && !lines[0]!.trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()

  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^[ \t]*/u)?.[0].length ?? 0)
  const commonIndent = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(commonIndent))
}

export const BOLO_CRYSTAL_UNICODE_LINES = Object.freeze(
  normalizeTuiArt(String.raw`
◢          ──◆──          ◣

        ╱╲
      ╱╱  ╲
    ╱╱  ╲  ╲
   ╱  ╲  ║  ╲
  ╱    ╲ ║ ╲  ╲
 ╱  ╲  ╔██╗ ╲  ╲
 ╲   ╲ ╚██╝  ╲ ╱
  ╲   ╲ ║  ╱
   ╲   ╲║ ╱        ◥
    ╲   ║╱
     ╲  ║
      ╲_▼
`),
)

export const BOLO_CRYSTAL_MEDIUM_LINES = Object.freeze([
  BOLO_CRYSTAL_UNICODE_LINES[0]!,
  '',
  '    ╱╲',
  '  ╱╔██╗╲',
  ' ╱ ╚██╝ ╲',
  ' ╲  ║  ╱',
  '  ╲ ║ ╱',
  '   ╲_▼',
])

export const BOLO_CRYSTAL_COMPACT_LINES = Object.freeze([
  '    ╱╲',
  '  ╱╔██╗╲',
  ' ╱ ╚██╝ ╲',
  ' ╲  ║  ╱',
  '  ╲ ║ ╱',
  '   ╲_▼',
])

export const BOLO_CRYSTAL_ASCII_LINES = Object.freeze([
  '.          --*--          .',
  '',
  '        /\\',
  '      //  \\',
  '    //  \\  \\',
  '   /  \\  ||  \\',
  '  /    \\ || \\  \\',
  ' /  \\  [##] \\  \\',
  ' \\   \\ [##]  \\ /',
  '  \\   \\ ||  /',
  '   \\   \\|| /',
  '    \\   ||/',
  '     \\  ||',
  '      \\_V',
])

export const BOLO_CRYSTAL_ASCII_COMPACT_LINES = Object.freeze([
  '    /\\',
  '  /[##]\\',
  ' / [##] \\',
  ' \\  ||  /',
  '  \\ || /',
  '   \\_V',
])

export function shouldUseAsciiCrystal(options?: {
  ascii?: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  if (options?.ascii != null) return options.ascii
  const raw = options?.env?.BOLO_ASCII?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

/**
 * Center a whole art block, not each row independently. Padding every source
 * row to the block width keeps the original slants aligned.
 */
export function centerTuiArt(
  lines: readonly string[],
  width: number,
): string[] {
  const available = Math.max(1, Math.floor(width))
  const blockWidth = Math.min(
    available,
    Math.max(0, ...lines.map(measureTerminalText)),
  )
  const left = Math.floor((available - blockWidth) / 2)
  const right = available - blockWidth - left
  return lines.map(
    (line) =>
      `${' '.repeat(left)}${padTerminalText(line, blockWidth)}${' '.repeat(right)}`,
  )
}
