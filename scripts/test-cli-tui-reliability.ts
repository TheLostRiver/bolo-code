/**
 * OI-14G: long-session scrollback and repeated resize reliability.
 *
 * The fixture is rendered by @xterm/headless. Assertions inspect its real
 * primary buffer, viewport, cell widths and native scroll position.
 */
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
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
  output: ResizableOutput
  terminal: HeadlessTerminalHarness
  writes: string[]
}

function createLongHistory(): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let turn = 0; turn < 250; turn += 1) {
    const turnId = String(turn).padStart(3, '0')
    messages.push({
      role: 'user',
      content: `history user ${turnId}`,
    })
    messages.push({
      role: 'assistant',
      content: Array.from(
        { length: 39 },
        (_, line) =>
          `t${turnId} l${String(line).padStart(2, '0')} 中✅`,
      ).join('\n'),
    })
  }
  return messages
}

async function createFixture(
  columns = 80,
  rows = 40,
): Promise<Fixture> {
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 250_000,
  })
  const output = new ResizableOutput(columns, rows)
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
    output,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  await controller.start()
  await terminal.flush()
  return { controller, output, terminal, writes }
}

function bufferText(terminal: HeadlessTerminalHarness): string {
  return terminal
    .snapshot()
    .lines.map((line) => line.text)
    .join('\n')
}

function normalizedBufferText(
  terminal: HeadlessTerminalHarness,
): string {
  return bufferText(terminal).replace(/\s+/gu, ' ').trim()
}

function assertViewportFits(
  terminal: HeadlessTerminalHarness,
  columns: number,
  label: string,
): void {
  for (const line of terminal.viewport()) {
    const measured = measureTerminalText(line.text)
    assert(
      measured <= columns,
      `${label}: row ${line.index} measures ${measured}/${columns} cells; ` +
        `text=${JSON.stringify(line.text)}`,
    )
  }
}

async function main(): Promise<void> {
  const fixture = await createFixture()
  try {
    const history = createLongHistory()
    const sourceLines = history.reduce(
      (sum, message) => sum + message.content.split('\n').length,
      0,
    )
    assert(history.length === 500, 'fixture has exactly 500 transcript blocks')
    assert(sourceLines === 10_000, 'fixture has exactly 10,000 source lines')

    const initialStartedAt = performance.now()
    fixture.controller.restoreMessages(history)
    await fixture.controller.flush()
    await fixture.terminal.flush()
    const initialRenderMs = performance.now() - initialStartedAt

    const state = fixture.controller.getState()
    const blockCount = state.turns.reduce(
      (sum, turn) => sum + turn.blocks.length,
      0,
    )
    assert(blockCount === 500, 'restore projection keeps all 500 blocks')

    const initial = fixture.terminal.snapshot()
    assert(initial.baseY > 0, 'long transcript enters native scrollback')
    assert(
      initial.viewportY === initial.baseY,
      'initial long transcript follows the bottom viewport',
    )
    const initialBuffer = bufferText(fixture.terminal)
    assert(
      initialBuffer.includes('history user 000'),
      'native scrollback retains the first history marker',
    )
    assert(
      initialBuffer.includes('t249 l38'),
      'native scrollback retains the last restored marker',
    )
    assertViewportFits(fixture.terminal, 80, 'initial long transcript')

    fixture.terminal.scrollLines(-Math.min(200, initial.baseY))
    const scrolled = fixture.terminal.snapshot()
    assert(
      scrolled.viewportY < scrolled.baseY,
      'the user can scroll away from the live bottom',
    )

    fixture.controller.printer.beginTurn({
      prompt: 'live user tail marker',
      echoUser: true,
      activity: false,
    })
    fixture.controller.printer.onEvent({
      type: 'text',
      text: 'live assistant tail marker',
    })
    fixture.controller.printer.endTurn({ terminalReason: 'completed' })
    await fixture.controller.flush()
    await fixture.terminal.flush()
    const afterLiveTurn = fixture.terminal.snapshot()
    assert(
      afterLiveTurn.viewportY < afterLiveTurn.baseY,
      'a live turn does not force a scrolled user back to the bottom',
    )

    const resizeDurations: number[] = []
    for (const columns of [24, 220, 38, 160, 31, 120, 48, 80]) {
      const epoch = fixture.controller.getRenderEpoch()
      const startedAt = performance.now()
      fixture.terminal.resize(columns, 40)
      fixture.output.resize(columns, 40)
      await fixture.controller.waitForRender(epoch)
      await fixture.terminal.flush()
      resizeDurations.push(performance.now() - startedAt)

      const snapshot = fixture.terminal.snapshot()
      assert(
        snapshot.viewportY < snapshot.baseY,
        `${columns}-column resize preserves the user's scroll position`,
      )
      const text = normalizedBufferText(fixture.terminal)
      assert(
        text.includes('history user 000'),
        `${columns}-column resize retains the first marker`,
      )
      assert(
        text.includes('live assistant tail marker'),
        `${columns}-column resize retains the live tail`,
      )

      const distanceFromBottom = snapshot.baseY - snapshot.viewportY
      fixture.terminal.scrollLines(distanceFromBottom)
      const bottom = fixture.terminal.snapshot()
      assert(
        bottom.viewportY === bottom.baseY,
        `${columns}-column viewport can inspect the live bottom`,
      )
      assertViewportFits(
        fixture.terminal,
        columns,
        `${columns}-column live bottom`,
      )
      fixture.terminal.scrollLines(-distanceFromBottom)
      const restoredScroll = fixture.terminal.snapshot()
      assert(
        restoredScroll.viewportY < restoredScroll.baseY,
        `${columns}-column check restores the user's scroll position`,
      )
    }

    const beforeBottom = fixture.terminal.snapshot()
    fixture.terminal.scrollLines(beforeBottom.baseY)
    const atBottom = fixture.terminal.snapshot()
    assert(
      atBottom.viewportY === atBottom.baseY,
      'the user can return to the live bottom after repeated resize',
    )
    assertViewportFits(fixture.terminal, 80, 'final bottom viewport')
    assert(
      fixture.terminal
        .viewport()
        .some((line) => line.text.includes('live assistant tail marker')),
      'the final bottom viewport shows the live tail',
    )

    const stats = fixture.controller.getTerminalStats()
    assert(
      stats.filteredScrollbackClears >= 8,
      'the adapter filters every resize scrollback clear',
    )
    assert(stats.externalWrites === 0, 'long session keeps one writer')
    assert(
      stats.concurrentWriteViolations === 0,
      'long session never overlaps terminal owners',
    )
    assert(
      !fixture.writes.join('').includes('\u001b[3J'),
      'long-session output never deletes native scrollback',
    )

    const sortedResize = [...resizeDurations].sort((a, b) => a - b)
    const resizeP95 =
      sortedResize[Math.ceil(sortedResize.length * 0.95) - 1] ?? 0
    console.log(
      `PASS: CLI TUI long-session reliability ` +
        `(initial=${initialRenderMs.toFixed(1)}ms, resize-p95=${resizeP95.toFixed(1)}ms)`,
    )
  } finally {
    await fixture.controller.stop()
    fixture.terminal.dispose()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
