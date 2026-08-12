/**
 * TUI 主题系统单测：5 主题解析与 env 覆盖、palette 完整性、
 * truecolor/256 色降级、ANSI 预计算。
 */
import { strict as assert } from 'node:assert'
import {
  buildPaletteAnsi,
  fmtBg,
  fmtFg,
  getTuiPalette,
  isTuiThemeId,
  resolveTuiTheme,
  rgbToXterm256,
  TUI_THEME_IDS,
  type Rgb,
} from '../packages/cli/src/tui/theme.ts'

function assertRgb(rgb: Rgb, hex: string): void {
  const h = hex.replace('#', '')
  assert.deepEqual(
    rgb,
    [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
    `${hex} → [${rgb.join(',')}]`,
  )
}

function main() {
  // ---- 主题解析 ----
  assert.equal(resolveTuiTheme().id, 'default')
  for (const id of TUI_THEME_IDS) {
    assert.equal(resolveTuiTheme({ theme: id }).id, id, `theme ${id}`)
  }
  // 别名
  assert.equal(resolveTuiTheme({ theme: 'aurora' }).id, 'default')
  assert.equal(resolveTuiTheme({ theme: 'simple' }).id, 'plain')
  assert.equal(resolveTuiTheme({ theme: 'minimal' }).id, 'dim')
  // 未知值 fail-closed 到 default
  assert.equal(resolveTuiTheme({ theme: 'not-a-theme' }).id, 'default')
  // env 覆盖
  assert.equal(resolveTuiTheme({ env: { BOLO_THEME: 'neon' } }).id, 'neon')
  assert.equal(resolveTuiTheme({ env: { NO_COLOR: '1' } }).id, 'plain')
  assert.equal(resolveTuiTheme({ env: { BOLO_PLAIN: '1' } }).id, 'plain')
  // NO_COLOR 优先于显式主题
  assert.equal(resolveTuiTheme({ theme: 'amber', env: { NO_COLOR: '1' } }).id, 'plain')

  // ---- ansi / trueColor 开关 ----
  assert.equal(resolveTuiTheme({ theme: 'plain' }).ansi, false)
  assert.equal(resolveTuiTheme({ theme: 'default' }).ansi, true)
  assert.equal(resolveTuiTheme({ theme: 'default', trueColor: false }).trueColor, false)
  assert.equal(resolveTuiTheme({ theme: 'plain', trueColor: false }).trueColor, false)

  // ---- palette 完整性：每个主题 20 个 token 均为三元组 ----
  const tokenCount = Object.keys(getTuiPalette('default')).length
  assert.equal(tokenCount, 20)
  for (const id of TUI_THEME_IDS) {
    const p = getTuiPalette(id)
    for (const [k, v] of Object.entries(p)) {
      assert.ok(
        Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
        `${id}.${k} must be an RGB triple`,
      )
    }
  }
  // 默认主题 = 极光
  assertRgb(getTuiPalette('default').accent, '#2dd4bf')
  assertRgb(getTuiPalette('default').accent2, '#8b5cf6')
  assertRgb(getTuiPalette('amber').accent, '#fbbf24')
  assertRgb(getTuiPalette('neon').accent, '#e879f9')
  assertRgb(getTuiPalette('default').inputBg, '#0e1a21')
  assertRgb(getTuiPalette('default').success, '#86efac')
  assertRgb(getTuiPalette('amber').error, '#f87171')

  // ---- 256 色降级 ----
  assert.equal(rgbToXterm256([0, 0, 0]), 16)
  assert.equal(rgbToXterm256([255, 255, 255]), 231)
  // cube 主色
  assert.equal(rgbToXterm256([255, 0, 0]), 196)
  assert.equal(rgbToXterm256([0, 255, 0]), 46)
  assert.equal(rgbToXterm256([0, 0, 255]), 21)
  // 灰阶
  const gray = rgbToXterm256([128, 128, 128])
  assert.ok(gray >= 232 && gray <= 255, `gray ${gray}`)

  // ---- ANSI 输出 ----
  assert.equal(fmtFg([1, 2, 3], true), '\u001b[38;2;1;2;3m')
  assert.equal(fmtFg([255, 0, 0], false), '\u001b[38;5;196m')
  assert.equal(fmtBg([1, 2, 3], true), '\u001b[48;2;1;2;3m')
  assert.equal(fmtBg([0, 0, 0], false), '\u001b[48;5;16m')
  assert.equal(fmtFg(null, true), '')

  // ---- ANSI palette 预计算 ----
  const ansiPalette = buildPaletteAnsi(getTuiPalette('default'), true, true)
  assert.ok(ansiPalette.accent.startsWith('\u001b[38;2;45;212;191m'))
  assert.ok(ansiPalette.badgeBg.startsWith('\u001b[48;2;'))
  assert.ok(ansiPalette.surface.startsWith('\u001b[48;2;'))
  assert.ok(ansiPalette.error.startsWith('\u001b[38;2;'))
  const plainPalette = buildPaletteAnsi(getTuiPalette('plain'), true, false)
  for (const value of Object.values(plainPalette)) {
    assert.equal(value, '', 'plain palette must be all empty')
  }
  // 256 降级版
  const dim256 = buildPaletteAnsi(getTuiPalette('default'), false, true)
  assert.ok(dim256.accent.startsWith('\u001b[38;5;'))

  // ---- isTuiThemeId ----
  assert.equal(isTuiThemeId('amber'), true)
  assert.equal(isTuiThemeId('aurora'), false)
  assert.equal(isTuiThemeId(undefined), false)

  console.log(`PASS: tui theme system (${TUI_THEME_IDS.length} themes)`)
}

main()
await import('./test-cli-theme-runtime.ts')
