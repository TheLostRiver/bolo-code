/** One-time branded welcome panel. The live input is rendered elsewhere. */

import {
  BOLOT_MASCOT_LINES,
  getTerminalColumns,
  type BannerOptions,
} from './banner.ts'
import type { StatusLineSession } from './statusLine.ts'
import {
  resolveTuiTheme,
  type TuiThemeId,
  type ResolveTuiThemeOptions,
} from './theme.ts'
import {
  clipTerminalText,
  measureTerminalText,
  padTerminalText,
} from './terminalText.ts'
import { resolveTuiFrameWidth } from './frame.ts'

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
type PanelLine = {
  text: string
  tone?: Tone
  align?: Align
}

type Palette = Record<Exclude<Tone, 'normal'> | 'reset', string>

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

function alignText(text: string, width: number, align: Align): string {
  const clipped = clipTerminalText(text, width)
  if (align === 'left') return padTerminalText(clipped, width)
  const remaining = Math.max(0, width - measureTerminalText(clipped))
  const left = Math.floor(remaining / 2)
  return `${' '.repeat(left)}${clipped}${' '.repeat(remaining - left)}`
}

function frameBorder(
  left: string,
  right: string,
  width: number,
  palette: Palette,
  label = '',
): string {
  const inner = width - 2
  const safeLabel = label
    ? clipTerminalText(label, Math.max(0, inner - 4))
    : ''
  const prefix = safeLabel ? `─ ${safeLabel} ` : ''
  const fill = '─'.repeat(
    Math.max(0, inner - measureTerminalText(prefix)),
  )
  return (
    paint(left, 'border', palette) +
    (prefix ? paint(prefix, 'title', palette) : '') +
    paint(`${fill}${right}`, 'border', palette)
  )
}

function contentRow(
  line: PanelLine,
  width: number,
  palette: Palette,
): string {
  const body = alignText(line.text, width - 2, line.align ?? 'left')
  return (
    paint('│', 'border', palette) +
    paint(body, line.tone ?? 'normal', palette) +
    paint('│', 'border', palette)
  )
}

function twoColumnRow(
  left: PanelLine,
  right: PanelLine,
  leftWidth: number,
  rightWidth: number,
  palette: Palette,
): string {
  const leftBody = alignText(
    left.text,
    leftWidth,
    left.align ?? 'left',
  )
  const rightBody = alignText(
    right.text,
    rightWidth,
    right.align ?? 'left',
  )
  return (
    paint('│', 'border', palette) +
    paint(leftBody, left.tone ?? 'normal', palette) +
    paint('│', 'border', palette) +
    paint(rightBody, right.tone ?? 'normal', palette) +
    paint('│', 'border', palette)
  )
}

function cleanPreview(preview: string[] | undefined): string {
  return (
    preview
      ?.filter(Boolean)
      .slice(-1)[0]
      ?.replace(/\s+/g, ' ')
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

function renderWideLayout(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  mascot: boolean,
): string {
  const inner = width - 2
  const leftWidth = Math.max(
    32,
    Math.min(42, Math.floor(inner * 0.32)),
  )
  const rightWidth = inner - leftWidth - 1
  const headline = opts.headline?.trim() || 'Welcome to Bolo Code'
  const art: PanelLine[] = mascot
    ? BOLOT_MASCOT_LINES.map((text) => ({
        text,
        tone: 'accent',
        align: 'center',
      }))
    : [{ text: 'B O L O   C O D E', tone: 'title', align: 'center' }]
  const left: PanelLine[] = [
    { text: headline, tone: 'title', align: 'center' },
    { text: '' },
    ...art,
    {
      text: mascot ? 'Bolot · context puffer' : 'Bolo Code',
      tone: 'dim',
      align: 'center',
    },
    { text: '' },
    {
      text: opts.model ? `model · ${opts.model}` : 'model · not configured',
      tone: 'dim',
      align: 'center',
    },
    {
      text: opts.cwd ? `workspace · ${opts.cwd}` : 'workspace · unavailable',
      tone: 'dim',
      align: 'center',
    },
  ]
  const preview = cleanPreview(opts.messagePreview)
  const rightDivider = `  ${'─'.repeat(Math.max(0, rightWidth - 4))}`
  const right: PanelLine[] = [
    { text: '  Start here', tone: 'title' },
    {
      text: '  Describe the task. Paste an error. Ask Bolo to investigate.',
    },
    { text: '' },
    { text: rightDivider, tone: 'border' },
    { text: '  Current session', tone: 'accent' },
    { text: `  ${sessionSummary(opts.session)}`, tone: 'dim' },
    {
      text: opts.sessionId
        ? `  session · ${opts.sessionId}`
        : '  session · new',
      tone: 'dim',
    },
    { text: preview ? `  ${preview}` : '', tone: 'dim' },
    { text: rightDivider, tone: 'border' },
    { text: '  Useful commands', tone: 'accent' },
    { text: '  /help commands · /provider model' },
    { text: '  /permissions tool access' },
  ]
  const rows = Math.max(left.length, right.length)
  while (left.length < rows) left.push({ text: '' })
  while (right.length < rows) right.push({ text: '' })

  const output = [
    frameBorder(
      '╭',
      '╮',
      width,
      palette,
      `BOLO CODE v${opts.version ?? '0.0.1'}`,
    ),
  ]
  for (let index = 0; index < rows; index++) {
    output.push(
      twoColumnRow(
        left[index]!,
        right[index]!,
        leftWidth,
        rightWidth,
        palette,
      ),
    )
  }
  output.push(frameBorder('╰', '╯', width, palette))
  return output.join('\n')
}

function renderMediumLayout(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  mascot: boolean,
): string {
  const headline = opts.headline?.trim() || 'Welcome to Bolo Code'
  const lines: string[] = [
    frameBorder(
      '╭',
      '╮',
      width,
      palette,
      `BOLO CODE v${opts.version ?? '0.0.1'}`,
    ),
    contentRow(
      { text: headline, tone: 'title', align: 'center' },
      width,
      palette,
    ),
  ]
  if (mascot) {
    for (const text of BOLOT_MASCOT_LINES) {
      lines.push(
        contentRow(
          { text, tone: 'accent', align: 'center' },
          width,
          palette,
        ),
      )
    }
    lines.push(
      contentRow(
        {
          text: 'Bolot · context puffer',
          tone: 'dim',
          align: 'center',
        },
        width,
        palette,
      ),
    )
  } else {
    lines.push(
      contentRow(
        { text: 'B O L O   C O D E', tone: 'title', align: 'center' },
        width,
        palette,
      ),
    )
  }
  lines.push(
    frameBorder('├', '┤', width, palette, 'Workspace'),
    contentRow(
      { text: `  ${opts.cwd ?? 'unavailable'}` },
      width,
      palette,
    ),
    contentRow(
      {
        text: `  model · ${opts.model ?? 'not configured'}`,
        tone: 'dim',
      },
      width,
      palette,
    ),
    contentRow(
      { text: `  ${sessionSummary(opts.session)}`, tone: 'dim' },
      width,
      palette,
    ),
  )
  if (opts.sessionId) {
    lines.push(
      contentRow(
        { text: `  session · ${opts.sessionId}`, tone: 'dim' },
        width,
        palette,
      ),
    )
  }
  const preview = cleanPreview(opts.messagePreview)
  if (preview) {
    lines.push(
      contentRow({ text: `  ${preview}`, tone: 'dim' }, width, palette),
    )
  }
  lines.push(
    frameBorder('├', '┤', width, palette, 'Start here'),
    contentRow(
      {
        text: '  Describe the task, paste an error, or ask a question.',
      },
      width,
      palette,
    ),
    contentRow(
      {
        text: `  ${opts.hint ?? '/help commands · /provider model'}`,
        tone: 'dim',
      },
      width,
      palette,
    ),
    frameBorder('╰', '╯', width, palette),
  )
  return lines.join('\n')
}

function renderCompactLayout(
  opts: InkLayoutOptions,
  width: number,
  palette: Palette,
  mascot: boolean,
): string {
  const headline = opts.headline?.trim() || 'Welcome to Bolo Code'
  const lines = [
    frameBorder(
      '╭',
      '╮',
      width,
      palette,
      `BOLO CODE v${opts.version ?? '0.0.1'}`,
    ),
    contentRow(
      { text: headline, tone: 'title', align: 'center' },
      width,
      palette,
    ),
  ]
  if (mascot) {
    lines.push(
      contentRow(
        {
          text: '<(● ᴗ ●)>  Bolot',
          tone: 'accent',
          align: 'center',
        },
        width,
        palette,
      ),
    )
  }
  lines.push(
    frameBorder('├', '┤', width, palette, 'Workspace'),
    contentRow(
      { text: `  ${opts.cwd ?? 'unavailable'}` },
      width,
      palette,
    ),
    contentRow(
      {
        text: `  model · ${opts.model ?? 'not configured'}`,
        tone: 'dim',
      },
      width,
      palette,
    ),
    contentRow(
      { text: `  ${sessionSummary(opts.session)}`, tone: 'dim' },
      width,
      palette,
    ),
    frameBorder(
      '╰',
      '╯',
      width,
      palette,
      opts.hint ?? '/help · /provider',
    ),
  )
  return lines.join('\n')
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

  if (columns >= WIDE_LAYOUT_COLUMNS) {
    return renderWideLayout(opts, width, palette, theme.mascot)
  }
  if (columns >= MEDIUM_LAYOUT_COLUMNS) {
    return renderMediumLayout(opts, width, palette, theme.mascot)
  }
  return renderCompactLayout(opts, width, palette, theme.mascot)
}

export type { TuiThemeId }
