/**
 * pi-tui 收口适配层 —— 全仓库唯一允许直连 `@earendil-works/pi-tui` 的模块。
 *
 * 职责：
 * - 聚合 Bolo 用到的全部 pi-tui deep import（值 + 类型 + 测试符号），
 *   其余代码一律 `import ... from './piCompat.ts'`。
 * - 升级 / 替换 / fork pi-tui 时只改这一个文件，import 面不再散落
 *   在 packages/cli 与 scripts 各处。
 *
 * 约束（scripts/test-pi-compat-boundary.ts 守）：
 * - 除本文件外，任何源码不得再出现 `from '@earendil-works/pi-tui`。
 * - 值导入会被 esbuild 内嵌进 dist/bolo.mjs；`type` 导入在构建期擦除
 *   （dist/bolo.mjs 必须不含 terminal.js，见 scripts/test-dist-build.ts）。
 * - pi-tui 的 terminal-image.js 由本地 stub（piTerminalImageStub.ts）替代，
 *   不进入 bundle：源码层直接引用 stub（测试/构建同轨），pi-tui 内部的
 *   相对导入由 scripts/build-dist.ts 的 esbuild plugin 在构建期拦截替换。
 *   这里仅收口测试所需的 capability 符号，避免测试脚本直连 deep path。
 */
export { StdinBuffer } from '@earendil-works/pi-tui/dist/stdin-buffer.js'
export type { Terminal } from '@earendil-works/pi-tui/dist/terminal.js'
export {
  CURSOR_MARKER,
  Container,
  TUI,
  type Component,
  type Focusable,
  type OverlayHandle,
} from '@earendil-works/pi-tui/dist/tui.js'
export { parseKey } from '@earendil-works/pi-tui/dist/keys.js'
export { Input } from '@earendil-works/pi-tui/dist/components/input.js'
export { Box } from '@earendil-works/pi-tui/dist/components/box.js'
export { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui/dist/components/markdown.js'
export { Text } from '@earendil-works/pi-tui/dist/components/text.js'
// 直接引用本地 stub：让 tsx 测试 / tsc / esbuild 构建全部走同一实现（单轨），
// 避免测试命中 node_modules 原版（含 tmux execSync）而生产用 stub 的双轨不一致。
export { getCapabilities, setCapabilities } from './piTerminalImageStub.ts'
