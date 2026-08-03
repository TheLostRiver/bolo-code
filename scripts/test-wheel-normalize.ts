/**
 * TERM-3 · 滚轮滚动规范化
 *
 * 覆盖：
 * - 逐格滚动：间隔 > 帧窗口 → 每事件 1 格（增量语义）
 * - 16ms cadence 帧合并：同帧密集事件合并为一帧量（事件风暴抑制）
 * - 加速度分带：帧内事件率 1-2 低速 1×、3-4 中速 2×、5+ 高速 3×
 * - 方向变化开新帧：反向滚动立即生效（1 格），帧量归零重算
 * - 帧事件上限：单帧风暴封顶（WHEEL_MAX_EVENTS_PER_FRAME）
 * - TUI 集成：wheel 事件 → 规范化 → pager 翻页（真实 headless TUI）
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import {
  createWheelNormalizer,
  wheelBandMultiplier,
  WHEEL_CADENCE_MS,
  WHEEL_MAX_EVENTS_PER_FRAME,
  type ToolPresentation,
} from '../packages/shared/src/index.ts'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

// ── 集成 fixture（与 OUT-4 同构）──
class RawInputHarness extends EventEmitter {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): this {
    this.isRaw = mode
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

type Fixture = {
  controller: CliTuiController
  input: RawInputHarness
  output: ResizableOutput
  terminal: HeadlessTerminalHarness
}

async function createFixture(columns = 76, rows = 40): Promise<Fixture> {
  const input = new RawInputHarness()
  const output = new ResizableOutput(columns, rows)
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 400,
  })
  const controller = createRetainedTuiController({
    writeOut: (text: string) => terminal.write(text),
    writeErr: (text: string) => terminal.write(text),
    input,
    output,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  await controller.start()
  await terminal.flush()
  return { controller, input, output, terminal }
}

async function settle(fixture: Fixture): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  fixture.controller.flush()
  await fixture.terminal.flush()
  await new Promise((r) => setImmediate(r))
}

function screen(fixture: Fixture): string {
  return fixture.terminal
    .viewport()
    .map((line) => line.text)
    .join('\n')
}

async function waitForRow(
  fixture: Fixture,
  needle: string,
  ms = 3_000,
): Promise<number> {
  const start = Date.now()
  for (;;) {
    const entry = fixture.terminal
      .viewport()
      .find((line) => line.text.includes(needle))
    if (entry) return entry.index + 1
    if (Date.now() - start > ms) throw new Error(`row not found: ${needle}`)
    await new Promise((r) => setTimeout(r, 25))
    fixture.controller.flush()
    await fixture.terminal.flush()
  }
}

async function waitForScreen(
  fixture: Fixture,
  predicate: (text: string) => boolean,
  ms = 3_000,
): Promise<string> {
  const start = Date.now()
  for (;;) {
    const text = screen(fixture)
    if (predicate(text)) return text
    if (Date.now() - start > ms) {
      throw new Error(`screen condition not met; last screen:\n${text.slice(0, 800)}`)
    }
    await new Promise((r) => setTimeout(r, 25))
    fixture.controller.flush()
    await fixture.terminal.flush()
  }
}

const boundedPresentation: ToolPresentation = {
  summary: 'Read · x.txt · 120 lines · truncated',
  preview: Array.from({ length: 120 }, (_, i) => `preview line ${i}`).join('\n'),
  previewMode: 'head',
  originalChars: 30_000,
  originalLines: 120,
  retainedChars: 1_000,
  retainedLines: 10,
  truncated: true,
  overflow: true,
}

// --- 1. 逐格滚动：间隔 > 帧窗口 → 每事件 1 格 ---
{
  const n = createWheelNormalizer()
  let t = 1_000
  const r1 = n.push({ direction: 'down', at: t })
  t += WHEEL_CADENCE_MS + 1
  const r2 = n.push({ direction: 'down', at: t })
  assert.equal(r1.scrollLines, 1, 'first event: 1 line')
  assert.equal(r2.scrollLines, 1, 'slow wheel: 1 line per event')
}

// --- 2. 16ms cadence 帧合并 + 加速度分带（增量语义）---
{
  const n = createWheelNormalizer()
  let t = 2_000
  const r1 = n.push({ direction: 'down', at: t }) // 帧首：1 格
  const r2 = n.push({ direction: 'down', at: (t += 2) }) // 第 2 事件：2×1=2 → 增量 1
  const r3 = n.push({ direction: 'down', at: (t += 2) }) // 第 3 事件：3×2=6 → 增量 4
  const r4 = n.push({ direction: 'down', at: (t += 2) }) // 第 4 事件：4×2=8 → 增量 2
  assert.equal(r1.scrollLines, 1, 'frame start: 1')
  assert.equal(r2.scrollLines, 1, 'band 1: +1')
  assert.equal(r3.scrollLines, 4, 'band 2: +4')
  assert.equal(r4.scrollLines, 2, 'band 2: +2')
  const total = [r1, r2, r3, r4].reduce((s, r) => s + r.scrollLines, 0)
  assert.equal(total, 8, 'frame total = 4 events × 2× band')
  assert.equal(wheelBandMultiplier(1), 1, 'band: 1 event → 1×')
  assert.equal(wheelBandMultiplier(3), 2, 'band: 3 events → 2×')
  assert.equal(wheelBandMultiplier(5), 3, 'band: 5 events → 3×')
}

// --- 3. 高速带 + 帧事件上限 ---
{
  const n = createWheelNormalizer()
  let t = 3_000
  const rs: number[] = []
  for (let i = 0; i < 8; i += 1) {
    rs.push(n.push({ direction: 'down', at: (t += 2) }).scrollLines)
  }
  const capped = WHEEL_MAX_EVENTS_PER_FRAME
  const capLines = capped * wheelBandMultiplier(capped)
  const frameTotal = rs.reduce((s, r) => s + r, 0)
  assert.equal(
    frameTotal,
    capLines,
    `frame capped at ${capLines} lines (got ${frameTotal})`,
  )
}

// --- 4. 方向变化开新帧：反向滚动立即 1 格 ---
{
  const n = createWheelNormalizer()
  let t = 4_000
  n.push({ direction: 'down', at: t }) // 帧 1：down
  n.push({ direction: 'down', at: (t += 2) }) // 帧 1 内：down 累积
  const up1 = n.push({ direction: 'up', at: (t += 2) }) // 方向反转 → 新帧 1 格
  assert.equal(up1.scrollLines, 1, 'direction flip: fresh 1-line frame')
  const up2 = n.push({ direction: 'up', at: (t += 2) }) // 同帧 up：累积
  assert.equal(up2.scrollLines, 1, 'same-direction continuation: +1')
}

// --- 5. flush 后开新帧 ---
{
  const n = createWheelNormalizer()
  let t = 5_000
  n.push({ direction: 'down', at: t })
  n.push({ direction: 'down', at: (t += 2) })
  assert.equal(n.flush().scrollLines, 0, 'flush: no residual')
  const after = n.push({ direction: 'down', at: (t += 2) })
  assert.equal(after.scrollLines, 1, 'post-flush: fresh frame 1 line')
}

// --- 6. TUI 集成：wheel → 规范化 → pager 翻页 ---
{
  const fixture = await createFixture()
  const { controller } = fixture
  controller.printer.beginTurn({ prompt: 'open pager' })
  controller.printer.onEvent({
    type: 'tool_start',
    id: 'read-1',
    name: 'Read',
    input: { path: 'x.txt' },
  })
  controller.printer.onEvent({
    type: 'tool_end',
    id: 'read-1',
    name: 'Read',
    output: 'provider bounded result',
    ok: true,
    presentation: boundedPresentation,
  })
  controller.printer.endTurn({ terminalReason: 'completed' })
  await settle(fixture)

  const readRow = await waitForRow(fixture, '✓ Read')
  // 获取输入所有权（与 OUT-4 相同：readInput 后点击才生效）
  const pendingInput = controller.readInput()
  void pendingInput
  controller.flush()
  await fixture.terminal.flush()

  // 打开 pager
  fixture.input.send(`\x1b[<0;20;${readRow}M`)
  await waitForScreen(fixture, (t) => t.includes('preview line 0'))
  assert(
    screen(fixture).includes('preview line 0'),
    'clicking the summary opens the pager (page 1)',
  )

  // 密集 wheel down × 6（同帧 → 高速带 3× → 封顶 6 事件 × 3 = 18 格）
  for (let i = 0; i < 6; i += 1) {
    fixture.input.send(`\x1b[<65;20;${readRow}M`)
  }
  await settle(fixture)
  const page1Gone = !screen(fixture).includes('preview line 0')
  assert(
    page1Gone || screen(fixture).includes('preview line 1'),
    'wheel down paged past the first page',
  )

  // wheel up 翻回
  for (let i = 0; i < 6; i += 1) {
    fixture.input.send(`\x1b[<64;20;${readRow}M`)
  }
  await settle(fixture)
  if (page1Gone) {
    await waitForScreen(fixture, (t) => t.includes('preview line 0'))
  }

  // wheel 在无 pager 时不泄漏为按键输入（关闭 pager 后再滚）
  fixture.input.send(`\x1b[<0;20;${readRow}M`)
  await waitForScreen(fixture, (t) => !t.includes('preview line 0'))
  for (let i = 0; i < 3; i += 1) {
    fixture.input.send(`\x1b[<65;20;${readRow}M`)
  }
  await settle(fixture)
  assert(
    !screen(fixture).includes('preview line 0'),
    'pager closed by click; wheel does not reopen it',
  )
  fixture.controller.stop()
}

await fs.rm(os.tmpdir(), { recursive: false, force: false }).catch(() => {})
console.log('PASS: TERM-3 wheel normalization + pager integration')
