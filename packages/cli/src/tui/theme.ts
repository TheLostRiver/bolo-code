/**
 * TUI 主题系统：5 主题（default=极光 / amber / neon / dim / plain）
 *
 * - 每个主题携带语义化配色 token（RGB），消费方（inputBox/transcript/
 *   banner/inkLayout）按语义取色，不再各自硬编码。
 * - 终端渲染时按 truecolor（24bit）或 256 色降级输出 ANSI（见 fmtFg/fmtBg）。
 * - plain 主题 ansi=false，palette 为空串，零 ANSI 字节。
 * - env 覆盖保持向后兼容：BOLO_THEME / BOLO_MASCOT / NO_COLOR / BOLO_PLAIN。
 */

import {
  type TuiThemeId,
} from '../../../shared/src/index.ts'

export { TUI_THEME_IDS, isTuiThemeId, type TuiThemeId } from '../../../shared/src/index.ts'

export type Rgb = readonly [number, number, number]

export type TuiPalette = {
  /** 主强调色：prompt、badge 圆点、焦点、进度条 */
  accent: Rgb
  /** 次级强调色：渐变第二色、次级高亮 */
  accent2: Rgb
  /** 输入框/面板边框 */
  border: Rgb
  /** 弱边框：分隔线、footer 间隔 */
  borderDim: Rgb
  /** badge 背景 */
  badgeBg: Rgb
  /** badge 前景文字 */
  badgeFg: Rgb
  /** badge 描边 */
  badgeBorder: Rgb
  /** 输入文字 */
  inputFg: Rgb
  /** 幽灵文本/占位（slash hint、空态） */
  ghost: Rgb
  /** 次要信息：footer 动作、进度条轨道、gutter */
  muted: Rgb
  /** mode chip 前景/背景 */
  chipFg: Rgb
  chipBg: Rgb
}

export type ResolveTuiThemeOptions = {
  env?: NodeJS.ProcessEnv
  /** 显式主题 */
  theme?: TuiThemeId | string
  /** 吉祥物：默认 true；BOLO_MASCOT=0 关 */
  mascot?: boolean
  /** truecolor 24bit；缺省按 env.COLORTERM/TERM 推断，Windows Terminal 默认 true */
  trueColor?: boolean
}

export type TuiTheme = {
  id: TuiThemeId
  mascot: boolean
  ansi: boolean
  /** 是否输出 24bit truecolor（false 时降级 256 色） */
  trueColor: boolean
  /** 语义化配色（ansi=false 时全部为空串，见 buildPaletteAnsi） */
  palette: TuiPalette
}

/* ------------------------------------------------------------------ */
/* 主题配色定义                                                        */
/* ------------------------------------------------------------------ */

const AURORA: TuiPalette = {
  accent: [45, 212, 191], // #2dd4bf teal
  accent2: [139, 92, 246], // #8b5cf6 violet
  border: [31, 138, 124], // #1f8a7c
  borderDim: [28, 74, 68], // #1c4a44
  badgeBg: [15, 61, 58], // #0f3d3a
  badgeFg: [230, 255, 250], // #e6fffa
  badgeBorder: [20, 184, 166], // #14b8a6
  inputFg: [215, 245, 239], // #d7f5ef
  ghost: [49, 84, 92], // #31545c
  muted: [109, 148, 143], // #6d948f
  chipFg: [153, 246, 228], // #99f6e4
  chipBg: [15, 61, 58], // #0f3d3a
}

const AMBER: TuiPalette = {
  accent: [251, 191, 36], // #fbbf24
  accent2: [234, 88, 12], // #ea580c
  border: [138, 95, 30], // #8a5f1e
  borderDim: [74, 58, 26], // #4a3a1a
  badgeBg: [61, 42, 8], // #3d2a08
  badgeFg: [254, 243, 199], // #fef3c7
  badgeBorder: [217, 154, 43], // #d99a2b
  inputFg: [253, 232, 200], // #fde8c8
  ghost: [95, 74, 38], // #5f4a26
  muted: [156, 132, 79], // #9c844f
  chipFg: [254, 215, 170], // #fed7aa
  chipBg: [74, 44, 13], // #4a2c0d
}

const NEON: TuiPalette = {
  accent: [232, 121, 249], // #e879f9
  accent2: [129, 140, 248], // #818cf8
  border: [124, 58, 237], // #7c3aed
  borderDim: [58, 40, 82], // #3a2852
  badgeBg: [43, 20, 80], // #2b1450
  badgeFg: [253, 244, 255], // #fdf4ff
  badgeBorder: [167, 139, 250], // #a78bfa
  inputFg: [243, 232, 255], // #f3e8ff
  ghost: [70, 52, 99], // #463463
  muted: [146, 119, 184], // #9277b8
  chipFg: [233, 213, 255], // #e9d5ff
  chipBg: [51, 26, 77], // #331a4d
}

const DIM: TuiPalette = {
  accent: [156, 163, 175], // #9ca3af
  accent2: [107, 114, 128], // #6b7280
  border: [75, 85, 99], // #4b5563
  borderDim: [55, 65, 81], // #374151
  badgeBg: [31, 41, 55], // #1f2937
  badgeFg: [209, 213, 219], // #d1d5db
  badgeBorder: [75, 85, 99], // #4b5563
  inputFg: [209, 213, 219], // #d1d5db
  ghost: [75, 85, 99], // #4b5563
  muted: [107, 114, 128], // #6b7280
  chipFg: [209, 213, 219], // #d1d5db
  chipBg: [31, 41, 55], // #1f2937
}

/** plain：无 ANSI，所有 token 空串 */
const PLAIN_PALETTE: TuiPalette = {
  accent: [0, 0, 0],
  accent2: [0, 0, 0],
  border: [0, 0, 0],
  borderDim: [0, 0, 0],
  badgeBg: [0, 0, 0],
  badgeFg: [0, 0, 0],
  badgeBorder: [0, 0, 0],
  inputFg: [0, 0, 0],
  ghost: [0, 0, 0],
  muted: [0, 0, 0],
  chipFg: [0, 0, 0],
  chipBg: [0, 0, 0],
}

const PALETTES: Record<TuiThemeId, TuiPalette> = {
  default: AURORA,
  amber: AMBER,
  neon: NEON,
  dim: DIM,
  plain: PLAIN_PALETTE,
}

export function getTuiPalette(id: TuiThemeId): TuiPalette {
  return PALETTES[id]
}

/* ------------------------------------------------------------------ */
/* ANSI 渲染：truecolor 24bit / 256 色降级                             */
/* ------------------------------------------------------------------ */

/**
 * RGB → xterm 256 色索引（标准算法：16 基础色 + 6×6×6 cube + 24 灰阶）。
 * 用于 truecolor 不可用时的降级输出。
 */
export function rgbToXterm256(rgb: Rgb): number {
  const [r, g, b] = rgb
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const cube = (v: number): number =>
    v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 55) / 40))
  return 16 + 36 * cube(r) + 6 * cube(g) + cube(b)
}

/** 前景色 ANSI：truecolor `\u001b[38;2;r;g;bm`，否则 256 色 `\u001b[38;5;Nm` */
export function fmtFg(rgb: Rgb | null, trueColor: boolean): string {
  if (!rgb) return ''
  if (trueColor) return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  return `\u001b[38;5;${rgbToXterm256(rgb)}m`
}

/** 背景色 ANSI：`\u001b[48;2;…m` / `\u001b[48;5;Nm` */
export function fmtBg(rgb: Rgb | null, trueColor: boolean): string {
  if (!rgb) return ''
  if (trueColor) return `\u001b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  return `\u001b[48;5;${rgbToXterm256(rgb)}m`
}

/**
 * 把 palette 预计算为 ANSI 字符串版本；plain（ansi=false）时全部为空串，
 * 消费方无需再判 ansi——空串即无色。
 */
export function buildPaletteAnsi(
  palette: TuiPalette,
  trueColor: boolean,
  ansi: boolean,
): Record<keyof TuiPalette, string> {
  if (!ansi) {
    return {
      accent: '',
      accent2: '',
      border: '',
      borderDim: '',
      badgeBg: '',
      badgeFg: '',
      badgeBorder: '',
      inputFg: '',
      ghost: '',
      muted: '',
      chipFg: '',
      chipBg: '',
    }
  }
  return {
    accent: fmtFg(palette.accent, trueColor),
    accent2: fmtFg(palette.accent2, trueColor),
    border: fmtFg(palette.border, trueColor),
    borderDim: fmtFg(palette.borderDim, trueColor),
    badgeBg: fmtBg(palette.badgeBg, trueColor),
    badgeFg: fmtFg(palette.badgeFg, trueColor),
    badgeBorder: fmtFg(palette.badgeBorder, trueColor),
    inputFg: fmtFg(palette.inputFg, trueColor),
    ghost: fmtFg(palette.ghost, trueColor),
    muted: fmtFg(palette.muted, trueColor),
    chipFg: fmtFg(palette.chipFg, trueColor),
    chipBg: fmtBg(palette.chipBg, trueColor),
  }
}

/* ------------------------------------------------------------------ */
/* 解析                                                               */
/* ------------------------------------------------------------------ */

function resolveTrueColor(env?: NodeJS.ProcessEnv): boolean {
  const colorTerm = env?.COLORTERM?.toLowerCase() ?? ''
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return true
  // Windows Terminal / 现代终端默认 truecolor；256 色终端显式声明
  const term = env?.TERM?.toLowerCase() ?? ''
  if (term.includes('256color') || term.includes('xterm')) return true
  return true
}

export function resolveTuiTheme(opts?: ResolveTuiThemeOptions): TuiTheme {
  const env = opts?.env ?? process.env
  let id: TuiThemeId = 'default'
  const raw = (opts?.theme ?? env.BOLO_THEME ?? 'default').toString().trim().toLowerCase()
  if (raw === 'plain' || raw === 'simple') id = 'plain'
  else if (raw === 'dim' || raw === 'minimal') id = 'dim'
  else if (raw === 'amber') id = 'amber'
  else if (raw === 'neon') id = 'neon'
  else if (raw === 'default' || raw === 'aurora' || raw === 'auto') id = 'default'
  else id = 'default'

  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') id = 'plain'
  if (env.BOLO_PLAIN === '1' || env.BOLO_PLAIN === 'true') id = 'plain'

  let mascot = opts?.mascot
  if (mascot === undefined) {
    const m = env.BOLO_MASCOT?.trim().toLowerCase()
    if (m === '0' || m === 'false' || m === 'off' || m === 'no') mascot = false
    else mascot = true
  }

  const ansi = id !== 'plain'
  const trueColor = ansi && (opts?.trueColor ?? resolveTrueColor(env))

  return {
    id,
    mascot,
    ansi,
    trueColor,
    palette: PALETTES[id],
  }
}
