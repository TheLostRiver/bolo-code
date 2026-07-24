/**
 * BOLO 欢迎 banner（原创 Bolot 吉祥物，不抄第三方 IP）
 * plain / NO_COLOR / 窄终端 → 单行 BOLO
 * P-T9-NARROW：columns < 阈值时自动 plain（非完整 Ink）。
 */

export type BannerOptions = {
  version?: string
  cwd?: string
  model?: string
  sessionId?: string
  /** 强制 plain（单行） */
  plain?: boolean
  /** 缩略一行（resume 后） */
  condensed?: boolean
  /** 终端列数；省略则读 process.stdout.columns / COLUMNS */
  columns?: number
  env?: NodeJS.ProcessEnv
}

const VERSION_DEFAULT = '0.0.1'

/** 窄终端阈值：低于此列数用 plain banner（P-T9） */
export const NARROW_TERMINAL_COLUMNS = 80

/** 多行 ASCII 字标 + 小 Bolot（河豚/气球鱼，原创） */
const BANNER_ART = `
 ____   ___  _      ___  
| __ ) / _ \\| |    / _ \\ 
|  _ \\| | | | |   | | | |
| |_) | |_| | |___| |_| |
|____/ \\___/|_____|\\___/ 
  (o)  Bolot · Bolo Code
  /|\\  puffer · balloon fish
`.trim()

/** 解析终端列数 */
export function getTerminalColumns(opts?: {
  columns?: number
  env?: NodeJS.ProcessEnv
  stdoutColumns?: number
}): number {
  if (typeof opts?.columns === 'number' && opts.columns > 0) {
    return Math.floor(opts.columns)
  }
  const env = opts?.env ?? process.env
  const fromEnv = Number(env.COLUMNS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  const sc =
    opts?.stdoutColumns ??
    (typeof process.stdout?.columns === 'number'
      ? process.stdout.columns
      : undefined)
  if (typeof sc === 'number' && sc > 0) return sc
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
  // 显式 plain: false → 全量；true → 单行；未指定 → 环境 / 窄终端
  if (options?.plain === true) return true
  if (options?.plain === false) return false
  const env = options?.env ?? process.env
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true
  if (env.BOLO_PLAIN === '1' || env.BOLO_PLAIN === 'true') return true
  if (isNarrowTerminal({ columns: options?.columns, env })) return true
  return false
}

/**
 * 渲染欢迎 banner 文本（末尾换行由调用方决定；本函数返回不带末尾多余空行的块）。
 */
export function renderWelcomeBanner(options: BannerOptions = {}): string {
  const version = options.version ?? VERSION_DEFAULT
  const plain = shouldUsePlainBanner({
    plain: options.plain,
    env: options.env,
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

  return `${BANNER_ART}\n${info.join('  ·  ')}`
}