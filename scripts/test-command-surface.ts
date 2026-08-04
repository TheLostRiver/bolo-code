/**
 * URF-1 · command surface 渲染稳健性（/effort 重叠错乱）
 *
 * 覆盖：
 * - 多行 toast content → 逐行渲染（无行内含 \n——行数与终端占行一致）
 * - 单行 toast → 单行（回归）
 * - panel 单线框（┌┐└┘）——与输入框双线框（╭╮╰╯）区分
 * - 集成：多行 toast 在视口完整可见（布局不破坏 footer）
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  formatCliCommandSurface,
  type FormatCliCommandSurfaceOptions,
} from '../packages/cli/src/tui/retainedCommandSurface.ts'
import type { CliCommandSurfaceTone } from '../packages/shared/src/index.ts'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { HeadlessTerminalHarness } from '../scripts/lib/headlessTerminalHarness.ts'

class RawInputHarness extends EventEmitter {
  readonly isTTY = true
  isRaw = false
  setRawMode(): this {
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  send(data: string): void {
    this.emit('data', Buffer.from(data, 'utf8'))
  }
}

class ResizableOutput extends EventEmitter {
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

const fmt = (state: Parameters<typeof formatCliCommandSurface>[0]) =>
  formatCliCommandSurface(state, {
    columns: 80,
    rows: 24,
    color: false,
  } as FormatCliCommandSurfaceOptions)

const MULTI_LINE_TOAST = [
  'effort set to max',
  'api value: max',
  'choosable: auto, none, minimal, low, medium, high, xhigh, max',
  'wire levels: none, minimal, low, medium, high, xhigh, max',
].join('\n')

function makePanel(content: string): NonNullable<
  Parameters<typeof formatCliCommandSurface>[0]['panel']
> {
  return {
    key: 'slash:effort',
    title: 'slash:effort',
    content,
    dismissOnInput: true,
    dismissOnEscape: true,
    overflow: 'compact',
    generation: 1,
  }
}

function makeToast(
  content: string,
  tone: CliCommandSurfaceTone = 'success',
): NonNullable<
  Parameters<typeof formatCliCommandSurface>[0]['toast']
> {
  return {
    key: 'slash:effort:update',
    content,
    tone,
    ttlMs: 5_000,
    generation: 1,
  }
}

// --- 1. 多行 toast：逐行渲染、无行内含 \n ---
{
  const lines = fmt({
    panel: undefined,
    toast: makeToast(MULTI_LINE_TOAST),
    nextGeneration: 1,
  })
  assert.equal(lines.length, 4, 'multi-line toast renders one line per row')
  for (const [i, line] of lines.entries()) {
    assert(!line.includes('\n'), `line ${i} must not embed newline`)
  }
  assert(lines[0]!.includes('effort set to max'), 'first row has prefix + title')
  assert(lines[1]!.includes('api value: max'), 'second row is detail')
  assert(lines[3]!.includes('wire levels'), 'last row is tail detail')
}

// --- 2. 单行 toast：仍单行（回归） ---
{
  const lines = fmt({
    panel: undefined,
    toast: makeToast('done', 'info'),
    nextGeneration: 1,
  })
  assert.equal(lines.length, 1, 'single-line toast stays one row')
  assert(!lines[0]!.includes('\n'), 'no embedded newline')
  assert(lines[0]!.includes('done'), 'content visible')
}

// --- 3. panel 单线框：不与输入框双线框混淆 ---
{
  const lines = fmt({
    panel: makePanel('api value: max\ncurrent: xhigh'),
    toast: undefined,
    nextGeneration: 1,
  })
  assert(lines[0]!.includes('┌'), 'panel top border is single-line ┌')
  assert(lines[lines.length - 1]!.includes('└'), 'panel bottom border is └')
  for (const line of lines) {
    assert(!line.includes('╭'), 'no composer double-line border in panel')
    assert(!line.includes('╰'), 'no composer double-line border in panel')
  }
}

// --- 3b. 边界：空行保留 + 超长行截断 + ANSI 剥离 ---
{
  const lines = fmt({
    panel: undefined,
    toast: makeToast('title\n\n' + 'x'.repeat(200) + '\n\u001b[31mred\u001b[0m'),
    nextGeneration: 1,
  })
  assert.equal(lines.length, 4, 'blank row preserved (row count matches)')
  assert(lines[1] === '', 'blank middle row renders as empty row')
  assert(!lines[2]!.includes('\n'), 'long row clipped, no embedded newline')
  assert(lines[2]!.length <= 80, 'long row clipped to frame width')
  assert(lines[2]!.endsWith('…'), 'clip marker present')
  assert(!lines[3]!.includes('\u001b[31m'), 'ANSI stripped in clipped row')
}

// --- 4. 集成：多行 toast 在视口完整可见（布局不破坏） ---
{
  const terminal = new HeadlessTerminalHarness({
    columns: 80,
    rows: 24,
    scrollback: 600,
  })
  const controller: CliTuiController = createRetainedTuiController({
    writeOut: (text: string) => terminal.write(text),
    writeErr: (text: string) => terminal.write(text),
    input: new RawInputHarness() as never,
    output: new ResizableOutput(80, 24) as never,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  await controller.start()
  await terminal.flush()

  controller.showCommandToast({
    key: 'slash:effort:update',
    content: MULTI_LINE_TOAST,
    tone: 'success',
    ttlMs: 5_000,
  })
  await new Promise((r) => setTimeout(r, 150))
  await terminal.flush()

  const viewport = terminal.viewport().map((l) => l.text)
  assert(
    viewport.some((l) => l.includes('effort set to max')),
    'toast first row visible',
  )
  assert(
    viewport.some((l) => l.includes('wire levels')),
    'toast tail row visible (no layout corruption)',
  )
  assert(
    viewport.some((l) => l.includes('Enter send')),
    'footer still visible after toast',
  )
  await controller.stop()
}

console.log('PASS: URF-1 command surface multi-line toast + panel frame')
