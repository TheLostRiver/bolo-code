/** One-time Bolo welcome surface. The live composer is rendered elsewhere. */

import {
  getTerminalColumns,
  type BannerOptions,
} from './banner.ts'
import {
  BOLO_CRYSTAL_ASCII_COMPACT_LINES,
  BOLO_CRYSTAL_ASCII_LINES,
  BOLO_CRYSTAL_COMPACT_LINES,
  BOLO_CRYSTAL_MEDIUM_LINES,
  BOLO_CRYSTAL_UNICODE_LINES,
  centerTuiArt,
  shouldUseAsciiCrystal,
} from './crystalLogo.ts'
import { resolveTuiWelcomeWidth } from './frame.ts'
import type { StatusLineSession } from './statusLine.ts'
import {
  resolveTuiTheme,
  type ResolveTuiThemeOptions,
  type TuiThemeId,
} from './theme.ts'
import {
  clipTerminalText,
  measureTerminalText,
  padTerminalText,
} from './terminalText.ts'

export type InkLayoutOptions = BannerOptions &
  ResolveTuiThemeOptions & {
    session?: StatusLineSession
    /** Force the unframed, append-only identity block. */
    plain?: boolean
    /** A short greeting selected by the new/resume entry point. */
    headline?: string
    /** Recently restored session context. */
    messagePreview?: string[]
    hint?: string
  }

type Tone = 'normal' | 'title' | 'accent' | 'dim' | 'border'
type Align = 'left' | 'center'
type Palette = Record<Exclude<Tone, 'normal'> | 'reset', string>
type LayoutSize = 'wide' | 'medium' | 'compact'

const MIN_FRAMED_COLUMNS = 38
const MEDIUM_LAYOUT_COLUMNS = 56
const WIDE_LAYOUT_COLUMNS = 96

function createPalette(options: {
  ansi: boolean
  dimTheme: boolean
}): Palette {
  if (!options.ansi) {
    return { title: '', accent: '', dim: '', border: '', reset: '' }
  }
  const accent = options.dimTheme ? '\u001b[38;5;250m' : '\u001b[38;5;81m'
  return {
    title: `\u001b[1m${accent}`,
    accent,
    dim: '\u001b[2m',
    border: '\u001b[38;5;244m',
    reset: '\u001b[0m',
  }
}

function paint(text: string, tone: Tone, palette: Palette): string {
  if (tone === 'normal' || !palette[tone]) return text
  return `${palette[tone]}${text}${palette.reset}`
}

function surfaceRow(
  text: string,
  width: number,
  palette: Palette,
  options: { tone?: Tone; align?: Align } = {},
): string {
  const clipped = clipTerminalText(text, width)
  if (options.align !== 'center') {
    return paint(
      padTerminalText(clipped, width),
      options.tone ?? 'normal',
      palette,
    )
  }
  const remaining = Math.max(0, width - measureTerminalText(clipped))
  const left = Math.floor(remaining / 2)
  const body = `${' '.repeat(left)}${clipped}${' '.repeat(
    remaining - left,
  )}`
  return paint(body, options.tone ?? 'normal', palette)
}

type PanelCell = {
  text: string
  tone?: Tone
  align?: Align
}

type PanelBorder = {
  horizontal: string
  vertical: string
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  bottomTee: string
}

function resolvePanelBorder(ascii: boolean): PanelBorder {
  if (ascii) {
    return {
      horizontal: '-',
      vertical: '|',
      topLeft: '+',
      topRight: '+',
      bottomLeft: '+',
      bottomRight: '+',
      bottomTee: '+',
    }
  }
  return {
    horizontal: '─',
    vertical: '│',
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    bottomTee: '┴',
  }
}

function renderTopBorder(
  width: number,
  title: string,
  palette: Palette,
  border: PanelBorder,
): string {
  const innerWidth = Math.max(0, width - 2)
  const prefixWidth = innerWidth >= measureTerminalText(title) + 4 ? 2 : 0
  const clippedTitle = clipTerminalText(
    title,
    Math.max(0, innerWidth - prefixWidth),
  )
  const suffixWidth = Math.max(
    0,
    innerWidth - prefixWidth - measureTerminalText(clippedTitle),
  )
  return (
    paint(
      `${border.topLeft}${border.horizontal.repeat(prefixWidth)}`,
      'border',
      palette,
    ) +
    paint(clippedTitle, 'title', palette) +
    paint(
      `${border.horizontal.repeat(suffixWidth)}${border.topRight}`,
      'border',
      palette,
    )
  )
}

function renderBottomBorder(
  width: number,
  palette: Palette,
  border: PanelBorder,
  split?: { left: number; right: number },
): string {
  const body = split
    ? `${border.horizontal.repeat(split.left)}${border.bottomTee}${border.horizontal.repeat(split.right)}`
    : border.horizontal.repeat(Math.max(0, width - 2))
  return paint(
    `${border.bottomLeft}${body}${border.bottomRight}`,
    'border',
    palette,
  )
}

function renderPanelCell(
  cell: PanelCell,
  width: number,
  palette: Palette,
): string {
  const padding = width >= 2 ? 1 : 0
  const contentWidth = Math.max(0, width - padding * 2)
  const body = surfaceRow(cell.text, contentWidth, palette, {
    tone: cell.tone,
    align: cell.align,
  })
  return `${' '.repeat(padding)}${body}${' '.repeat(padding)}`
}

function metadataCell(
  label: string,
  value: string,
  width: number,
  palette: Palette,
): PanelCell {
  const prefix = ` ${label.toUpperCase().padEnd(10)}`
  const prefixWidth = measureTerminalText(prefix)
  const available = Math.max(0, width - prefixWidth)
  const clipped = clipTerminalText(value, available)
  return {
    text: paint(prefix, 'accent', palette) + clipped,
  }
}

function cleanPreview(preview: string[] | undefined): string {
  return (
    preview
      ?.filter(Boolean)
      .slice(-1)[0]
      ?.replace(/\s+/gu, ' ')
      .trim() ?? ''
  )
}

function sessionSummary(
  session: StatusLineSession | undefined,
  ascii = false,
): string {
  if (!session) return 'new session'
  const mode = session.permissionMode?.trim() || 'default'
  const effort = session.effortLevel?.trim() || 'auto'
  const count = Math.max(0, session.messages.length)
  const separator = ascii ? ' | ' : ' · '
  return `${mode} mode${separator}effort ${effort}${separator}${count} ${
    count === 1 ? 'message' : 'messages'
  }`
}

function selectCrystalLines(
  size: LayoutSize,
  ascii: boolean,
): readonly string[] {
  if (ascii) {
    return size === 'wide'
      ? BOLO_CRYSTAL_ASCII_LINES
      : BOLO_CRYSTAL_ASCII_COMPACT_LINES
  }
  if (size === 'wide') return BOLO_CRYSTAL_UNICODE_LINES
  if (size === 'medium') return BOLO_CRYSTAL_MEDIUM_LINES
  return BOLO_CRYSTAL_COMPACT_LINES
}

function projectSeparators(text: string, ascii: boolean): string {
  return ascii ? text.replace(/·/gu, '|') : text
}

function createStatusCells(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  options: {
    compact: boolean
    relaxed: boolean
    ascii: boolean
    centered: boolean
  },
): PanelCell[] {
  const id = opts.sessionId?.trim() || 'new'
  const hint =
    opts.hint ??
    (options.compact
      ? '/help · /provider'
      : '/help commands · /provider model · /permissions access')
  const cells: PanelCell[] = [
    {
      text: opts.headline?.trim() || 'Ready',
      tone: 'title',
      align: options.centered ? 'center' : 'left',
    },
  ]
  if (!options.compact) {
    cells.push({
      text: sessionSummary(opts.session, options.ascii),
      tone: 'dim',
      align: options.centered ? 'center' : 'left',
    })
  }
  if (options.relaxed) cells.push({ text: '' })
  cells.push(
    metadataCell(
      'workspace',
      opts.cwd ?? 'unavailable',
      width,
      palette,
    ),
    metadataCell(
      'model',
      opts.model ?? 'not configured',
      width,
      palette,
    ),
    metadataCell(
      'session',
      id,
      width,
      palette,
    ),
  )
  const preview = cleanPreview(opts.messagePreview)
  if (preview) {
    cells.push(metadataCell('recent', preview, width, palette))
  }
  if (options.relaxed) cells.push({ text: '' })
  cells.push({
    text: projectSeparators(hint, options.ascii),
    tone: 'dim',
    align: options.centered ? 'center' : 'left',
  })
  return cells
}

function centerPanelCells(
  cells: PanelCell[],
  height: number,
): PanelCell[] {
  const missing = Math.max(0, height - cells.length)
  const top = Math.floor(missing / 2)
  const bottom = missing - top
  return [
    ...Array.from({ length: top }, () => ({ text: '' })),
    ...cells,
    ...Array.from({ length: bottom }, () => ({ text: '' })),
  ]
}

function renderSinglePanel(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  options: {
    size: LayoutSize
    mascot: boolean
    ascii: boolean
    border: PanelBorder
    title: string
  },
): string {
  const innerWidth = Math.max(1, width - 2)
  const contentWidth = Math.max(1, innerWidth - 2)
  const cells: PanelCell[] = []
  if (options.mascot) {
    cells.push(
      ...centerTuiArt(
        selectCrystalLines(options.size, options.ascii),
        contentWidth,
      ).map((text) => ({ text, tone: 'accent' as const })),
    )
  }
  cells.push(
    ...createStatusCells(opts, contentWidth, palette, {
      compact: options.size === 'compact',
      relaxed: false,
      ascii: options.ascii,
      centered: true,
    }),
  )
  const vertical = paint(options.border.vertical, 'border', palette)
  return [
    renderTopBorder(width, options.title, palette, options.border),
    ...cells.map(
      (cell) =>
        `${vertical}${renderPanelCell(cell, innerWidth, palette)}${vertical}`,
    ),
    renderBottomBorder(width, palette, options.border),
  ].join('\n')
}

function renderSplitPanel(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  options: {
    ascii: boolean
    border: PanelBorder
    title: string
  },
): string {
  const contentWidth = Math.max(2, width - 3)
  const preferredLeft = Math.min(
    40,
    Math.max(32, Math.floor(contentWidth * 0.38)),
  )
  const leftWidth = Math.min(
    preferredLeft,
    Math.max(1, contentWidth - 36),
  )
  const rightWidth = Math.max(1, contentWidth - leftWidth)
  const leftContentWidth = Math.max(1, leftWidth - 2)
  const rightContentWidth = Math.max(1, rightWidth - 2)
  const leftCells: PanelCell[] = centerTuiArt(
    selectCrystalLines('wide', options.ascii),
    leftContentWidth,
  ).map((text) => ({ text, tone: 'accent' }))
  const rightCells = createStatusCells(opts, rightContentWidth, palette, {
    compact: false,
    relaxed: true,
    ascii: options.ascii,
    centered: false,
  })
  const height = Math.max(leftCells.length, rightCells.length)
  const left = centerPanelCells(leftCells, height)
  const right = centerPanelCells(rightCells, height)
  const vertical = paint(options.border.vertical, 'border', palette)
  const rows = Array.from({ length: height }, (_, index) => {
    const leftCell = left[index] ?? { text: '' }
    const rightCell = right[index] ?? { text: '' }
    return (
      vertical +
      renderPanelCell(leftCell, leftWidth, palette) +
      vertical +
      renderPanelCell(rightCell, rightWidth, palette) +
      vertical
    )
  })
  return [
    renderTopBorder(width, options.title, palette, options.border),
    ...rows,
    renderBottomBorder(width, palette, options.border, {
      left: leftWidth,
      right: rightWidth,
    }),
  ].join('\n')
}

function renderStructuredLayout(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  options: {
    size: LayoutSize
    mascot: boolean
    ascii: boolean
  },
): string {
  const border = resolvePanelBorder(options.ascii)
  const title = ` BOLO CODE${options.ascii ? ' | ' : ' · '}v${
    opts.version ?? '0.0.1'
  } `
  if (options.size === 'wide' && options.mascot) {
    return renderSplitPanel(opts, width, palette, {
      ascii: options.ascii,
      border,
      title,
    })
  }
  return renderSinglePanel(opts, width, palette, {
    ...options,
    border,
    title,
  })
}

function renderPlainLayout(
  opts: InkLayoutOptions,
  columns: number,
): string {
  const lines = [`BOLO v${opts.version ?? '0.0.1'}`]
  if (opts.cwd) lines.push(opts.cwd)
  if (opts.model) lines.push(`model ${opts.model}`)
  if (opts.sessionId) lines.push(`session ${opts.sessionId}`)
  return lines
    .map((line) => clipTerminalText(line, Math.max(1, columns)))
    .join('\n')
}

function usesExplicitPlainLayout(
  opts: InkLayoutOptions,
  env: NodeJS.ProcessEnv,
): boolean {
  if (opts.plain === true) return true
  if (env.BOLO_PLAIN === '1' || env.BOLO_PLAIN === 'true') return true
  const requestedTheme = String(opts.theme ?? env.BOLO_THEME ?? '')
    .trim()
    .toLowerCase()
  return requestedTheme === 'plain' || requestedTheme === 'simple'
}

export function renderInkLayout(opts: InkLayoutOptions = {}): string {
  const env = opts.env ?? process.env
  const columns = getTerminalColumns({ columns: opts.columns, env })
  if (
    columns < MIN_FRAMED_COLUMNS ||
    usesExplicitPlainLayout(opts, env)
  ) {
    return renderPlainLayout(opts, columns)
  }

  const theme = resolveTuiTheme({ ...opts, env })
  const palette = createPalette({
    ansi: theme.ansi,
    dimTheme: theme.id === 'dim',
  })
  const width = resolveTuiWelcomeWidth(columns)
  const size: LayoutSize =
    columns >= WIDE_LAYOUT_COLUMNS
      ? 'wide'
      : columns >= MEDIUM_LAYOUT_COLUMNS
        ? 'medium'
        : 'compact'

  return renderStructuredLayout(opts, width, palette, {
    size,
    mascot: theme.mascot,
    ascii: shouldUseAsciiCrystal({ ascii: opts.ascii, env }),
  })
}

export type { TuiThemeId }
