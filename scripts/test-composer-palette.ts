/**
 * Composer palette 消费测试：极光（default）palette 驱动输入框/footer 取色，
 * 无 palette 时回退旧色值（字节兼容），plain 零 ANSI。
 */
import { strict as assert } from 'node:assert'
import { buildPaletteAnsi, getTuiPalette, resolveTuiTheme } from '../packages/cli/src/tui/theme.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import {
  buildComposerColors,
  renderTuiInputBox,
  renderTuiInputFooter,
  type ComposerAnsiPalette,
} from '../packages/cli/src/tui/inputBox.ts'
import { createTuiInputState } from '../packages/cli/src/tui/inputBox.ts'

function auroraPalette(): ComposerAnsiPalette {
  const theme = resolveTuiTheme({ theme: 'default' })
  return buildPaletteAnsi(theme.palette, theme.trueColor, theme.ansi)
}

function assertLinesFit(
  rendered: { lines: string[] },
  columns: number,
  label: string,
): void {
  for (const line of rendered.lines) {
    const width = measureTerminalText(line)
    assert.ok(width <= columns, `${label}: line width ${width} > ${columns}`)
  }
}

function main() {
  const palette = auroraPalette()

  // ---- buildComposerColors：极光取色 ----
  const colors = buildComposerColors({ color: true, palette })
  assert.equal(colors.prompt, '\u001b[38;2;45;212;191m', 'prompt = teal accent')
  assert.equal(colors.border, '\u001b[38;2;31;138;124m', 'border = teal deep')
  assert.ok(colors.kbdBg.startsWith('\u001b[48;2;'), 'kbd 键帽有背景色')

  // ---- 回退：无 palette 时字节与旧实现一致 ----
  const fallback = buildComposerColors({ color: true })
  assert.equal(fallback.border, '\u001b[38;5;244m', 'fallback border = 旧灰')
  assert.equal(fallback.prompt, '\u001b[38;5;81m', 'fallback prompt = 旧青')
  assert.equal(fallback.muted, '\u001b[2m', 'fallback muted = dim')
  const plainColors = buildComposerColors({ color: false })
  assert.equal(plainColors.border, '', 'plain 无 ANSI')

  // ---- renderTuiInputBox：极光 palette 生效 ----
  const state = createTuiInputState({ value: 'hello' })
  const themed = renderTuiInputBox({
    state,
    color: true,
    palette,
    includeFooter: true,
    status: {
      permissionMode: 'default',
      model: 'sonnet-4.5',
      effortLevel: 'high',
      providerKind: 'mock',
      usage: { inputTokens: 96000, outputTokens: 1200 },
      contextWindowTokens: 256000,
    },
  })
  assert.ok(themed.text.includes('\u001b[38;2;45;212;191m'), 'box 含 teal prompt')
  assert.ok(themed.text.includes('\u001b[38;2;31;138;124m'), 'box 含 teal border')
  assert.ok(
    themed.text.includes('\u001b[38;2;215;245;239m'),
    'footer 值用 inputFg（模型/effort 亮青白）',
  )
  // 极光版 badge：model/effort 骑上边框（纯背景胶囊 + teal 圆点）+ context 进度条
  assert.ok(themed.text.includes('●'), 'badge teal 圆点')
  assert.ok(themed.text.includes('model sonnet-4.5'), 'model badge')
  assert.ok(themed.text.includes('effort high'), 'effort badge')
  assert.ok(themed.text.includes('context'), 'context badge')
  assert.ok(themed.text.includes('38% · 96k/256k'), 'context 百分比与用量')
  assert.ok(themed.text.includes('█'), '进度条填充字符')
  assert.ok(!themed.text.includes('╭●'), 'badge 无 ╭ 角字符（纯背景胶囊）')
  assert.ok(
    !themed.text.includes('model sonnet-4.5╮') &&
      !themed.text.includes('effort high╮'),
    'badge 无 ╮ 角字符（纯背景胶囊）',
  )
  // 单行 footer：kbd 键帽 + │ 竖线分隔 + 右侧胶囊
  assert.ok(themed.text.includes('Enter'), 'kbd Enter')
  assert.ok(themed.text.includes('send'), 'action send')
  assert.ok(themed.text.includes(' │ '), '竖线分隔')
  assert.ok(themed.text.includes('default · ↓96k ↑1.2k'), 'mode/usage 胶囊')
  assert.ok(!themed.text.includes(' · effort '), 'palette 不再重复 status 行')
  assertLinesFit(themed, 80, '80 列 themed')

  // ---- 回退渲染字节不变 ----
  const legacy = renderTuiInputBox({
    state,
    color: true,
    includeFooter: true,
    status: {
      permissionMode: 'default',
      model: 'sonnet-4.5',
      effortLevel: 'high',
      providerKind: 'mock',
    },
  })
  assert.ok(legacy.text.includes('\u001b[38;5;244m'), 'legacy border 灰')
  assert.ok(legacy.text.includes('\u001b[38;5;81m'), 'legacy prompt 青')
  assert.ok(legacy.text.includes('Message'), 'legacy 无 badge 时保留标题行')
  assert.ok(legacy.text.includes(' · effort '), 'legacy 仍为两行 status footer')

  // ---- plain：零 ANSI ----
  const plainPalette = buildPaletteAnsi(getTuiPalette('plain'), true, false)
  const plain = renderTuiInputBox({
    state,
    color: true,
    palette: plainPalette,
    includeFooter: true,
  })
  assert.ok(!plain.text.includes('\u001b['), 'plain 输出不含 ANSI')

  // ---- footer 快捷键键帽 ----
  const footer = renderTuiInputFooter({
    state,
    color: true,
    palette,
    status: { permissionMode: 'default', model: 'm', effortLevel: 'e' },
  })
  assert.ok(footer.text.includes('\u001b[48;2;'), 'footer 含 kbd 背景色')

  // ---- 中间宽度：chip 第二行右对齐（两行模式） ----
  const midWidth = renderTuiInputFooter({
    state,
    columns: 70,
    color: true,
    palette,
    status: {
      permissionMode: 'default',
      model: 'm',
      effortLevel: 'e',
      usage: { inputTokens: 96000, outputTokens: 1200 },
    },
  })
  assert.ok(midWidth.text.includes('default · ↓96k ↑1.2k'), '两行模式 chip 保留 usage')
  assert.ok(midWidth.lines.length >= 2, '70 列两行布局')
  assertLinesFit(midWidth, 70, '70 列 midWidth')

  // ---- 窄宽度：keys 行 + chip 行均保留（两行模式上限） ----
  const narrow = renderTuiInputFooter({
    state,
    columns: 74,
    color: true,
    palette,
    status: { permissionMode: 'default' },
  })
  assert.ok(narrow.text.includes('Enter'), '窄宽度保留快捷键')
  assert.ok(narrow.text.includes('default'), '窄宽度 chip 行保留')
  assert.ok(narrow.lines.length >= 2, '74 列两行布局')
  assertLinesFit(narrow, 74, '74 列 narrow')

  console.log('PASS: composer palette consumption')
}

main()
