/**
 * F-T9-THEME：主题 + 吉祥物开关（env/config，无遥测）
 */

export type TuiThemeId = 'default' | 'plain' | 'dim'

export type ResolveTuiThemeOptions = {
  env?: NodeJS.ProcessEnv
  /** 显式主题 */
  theme?: TuiThemeId | string
  /** 吉祥物：默认 true；BOLO_MASCOT=0 关 */
  mascot?: boolean
}

export type TuiTheme = {
  id: TuiThemeId
  mascot: boolean
  ansi: boolean
}

export function resolveTuiTheme(opts?: ResolveTuiThemeOptions): TuiTheme {
  const env = opts?.env ?? process.env
  let id: TuiThemeId = 'default'
  const raw = (opts?.theme ?? env.BOLO_THEME ?? 'default').toString().trim().toLowerCase()
  if (raw === 'plain' || raw === 'simple') id = 'plain'
  else if (raw === 'dim' || raw === 'minimal') id = 'dim'
  else id = 'default'

  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') id = 'plain'
  if (env.BOLO_PLAIN === '1' || env.BOLO_PLAIN === 'true') id = 'plain'

  let mascot = opts?.mascot
  if (mascot === undefined) {
    const m = env.BOLO_MASCOT?.trim().toLowerCase()
    if (m === '0' || m === 'false' || m === 'off' || m === 'no') mascot = false
    else mascot = true
  }

  return {
    id,
    mascot,
    ansi: id !== 'plain',
  }
}