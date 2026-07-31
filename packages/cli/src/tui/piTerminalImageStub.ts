/**
 * pi-tui `terminal-image.js` 的 Bolo 本地替代（构建期由 esbuild plugin 替换）。
 *
 * 为什么替换：
 * - pi 原版附带 tmux 探测（`execSync` 子进程调用）与 kitty/iTerm2 图片
 *   编解码死代码，Bolo 不渲染图片却被迫内嵌（约 250 行 + 隐藏子进程调用面）。
 * - 本 stub 保留原模块对 Bolo 使用面的全部语义：capabilities 缓存/覆盖、
 *   `detectCapabilities` 的纯环境变量探测（去掉 tmux execSync 分支）、
 *   cell 尺寸状态、图片行识别与清除序列。
 *
 * 约束：`tui.js` 与 `piCompat.ts` 只 import 下述导出；缺失符号会让 esbuild
 * 构建直接报错，`scripts/test-dist-build.ts` 同时断言 bundle 不含原模块。
 */
let cachedCapabilities: Record<string, unknown> | null = null
let cellDimensions = { widthPx: 9, heightPx: 18 }

export function getCellDimensions() {
  return cellDimensions
}

export function setCellDimensions(dims: { widthPx: number; heightPx: number }) {
  cellDimensions = dims
}

/**
 * 与原 `detectCapabilities` 同语义，仅去掉 tmux 的 `execSync` 探测分支：
 * tmux 下保守关闭 hyperlink（Bolo 不承诺 tmux 转发 OSC 8）。
 */
function detectCapabilities(): Record<string, unknown> {
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || ''
  const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || ''
  const term = process.env.TERM?.toLowerCase() || ''
  const colorTerm = process.env.COLORTERM?.toLowerCase() || ''
  const hasTrueColorHint = colorTerm === 'truecolor' || colorTerm === '24bit'
  if (process.env.TMUX || term.startsWith('tmux')) {
    return { images: null, trueColor: hasTrueColorHint, hyperlinks: false }
  }
  if (term.startsWith('screen')) {
    return { images: null, trueColor: hasTrueColorHint, hyperlinks: false }
  }
  if (process.env.KITTY_WINDOW_ID || termProgram === 'kitty') {
    return { images: 'kitty', trueColor: true, hyperlinks: true }
  }
  if (termProgram === 'ghostty' || term.includes('ghostty') || process.env.GHOSTTY_RESOURCES_DIR) {
    return { images: 'kitty', trueColor: true, hyperlinks: true }
  }
  if (process.env.WEZTERM_PANE || termProgram === 'wezterm') {
    return { images: 'kitty', trueColor: true, hyperlinks: true }
  }
  if (termProgram === 'warpterminal' || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
    return { images: 'kitty', trueColor: true, hyperlinks: true }
  }
  if (process.env.ITERM_SESSION_ID || termProgram === 'iterm.app') {
    return { images: 'iterm2', trueColor: true, hyperlinks: true }
  }
  if (process.env.WT_SESSION) {
    return { images: null, trueColor: true, hyperlinks: true }
  }
  if (termProgram === 'vscode') {
    return { images: null, trueColor: true, hyperlinks: true }
  }
  if (termProgram === 'alacritty') {
    return { images: null, trueColor: true, hyperlinks: true }
  }
  if (terminalEmulator === 'jetbrains-jediterm') {
    return { images: null, trueColor: true, hyperlinks: false }
  }
  return { images: null, trueColor: hasTrueColorHint, hyperlinks: false }
}

export function getCapabilities() {
  if (!cachedCapabilities) {
    cachedCapabilities = detectCapabilities()
  }
  return cachedCapabilities
}

export function resetCapabilitiesCache() {
  cachedCapabilities = null
}

/** 覆盖缓存的能力值；测试用它驱动两条代码路径。 */
export function setCapabilities(caps: Record<string, unknown>) {
  cachedCapabilities = caps
}

const KITTY_PREFIX = '\x1b_G'
const ITERM2_PREFIX = '\x1b]1337;File='

export function isImageLine(line: string) {
  // Fast path: sequence at line start (single-row images)
  if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
    return true
  }
  // Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
  return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX)
}

export function deleteKittyImage(imageId: string) {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`
}

export function deleteAllKittyImages() {
  return '\x1b_Ga=d,d=A,q=2\x1b\\'
}

export function hyperlink(text: string, url: string) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}
