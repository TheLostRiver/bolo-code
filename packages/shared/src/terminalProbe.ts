/**
 * TERM-1: 终端能力探测纯契约。
 *
 * 目标：识别终端身份（品牌/版本）与关键能力（DA2 报告、嵌套 tmux），
 * 为渲染与输入差异（滚轮、粘贴、行为特化）提供数据源；能力不足时走
 * 保守默认，不阻塞启动。
 *
 * 探测通道：
 * - DA2（`CSI > c`）：终端厂商/版本报告 `CSI > p ; P ; V c`。
 *   已知：Windows Terminal 第 1 参数 7721；xterm 1；iTerm2 0；
 *   tmux 包裹的终端响应经 tmux 透传。
 * - env 推断：TERM_PROGRAM / TERM / TMUX / WT_SESSION 等，作为查询缺失或
 *   超时的回退与补充（如 Windows Terminal 的 WT_SESSION）。
 *
 * 本文件只放纯函数与类型；查询发送与响应拦截在 CLI adapter。
 */
export const DA2_QUERY = '\x1b[>c'

export type TerminalFamily =
  | 'unknown'
  | 'xterm'
  | 'iterm2'
  | 'wezterm'
  | 'konsole'
  | 'tmux'
  | 'kitty'
  | 'alacritty'
  | 'foot'
  | 'vscode'
  | 'windows-terminal'
  | 'putty'
  | 'mintty'
  | 'gnome-terminal'
  | 'apple-terminal'
  | 'rio'
  | 'ghostty'

export type TerminalCapabilities = {
  /** DA2 品牌族（查询成功或 env 推断） */
  family: TerminalFamily
  /** DA2 厂商参数（第 1 参数；查询失败时 undefined） */
  vendorId?: number
  /** DA2 版本参数（第 2 参数；查询失败时 undefined） */
  versionId?: number
  /** 是否确认在 tmux 内（TMUX env 或 DA2 包裹证据） */
  insideTmux: boolean
  /** 是否 Windows 平台（env 推断，用于特化路径/进程语义） */
  isWindows: boolean
  /** 探测来源：'da2'（真实查询响应）/ 'env'（环境推断）/ 'default'（保守） */
  source: 'da2' | 'env' | 'default'
}

export function createDefaultTerminalCapabilities(): TerminalCapabilities {
  return {
    family: 'unknown',
    insideTmux: false,
    isWindows: false,
    source: 'default',
  }
}

/** DA2 响应：`ESC [ > p ; P ; V c`（也可能缺段）。失败返回 undefined。 */
export function parseDa2Response(data: string): {
  vendorId?: number
  versionId?: number
} | undefined {
  const match = /^\u001b\[>(\d+)(?:;(\d+))?(?:;(\d+))?c$/u.exec(data)
  if (!match) return undefined
  const vendorId = Number(match[1])
  const versionId = match[2] !== undefined ? Number(match[2]) : undefined
  return {
    // vendorId=0 合法（iTerm2 的 DA2 是 `>0;95;0c`）；Infinity/NaN 丢弃
    ...(Number.isFinite(vendorId) ? { vendorId } : {}),
    ...(versionId !== undefined && Number.isFinite(versionId)
      ? { versionId }
      : {}),
  }
}

export function isDa2Response(data: string): boolean {
  return /^\u001b\[>[\d;]*c$/u.test(data)
}

/**
 * 按 DA2 厂商参数识别品牌族；未知返回 undefined（留给 env 推断）。
 */
export function familyFromVendorId(vendorId: number): TerminalFamily | undefined {
  switch (vendorId) {
    case 1:
      return 'xterm'
    case 0:
      return 'iterm2'
    case 7721:
      return 'windows-terminal'
    case 61:
      return 'kitty'
    case 95:
      return 'alacritty'
    case 2101:
      return 'vscode'
    case 13:
      return 'putty'
    case 83:
      return 'mintty'
    case 2680:
      return 'wezterm'
    case 5376:
      return 'foot'
    case 6741:
      return 'gnome-terminal'
    case 13692:
      return 'konsole'
    case 5743:
      return 'rio'
    case 2049:
      return 'ghostty'
    default:
      return undefined
  }
}

/**
 * 环境推断品牌族（查询缺失/超时回退）。
 * 注意：tmux/kitty（TERM=screen 系列、xterm-kitty）不能从 TERM 可靠区分——
 * 包裹终端与真身共用同一 TERM 名，宁缺勿错，交给 DA2 响应识别。
 */
export function familyFromEnv(env: NodeJS.ProcessEnv): TerminalFamily | undefined {
  const program = (env.TERM_PROGRAM ?? '').trim().toLowerCase()
  if (program === 'wezterm') return 'wezterm'
  if (program === 'iterm.app') return 'iterm2'
  if (program === 'vscode' || program === 'vscode-insiders') return 'vscode'
  if (program === 'ghostty') return 'ghostty'
  if (program === 'rio') return 'rio'
  if (env.WT_SESSION) return 'windows-terminal'
  if (env.TERM && /^xterm(?:-|$)/u.test(env.TERM.trim().toLowerCase())) {
    return 'xterm'
  }
  return undefined
}

/**
 * 组装探测结果：优先 DA2 响应；缺失时 env 推断；否则保守默认。
 */
export function resolveTerminalCapabilities(
  da2: { vendorId?: number; versionId?: number } | undefined,
  env: NodeJS.ProcessEnv,
): TerminalCapabilities {
  const isWindows =
    typeof process !== 'undefined' &&
    typeof process.platform === 'string' &&
    process.platform === 'win32'
  const insideTmux = Boolean(env.TMUX && env.TMUX.trim())
  if (da2 && da2.vendorId !== undefined) {
    const family = familyFromVendorId(da2.vendorId) ?? 'unknown'
    return {
      family,
      ...(da2.vendorId !== undefined ? { vendorId: da2.vendorId } : {}),
      ...(da2.versionId !== undefined ? { versionId: da2.versionId } : {}),
      insideTmux,
      isWindows,
      source: 'da2',
    }
  }
  const family = familyFromEnv(env)
  if (family) {
    return { family, insideTmux, isWindows, source: 'env' }
  }
  return {
    ...createDefaultTerminalCapabilities(),
    insideTmux,
    isWindows,
  }
}
