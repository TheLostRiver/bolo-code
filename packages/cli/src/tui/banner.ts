/**
 * BOLO welcome identity and the original Bolot terminal mascot.
 * P-T9 + F-T9-THEME: plain mode and mascot switches remain supported.
 */

import { resolveTuiTheme } from './theme.ts'

export type BannerOptions = {
  version?: string
  cwd?: string
  model?: string
  sessionId?: string
  plain?: boolean
  condensed?: boolean
  columns?: number
  env?: NodeJS.ProcessEnv
  /** 强制显示/隐藏吉祥物行 */
  mascot?: boolean
}

const VERSION_DEFAULT = '0.0.1'
export const NARROW_TERMINAL_COLUMNS = 80

export const BOLOT_MASCOT_LINES = [
  '      ▄██████▄',
  '   ▄██  ●  ●  ██▄',
  ' <██      ▄      ██>',
  '   ██   ╰───╯   ██',
  '    ▀██▄▄▄▄▄▄██▀',
  '       ▀████▀',
] as const

const BANNER_ART = [
  'BOLO CODE',
  ...BOLOT_MASCOT_LINES,
  'Bolot · context puffer',
].join('\n')

const BANNER_ART_NO_MASCOT = 'BOLO CODE'

export function getTerminalColumns(opts?: {
  columns?: number
  env?: NodeJS.ProcessEnv
  stdoutColumns?: number
}): number {
  if (typeof opts?.columns === 'number' && opts.columns > 0) {
    return Math.floor(opts.columns)
  }
  const sc =
    opts?.stdoutColumns ??
    (typeof process.stdout?.columns === 'number'
      ? process.stdout.columns
      : undefined)
  if (typeof sc === 'number' && sc > 0) return sc
  // COLUMNS is a useful non-TTY fallback, but wrappers can leave it stale.
  // A live terminal's reported width is authoritative.
  const env = opts?.env ?? process.env
  const fromEnv = Number(env.COLUMNS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return 120
}

export function isNarrowTerminal(opts?: {
  columns?: number
  env?: NodeJS.ProcessEnv
  threshold?: number
}): boolean {
  const th = opts?.threshold ?? NARROW_TERMINAL_COLUMNS
  return getTerminalColumns(opts) < th
}

export function shouldUsePlainBanner(options?: {
  plain?: boolean
  env?: NodeJS.ProcessEnv
  columns?: number
}): boolean {
  if (options?.plain === true) return true
  if (options?.plain === false) return false
  const env = options?.env ?? process.env
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true
  if (env.BOLO_PLAIN === '1' || env.BOLO_PLAIN === 'true') return true
  const theme = resolveTuiTheme({ env })
  if (theme.id === 'plain') return true
  if (isNarrowTerminal({ columns: options?.columns, env })) return true
  return false
}

export function renderWelcomeBanner(options: BannerOptions = {}): string {
  const version = options.version ?? VERSION_DEFAULT
  const env = options.env ?? process.env
  const theme = resolveTuiTheme({ env, mascot: options.mascot })
  const plain = shouldUsePlainBanner({
    plain: options.plain,
    env,
    columns: options.columns,
  })

  if (options.condensed || plain) {
    const parts = ['BOLO']
    if (options.sessionId) parts.push(`session ${options.sessionId}`)
    else parts.push(`v${version}`)
    if (options.model) parts.push(options.model)
    return parts.join(' · ')
  }

  const info: string[] = [`v${version}`]
  if (options.cwd) info.push(options.cwd)
  if (options.model) info.push(`model ${options.model}`)
  if (options.sessionId) info.push(`session ${options.sessionId}`)

  const art = theme.mascot ? BANNER_ART : BANNER_ART_NO_MASCOT
  return `${art}\n${info.join('  ·  ')}`
}
