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
import { resolveTuiFrameWidth } from './frame.ts'
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

function divider(width: number, palette: Palette, ascii: boolean): string {
  const line = ascii
    ? '-'.repeat(width)
    : `╶${'─'.repeat(Math.max(0, width - 2))}╴`
  return paint(line, 'border', palette)
}

function metadataRow(
  label: string,
  value: string,
  width: number,
  palette: Palette,
): string {
  const prefix = `  ${label.toUpperCase().padEnd(11)}`
  const prefixWidth = measureTerminalText(prefix)
  const available = Math.max(0, width - prefixWidth)
  const clipped = clipTerminalText(value, available)
  return (
    paint(prefix, 'accent', palette) +
    clipped +
    ' '.repeat(Math.max(0, available - measureTerminalText(clipped)))
  )
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

function sessionSummary(session: StatusLineSession | undefined): string {
  if (!session) return 'ready for a new task'
  const mode = session.permissionMode?.trim() || 'default'
  const effort = session.effortLevel?.trim() || 'auto'
  const count = Math.max(0, session.messages.length)
  return `${mode} mode · effort ${effort} · ${count} ${
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

function renderIdentity(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  options: {
    size: LayoutSize
    mascot: boolean
    ascii: boolean
    showHeadline: boolean
  },
): string[] {
  const lines: string[] = []
  if (options.mascot) {
    lines.push(
      ...centerTuiArt(
        selectCrystalLines(options.size, options.ascii),
        width,
      ).map((line) => paint(line, 'accent', palette)),
    )
  }
  lines.push(
    surfaceRow(
      `BOLO CODE${options.ascii ? ' | ' : ' · '}v${
        opts.version ?? '0.0.1'
      }`,
      width,
      palette,
      { tone: 'title', align: 'center' },
    ),
  )
  if (options.showHeadline) {
    lines.push(
      surfaceRow(
        opts.headline?.trim() || 'Ready',
        width,
        palette,
        { tone: 'dim', align: 'center' },
      ),
    )
  }
  return lines
}

function renderSessionRows(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  options: { compact: boolean; ascii: boolean },
): string[] {
  const separator = options.ascii ? ' | ' : ' · '
  const id = opts.sessionId?.trim() || 'new'
  const rows = [
    metadataRow('workspace', opts.cwd ?? 'unavailable', width, palette),
    metadataRow(
      'model',
      opts.model ?? 'not configured',
      width,
      palette,
    ),
    metadataRow(
      'session',
      options.compact
        ? id
        : `${id}${separator}${sessionSummary(opts.session)}`,
      width,
      palette,
    ),
  ]

  if (options.compact && opts.session) {
    rows.push(metadataRow('state', sessionSummary(opts.session), width, palette))
  }
  const preview = cleanPreview(opts.messagePreview)
  if (preview) rows.push(metadataRow('recent', preview, width, palette))
  return rows
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
  const compact = options.size === 'compact'
  const hint =
    opts.hint ??
    (compact
      ? '/help · /provider'
      : '/help commands · /provider model · /permissions access')
  const projectedHint = options.ascii
    ? hint.replace(/·/gu, '|')
    : hint
  const output = renderIdentity(opts, width, palette, {
    ...options,
    showHeadline: !compact,
  })
  output.push(
    divider(width, palette, options.ascii),
    ...renderSessionRows(opts, width, palette, {
      compact,
      ascii: options.ascii,
    }),
    divider(width, palette, options.ascii),
    surfaceRow(
      `  ${projectedHint}`,
      width,
      palette,
      { tone: 'dim' },
    ),
  )
  return output.join('\n')
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
  const width = resolveTuiFrameWidth(columns)
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
