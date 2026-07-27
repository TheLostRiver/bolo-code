/** Compact one-time welcome panel. The live input is rendered elsewhere. */

import {
  getTerminalColumns,
  isNarrowTerminal,
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

export type InkLayoutOptions = BannerOptions &
  ResolveTuiThemeOptions & {
    session?: StatusLineSession
    /** 强制 plain 单列 */
    plain?: boolean
    /** 最近消息预览行（可选） */
    messagePreview?: string[]
    hint?: string
  }

function row(content: string, width: number): string {
  return `│${padTerminalText(content, width - 2)}│`
}

function border(
  left: string,
  right: string,
  width: number,
  label = '',
): string {
  const inner = width - 2
  const prefix = label ? `─ ${label} ` : ''
  return `${left}${prefix}${'─'.repeat(
    Math.max(0, inner - measureTerminalText(prefix)),
  )}${right}`
}

/**
 * Render a compact identity/workspace panel. It deliberately does not contain
 * an input hint that looks interactive; runRepl owns the real input box.
 */
export function renderInkLayout(opts: InkLayoutOptions = {}): string {
  const theme = resolveTuiTheme(opts)
  const plain =
    opts.plain === true ||
    isNarrowTerminal({ columns: opts.columns, env: opts.env }) ||
    theme.id === 'plain'

  if (plain) {
    const lines = [`BOLO v${opts.version ?? '0.0.1'}`]
    if (opts.cwd) lines.push(clipTerminalText(opts.cwd, getTerminalColumns(opts)))
    if (opts.model) lines.push(`model ${opts.model}`)
    return lines.join('\n')
  }

  const cols = getTerminalColumns(opts)
  const w = Math.min(112, Math.max(36, cols - 2))
  const out: string[] = [
    border('╭', '╮', w, `BOLO v${opts.version ?? '0.0.1'}`),
  ]
  if (opts.cwd) out.push(row(`  ${opts.cwd}`, w))
  const detail = [
    opts.model ? `model ${opts.model}` : '',
    opts.sessionId ? `session ${opts.sessionId}` : '',
  ]
    .filter(Boolean)
    .join('  ·  ')
  if (detail) out.push(row(`  ${detail}`, w))
  const preview = opts.messagePreview?.filter(Boolean).slice(-5) ?? []
  if (preview.length) {
    out.push(row('', w))
    for (const p of preview) {
      out.push(row(`  ${p.replace(/\s+/g, ' ')}`, w))
    }
  }
  out.push(
    border(
      '╰',
      '╯',
      w,
      clipTerminalText(opts.hint ?? '/help commands', Math.max(8, w - 8)),
    ),
  )
  return out.join('\n')
}

export type { TuiThemeId }
