/**
 * REN-2 路 checkpoint 娴佸紡娓叉煋锛堝垎鐗囨覆鏌撹皟搴︼級
 *
 * 瑕嗙洊锛? * - 灏忓唴瀹逛竴娆″畬鎴愶紙鏃犲垎鐗囧熬娉級
 * - 澶у唴瀹癸紙>16 鍧楋級鍒嗙墖锛氶甯?incomplete 灏炬敞 鈫?缁抚瀹屾垚
 * - 鏈€缁堜竴鑷达細瀹屾垚鍚庡叏閮ㄥ潡鍐呭鍙
 * - resize 鍏ㄩ噺锛氬搴﹀彉鍖?鈫?杩涘害閲嶇疆锛堟渶缁堜竴鑷达級
 * - 鍒嗙墖鏈熼棿杈撳叆浠嶅彲杈撅紙缁抚 setImmediate 璁╄矾锛? */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

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

type Fixture = {
  controller: CliTuiController
  input: RawInputHarness
  output: ResizableOutput
  terminal: HeadlessTerminalHarness
}

/** REN-2锛氬垎鐗囨覆鏌撶姸鎬侊紙root 鐨?Component 鎺ュ彛涓嶅惈璇ユ柟娉曪紝cast 璇诲彇锛?*/
function renderIncomplete(fixture: Fixture): boolean {
  return (
    fixture.controller.root as unknown as {
      isRenderIncomplete(): boolean
    }
  ).isRenderIncomplete()
}

async function createFixture(columns = 90, rows = 48): Promise<Fixture> {
  const input = new RawInputHarness()
  const output = new ResizableOutput(columns, rows)
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 600,
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

function screen(fixture: Fixture): string {
  return fixture.terminal
    .viewport()
    .map((line) => line.text)
    .join('\n')
}


/** seed N 涓?tool 鍧楋紙姣忓潡 summary 鍚敮涓€鏍囪琛岋級 */
function seedTools(fixture: Fixture, count: number): void {
  const { controller } = fixture
  controller.printer.beginTurn({ prompt: 'many tools' })
  for (let i = 0; i < count; i += 1) {
    controller.printer.onEvent({
      type: 'tool_start',
      id: `t-${i}`,
      name: 'Read',
      input: { path: `f${i}.txt` },
    })
    controller.printer.onEvent({
      type: 'tool_end',
      id: `t-${i}`,
      name: 'Read',
      output: `provider bounded result ${i}`,
      ok: true,
      presentation: {
        summary: `Read 路 f${i}.txt 路 2 lines 路 truncated`,
        preview: `render-slice-mark-${i}\nsecond line ${i}`,
        previewMode: 'head',
        originalChars: 1_000,
        originalLines: 2,
        retainedChars: 200,
        retainedLines: 2,
        truncated: true,
        overflow: true,
      },
    })
  }
  controller.printer.endTurn({ terminalReason: 'completed' })
}
/** seed N 个**交错**工具块（Read/Bash 交替防 OUT-5 聚合——保证独立渲染单元） */
function seedToolsInterleaved(fixture: Fixture, count: number): void {
  const { controller } = fixture
  controller.printer.beginTurn({ prompt: 'interleaved tools' })
  for (let i = 0; i < count; i += 1) {
    const isRead = i % 2 === 0
    controller.printer.onEvent({
      type: 'tool_start',
      id: `t-${i}`,
      name: isRead ? 'Read' : 'Bash',
      input: isRead ? { path: `f${i}.txt` } : { command: `echo ${i}` },
    })
    controller.printer.onEvent({
      type: 'tool_end',
      id: `t-${i}`,
      name: isRead ? 'Read' : 'Bash',
      output: `provider bounded result ${i}`,
      ok: true,
      presentation: {
        summary: `${isRead ? 'Read' : 'Bash'} · item ${i} · truncated`,
        preview: `interleaved-mark-${i}`,
        previewMode: 'head',
        originalChars: 500,
        originalLines: 1,
        retainedChars: 100,
        retainedLines: 1,
        truncated: true,
        overflow: true,
      },
    })
  }
  controller.printer.endTurn({ terminalReason: 'completed' })
}

// --- 1. 灏忓唴瀹逛竴娆″畬鎴愶紙鏃犲垎鐗囧熬娉級---
{
  const fixture = await createFixture()
  seedTools(fixture, 3)
  await fixture.controller.flush()
  await fixture.terminal.flush()
  const text = screen(fixture)
  assert(!text.includes('rendering'), 'small content: no slice tail note')
  assert(text.includes('f2.txt'), 'small content: all blocks visible')
  fixture.controller.stop()
}

// --- 2. 澶у唴瀹瑰垎鐗囷細flush 杩斿洖 = 娓叉煋瀹屾垚锛堝惈缁抚锛夛紝鏈€缁堜竴鑷?---
{
  const fixture = await createFixture()
  seedTools(fixture, 40) // 40 鍧?> 16 棰勭畻
  await fixture.controller.flush()
  await fixture.terminal.flush()
  assert(
    !renderIncomplete(fixture),
    'large content: flush returns with rendering complete',
  )
  const done = screen(fixture)
  assert(
    done.includes('f39.txt'),
    'all blocks eventually rendered (last block visible)',
  )
  fixture.controller.stop()
}

// --- 3. 鏈€缁堜竴鑷达細瀹屾垚鎬佹棤鍒嗙墖鐘舵€?+ 鍏ㄩ儴鍧楀彲瑙?---
{
  const fixture = await createFixture()
  seedTools(fixture, 20)
  await fixture.controller.flush()
  await fixture.terminal.flush()
  const done = screen(fixture)
  assert(!done.includes('rendering'), 'consistency: no tail note at end')
  assert(done.includes('f19.txt'), 'consistency: last block visible')
  assert(
    renderIncomplete(fixture) === false,
    'consistency: not incomplete',
  )
  fixture.controller.stop()
}

// --- 4. mid-slice resize：分片进行中宽度变化 → flush 不挂起且最终一致 ---
{
  const fixture = await createFixture(90, 48)
  // 交错 120 块（防聚合——独立渲染单元；行数远超 tailWindowLineBudget，
  // 完成一轮分片后 seededFullHistory 置位）
  seedToolsInterleaved(fixture, 120)
  await fixture.controller.flush()
  await fixture.terminal.flush()
  // 再交 30 块——触发新一轮分片（>16 units）
  seedToolsInterleaved(fixture, 30)
  // fire-and-forget flush（新分片进行中）
  const flushing = fixture.controller.flush()
  await new Promise<void>((r) => setImmediate(r))
  // 分片进行中 resize（更窄）——seededFullHistory 已置位 + 块数 > 100 →
  // tailWindow 被触发；预修复代码 renderIncomplete 残留 → flush 死循环
  fixture.output.resize(70, 48)
  // 核心断言：flush 必须在超时内返回（预修复代码此处永久挂起）
  let hangTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      flushing,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error('flush hung: mid-slice resize deadloop (REN-2)')),
          5_000,
        )
      }),
    ])
  } finally {
    if (hangTimer !== undefined) clearTimeout(hangTimer)
  }
  await fixture.terminal.flush()
  assert(
    !renderIncomplete(fixture),
    'mid-slice resize: rendering complete (no hang)',
  )
  fixture.controller.stop()
}
// --- 5. 鍒嗙墖鏈熼棿杈撳叆鍙揪锛堢画甯?setImmediate 璁╄矾锛岃緭鍏ヤ笉涓級---
{
  const fixture = await createFixture()
  seedTools(fixture, 30)
  const pendingInput = fixture.controller.readInput()
  void pendingInput
  await fixture.controller.flush()
  await fixture.terminal.flush()
  // 鍒嗙墖娓叉煋瀹屾垚鍚庡彂閫佽緭鍏ワ紙esc 閿€斺€攃omposer 鍦烘櫙锛夛紝杈撳叆浠嶈澶勭悊
  fixture.input.send('\x1b')
  await fixture.controller.flush()
  await fixture.terminal.flush()
  const done = screen(fixture)
  assert(done.includes('f29.txt'), 'input: rendering completed')
  assert(
    !renderIncomplete(fixture),
    'input: rendering complete',
  )
  fixture.controller.stop()
}

console.log('PASS: REN-2 checkpoint sliced rendering')
