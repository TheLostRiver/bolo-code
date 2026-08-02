/**
 * OUT-4: SGR mouse — shared parser, adapter enable/disable lifecycle,
 * transcript hit regions, and click-to-open/close of the tool pager.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  isSgrMouseSequence,
  parseSgrMouseSequence,
  SGR_MOUSE_DISABLE,
  SGR_MOUSE_ENABLE,
  type ToolPresentation,
} from '../packages/shared/src/index.ts'
import type {
  RuntimeListView,
  RuntimeTurnListItem,
} from '../packages/shared/src/runtimeQuery.ts'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { writeToolResultFile } from '../packages/core/src/index.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

const longPresentation: ToolPresentation = {
  summary: 'Read · large.txt · 1000 lines · truncated',
  preview: 'preview first line\npreview second line\npreview third',
  previewMode: 'head',
  originalChars: 100_000,
  originalLines: 1_000,
  retainedChars: 2_000,
  retainedLines: 20,
  truncated: true,
  overflow: true,
}

const grepPresentation: ToolPresentation = {
  summary: 'Grep · src/ · 42 matches',
  preview: 'grep preview body line one\ngrep preview body line two',
  previewMode: 'head',
  originalChars: 10_000,
  originalLines: 42,
  retainedChars: 1_000,
  retainedLines: 10,
  truncated: true,
  overflow: true,
}

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
  writes: string[]
}

async function createFixture(columns = 76, rows = 40): Promise<Fixture> {
  const input = new RawInputHarness()
  const output = new ResizableOutput(columns, rows)
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 400,
  })
  const writes: string[] = []
  const controller = createRetainedTuiController({
    writeOut: (text) => {
      writes.push(text)
      terminal.write(text)
    },
    writeErr: (text) => {
      writes.push(text)
      terminal.write(text)
    },
    input,
    output,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  await controller.start()
  await terminal.flush()
  return { controller, input, output, terminal, writes }
}

function screen(fixture: Fixture): string {
  return fixture.terminal
    .viewport()
    .map((line) => line.text)
    .join('\n')
}

function findRow(fixture: Fixture, marker: string): number {
  const line = fixture.terminal
    .viewport()
    .find((entry) => entry.text.includes(marker))
  assert(line, `row containing ${JSON.stringify(marker)} is visible`)
  return line.index + 1
}

async function settle(fixture: Fixture): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  await fixture.controller.flush()
  await fixture.terminal.flush()
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`FAIL: ${message}`)
}

const FIXTURE_TIME = '2026-08-02T12:00:00.000Z'

function createRuntimeListView(count: number): RuntimeListView {
  const items: RuntimeTurnListItem[] = Array.from(
    { length: count },
    (_, index) => {
      const turnId = `turn_${index + 1}`
      return {
        entity: 'turn',
        entityId: turnId,
        record: {
          turnId,
          state: 'completed',
          updatedAt: FIXTURE_TIME,
          terminalReason: 'completed',
        },
        availableActions: [],
      }
    },
  )
  return {
    protocolVersion: 1,
    kind: 'runtime.list',
    generatedAt: FIXTURE_TIME,
    sessionId: 'mouse_runtime_session',
    phase: 'idle',
    runner: { state: 'idle' },
    entity: 'turn',
    items,
  }
}

function seedTwoTools(fixture: Fixture): void {  fixture.controller.printer.beginTurn({ prompt: 'read and grep' })
  fixture.controller.printer.onEvent({
    type: 'tool_start',
    id: 'read-1',
    name: 'Read',
    input: { path: 'large.txt' },
  })
  fixture.controller.printer.onEvent({
    type: 'tool_end',
    id: 'read-1',
    name: 'Read',
    output: 'provider bounded result',
    ok: true,
    presentation: longPresentation,
  })
  // 写工具切断 OUT-5 的相邻只读聚合，让本测试保持单块布局
  fixture.controller.printer.onEvent({
    type: 'tool_start',
    id: 'write-1',
    name: 'Write',
    input: { path: 'out.txt' },
  })
  fixture.controller.printer.onEvent({
    type: 'tool_end',
    id: 'write-1',
    name: 'Write',
    output: 'written',
    ok: true,
  })
  fixture.controller.printer.onEvent({
    type: 'tool_start',
    id: 'grep-1',
    name: 'Grep',
    input: { query: 'marker' },
  })
  fixture.controller.printer.onEvent({
    type: 'tool_end',
    id: 'grep-1',
    name: 'Grep',
    output: 'provider bounded grep result',
    ok: true,
    presentation: grepPresentation,
  })
  fixture.controller.printer.endTurn({ terminalReason: 'completed' })
}

function clickAt(fixture: Fixture, column: number, row: number): void {
  fixture.input.send(`\x1b[<0;${column};${row}M`)
}

async function main(): Promise<void> {
  // ---- shared SGR parser ----
  const press = parseSgrMouseSequence('\x1b[<0;20;5M')
  assert(
    press?.kind === 'press' &&
      press.button === 0 &&
      press.x === 20 &&
      press.y === 5,
    'plain left press parses button/x/y',
  )
  const rightPress = parseSgrMouseSequence('\x1b[<2;10;3M')
  assert(
    rightPress?.kind === 'press' && rightPress.button === 2,
    'right button press parses',
  )
  const shiftPress = parseSgrMouseSequence('\x1b[<4;20;5M')
  assert(
    shiftPress?.kind === 'press' &&
      shiftPress.shift &&
      !shiftPress.ctrl,
    'shift modifier parses from the button field',
  )
  const release = parseSgrMouseSequence('\x1b[<0;20;5m')
  assert(
    release?.kind === 'release' &&
      release.x === 20 &&
      release.y === 5,
    'lowercase m parses as release',
  )
  const wheelUp = parseSgrMouseSequence('\x1b[<64;20;5M')
  assert(
    wheelUp?.kind === 'wheel' && wheelUp.direction === 'up',
    'button 64 parses as wheel up',
  )
  const wheelDown = parseSgrMouseSequence('\x1b[<65;20;5M')
  assert(
    wheelDown?.kind === 'wheel' && wheelDown.direction === 'down',
    'button 65 parses as wheel down',
  )
  const drag = parseSgrMouseSequence('\x1b[<32;20;5M')
  assert(
    drag?.kind === 'drag' && drag.button === 0,
    'motion bit parses as drag',
  )
  for (const nonMouse of [
    'x',
    '\x1b[<0;20;5',
    '\x1b[<0;0;5M',
    '\x1b[<0;20;0M',
    '\x1b[<a;20;5M',
    '\x1b[200~',
    '\x1b[<0;20;5u',
  ]) {
    assert(
      parseSgrMouseSequence(nonMouse) === undefined &&
        !isSgrMouseSequence(nonMouse),
      `non-mouse or malformed input is rejected: ${JSON.stringify(nonMouse)}`,
    )
  }
  assert(
    parseSgrMouseSequence('\x1b[<3;20;5M') === undefined,
    'non-standard press button (3) never parses to a click',
  )
  assert(
    parseSgrMouseSequence('\x1b[<0;20;5M\x1b[<0;21;5M') === undefined,
    'parser contract is one complete SGR sequence per input; ' +
      'concatenated events are split upstream by StdinBuffer',
  )
  assert(
    isSgrMouseSequence('\x1b[<0;20;5M') &&
      !isSgrMouseSequence('\x1b[200~'),
    'isSgrMouseSequence matches SGR mouse only',
  )

  // ---- adapter enable/disable lifecycle ----
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(80, 24)
    const writes: string[] = []
    const controller = createRetainedTuiController({
      writeOut: (text) => writes.push(text),
      writeErr: (text) => writes.push(text),
      input,
      output,
      env: { NO_COLOR: '1' },
    })
    await controller.start()
    controller.setWelcomeVisible(false)
    await controller.flush()
    assert(
      !writes.join('').includes('\x1b[?1000h'),
      'mouse reporting stays off until input is acquired',
    )
    const pending = controller.readInput()
    assert(
      writes.join('').includes(SGR_MOUSE_ENABLE),
      'acquiring raw input enables SGR mouse reporting',
    )
    assert(
      !writes.join('').includes(SGR_MOUSE_DISABLE),
      'no disable is emitted while input stays active',
    )
    await controller.stop()
    assert(
      writes.join('').includes(SGR_MOUSE_DISABLE),
      'stopping the controller disables mouse reporting',
    )
    await pending
  }
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(80, 24)
    const writes: string[] = []
    const controller = createRetainedTuiController({
      writeOut: (text) => writes.push(text),
      writeErr: (text) => writes.push(text),
      input,
      output,
      env: { NO_COLOR: '1', TERM: 'dumb' },
    })
    await controller.start()
    controller.setWelcomeVisible(false)
    await controller.flush()
    const pending = controller.readInput()
    assert(
      !writes.join('').includes('\x1b[?1000h'),
      'dumb terminals never enable SGR mouse reporting',
    )
    await controller.stop()
    await pending
  }

  // ---- retained click integration ----
  const fixture = await createFixture()
  try {
    seedTwoTools(fixture)
    await settle(fixture)
    const readRow = findRow(fixture, '✓ Read')
    const grepRow = findRow(fixture, '✓ Grep')
    assert(
      screen(fixture).includes(longPresentation.summary) &&
        !screen(fixture).includes('preview first line'),
      'long tools render as collapsed summaries before any click',
    )

    // Input is not acquired yet: a click must do nothing.
    clickAt(fixture, 20, readRow)
    await settle(fixture)
    assert(
      !screen(fixture).includes('preview first line'),
      'clicks are inert while raw input is not acquired',
    )

    const pendingInput = fixture.controller.readInput()
    void pendingInput
    clickAt(fixture, 20, readRow)
    await settle(fixture)
    assert(
      screen(fixture).includes('preview first line') &&
        screen(fixture).includes('preview second line'),
      'clicking a collapsed overflow summary opens its bounded pager',
    )

    clickAt(fixture, 20, readRow)
    await settle(fixture)
    assert(
      !screen(fixture).includes('preview first line') &&
        screen(fixture).includes(longPresentation.summary),
      'clicking the same summary again closes the pager',
    )

    clickAt(fixture, 20, grepRow)
    await settle(fixture)
    assert(
      screen(fixture).includes('grep preview body line one') &&
        !screen(fixture).includes('preview first line'),
      'clicking another overflow block switches the pager to it',
    )
    clickAt(fixture, 20, grepRow)
    await settle(fixture)

    // Wheel and release sequences never open or close the pager.
    fixture.input.send(`\x1b[<64;20;${readRow}M`)
    await settle(fixture)
    assert(
      !screen(fixture).includes('preview first line'),
      'wheel events do not activate tool blocks',
    )
    fixture.input.send(`\x1b[<0;20;${readRow}m`)
    await settle(fixture)
    assert(
      !screen(fixture).includes('preview first line'),
      'release events do not activate tool blocks',
    )

    // Clicking blank space keeps the current state.
    fixture.input.send(`\x1b[<0;20;${fixture.output.rows}M`)
    await settle(fixture)
    assert(
      !screen(fixture).includes('preview first line'),
      'clicks outside any tool hit region are ignored',
    )

    // A short non-overflow block has no hit region.
    fixture.controller.printer.beginTurn({ prompt: 'short' })
    fixture.controller.printer.onEvent({
      type: 'tool_start',
      id: 'short-1',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
    })
    fixture.controller.printer.onEvent({
      type: 'tool_end',
      id: 'short-1',
      name: 'Glob',
      output: 'short result',
      ok: true,
    })
    fixture.controller.printer.endTurn({ terminalReason: 'completed' })
    await settle(fixture)
    const shortRow = findRow(fixture, '✓ Glob')
    clickAt(fixture, 20, shortRow)
    await settle(fixture)
    assert(
      !screen(fixture).includes('Glob · result') &&
        !screen(fixture).includes('preview first line'),
      'short non-overflow blocks register no hit region and open no pager',
    )

    // A runtime pager owns the embedded slot: clicks must neither interrupt
    // it nor silently attempt a tool pager.
    const runtimePager = fixture.controller.runPagerOverlay({
      view: createRuntimeListView(3),
      pageSize: 2,
    })
    await settle(fixture)
    assert(
      /page 1\/2/iu.test(screen(fixture)),
      'runtime pager opens inside the embedded slot',
    )
    clickAt(fixture, 20, readRow)
    await settle(fixture)
    assert(
      /page 1\/2/iu.test(screen(fixture)) &&
        !screen(fixture).includes('preview first line'),
      'clicks are inert while a runtime pager owns the embedded slot',
    )
    fixture.input.send('q')
    const runtimeResult = await runtimePager
    assert(
      runtimeResult.ok && runtimeResult.reason === 'quit',
      'runtime pager still closes via keyboard while mouse is enabled',
    )
  } finally {
    await fixture.controller.stop()
    fixture.terminal.dispose()
  }

  // ---- lazy file-backed pager via click ----
  const root = path.resolve('.bolo-tmp', 'test-tool-output-mouse')
  const cwd = path.join(root, 'workspace')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(cwd, { recursive: true })
  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(root, 'user')
  try {
    const spillText = Array.from(
      { length: 300 },
      (_, index) => `spill-line-${index}`,
    ).join('\n')
    const reference = await writeToolResultFile({
      cwd,
      sessionId: 'mouse-session',
      toolUseId: 'read/large',
      content: spillText,
    })
    assert(reference, 'spill reference is written')

    const lazyFixture = await createFixture(76, 48)
    try {
      lazyFixture.controller.setToolPagerContext({
        cwd,
        sessionId: 'mouse-session',
      })
      lazyFixture.controller.printer.beginTurn({ prompt: 'read spill' })
      lazyFixture.controller.printer.onEvent({
        type: 'tool_start',
        id: 'read-2',
        name: 'Read',
        input: { path: 'spill.txt' },
      })
      lazyFixture.controller.printer.onEvent({
        type: 'tool_end',
        id: 'read-2',
        name: 'Read',
        output: 'bounded provider result',
        ok: true,
        presentation: {
          ...longPresentation,
          summary: 'Read · spill.txt · 300 lines · truncated',
          preview: 'bounded preview of the spill',
          fullResult: reference!,
        },
      })
      lazyFixture.controller.printer.endTurn({
        terminalReason: 'completed',
      })
      await settle(lazyFixture)
      const row = findRow(lazyFixture, '✓ Read')
      const pendingLazy = lazyFixture.controller.readInput()
      void pendingLazy
      clickAt(lazyFixture, 20, row)
      await waitFor(
        () => screen(lazyFixture).includes('spill-line-0'),
        'clicking a spill-backed summary opens the file pager content',
      )
      assert(
        screen(lazyFixture).includes('spill-line-17') &&
          !screen(lazyFixture).includes('spill-line-18'),
        'the first lazy page stays bounded to one page of the spill',
      )
      clickAt(lazyFixture, 20, row)
      await settle(lazyFixture)
      assert(
        !screen(lazyFixture).includes('spill-line-0'),
        'clicking the spill summary again closes the file pager',
      )
    } finally {
      await lazyFixture.controller.stop()
      lazyFixture.terminal.dispose()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    if (previousConfigDir === undefined) {
      delete process.env.BOLO_CONFIG_DIR
    } else {
      process.env.BOLO_CONFIG_DIR = previousConfigDir
    }
  }

  console.log('PASS: OUT-4 SGR mouse')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
