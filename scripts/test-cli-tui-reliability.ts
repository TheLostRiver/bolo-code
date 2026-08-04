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

class RawInputHarness extends EventEmitter {
  readonly isTTY = true
  isRaw = false
  readonly rawTransitions: boolean[] = []

  setRawMode(mode: boolean): this {
    this.rawTransitions.push(mode)
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

type Fixture = {
  controller: CliTuiController
  input: RawInputHarness
  output: ResizableOutput
  terminal: HeadlessTerminalHarness
  writes: string[]
}

const permissionRequest = {
  toolName: 'Bash',
  toolInput: {
    command: 'npm.cmd run test:cli-tui-reliability',
    timeout: 120_000,
    run_in_background: false,
    description: 'Verify long-session retained reliability',
  },
  toolUseId: 'reliability_permission_1',
  cwd: 'E:\\DEV\\HelsincyAgent',
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
        (_, line) => {
          if (turn === 125 && line === 10) {
            return (
              'long-url-marker ' +
              'https://example.test/reliability/a/very/long/path/' +
              'that/reflows/without/losing/history?mode=retained'
            )
          }
          return `t${turnId} l${String(line).padStart(2, '0')} 中✅`
        },
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
  const input = new RawInputHarness()
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
    input,
    output,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  await controller.start()
  await terminal.flush()
  return { controller, input, output, terminal, writes }
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
    assert(
      initialBuffer.includes('long-url-marker'),
      'native scrollback retains the long URL source marker',
    )
    assertViewportFits(fixture.terminal, 80, 'initial long transcript')

    fixture.terminal.scrollLines(-Math.min(200, initial.baseY))
    const scrolled = fixture.terminal.snapshot()
    assert(
      scrolled.viewportY < scrolled.baseY,
      'the user can scroll away from the live bottom',
    )

    const burstEpoch = fixture.controller.getRenderEpoch()
    fixture.controller.printer.beginTurn({
      prompt: 'live user tail marker',
      echoUser: true,
      activity: false,
    })
    fixture.controller.printer.onEvent({
      type: 'text',
      text: 'live assistant tail marker',
    })
    for (let index = 0; index < 6; index += 1) {
      const id = `reliability-tool-${index}`
      fixture.controller.printer.onEvent({
        type: 'tool_start',
        id,
        name: 'Bash',
        input: { command: `echo tool-reliability-${index}` },
        argumentsJson: JSON.stringify({
          command: `echo tool-reliability-${index}`,
        }),
      })
      fixture.controller.printer.onEvent({
        type: 'tool_progress',
        id,
        name: 'Bash',
        message: `tool progress reliability ${index}`,
      })
      fixture.controller.printer.onEvent({
        type: 'tool_end',
        id,
        name: 'Bash',
        output: `tool output reliability ${index}`,
        ok: true,
      })
      fixture.controller.printer.onEvent({
        type: 'web_search',
        phase: 'query',
        query: `search reliability ${index}`,
      })
      fixture.controller.printer.onEvent({
        type: 'web_search',
        phase: 'results',
        resultCount: index + 1,
      })
      fixture.controller.printer.onEvent({
        type: 'web_search',
        phase: 'citation',
        title: `result reliability ${index}`,
        url: `https://search.example.test/result/${index}`,
      })
    }
    fixture.controller.printer.endTurn({ terminalReason: 'completed' })
    await fixture.controller.flush()
    await fixture.terminal.flush()
    // REN-2：burst 事件合并为一次 flush（epoch 不随事件数增长）；
    // 大 transcript（数百块）分片渲染产生固定数量的续帧——上限内即合并成功
    assert(
      fixture.controller.getRenderEpoch() - burstEpoch <= 40,
      'stream/tool/search burst is coalesced into bounded retained frames',
    )
    const afterLiveTurn = fixture.terminal.snapshot()
    assert(
      afterLiveTurn.viewportY < afterLiveTurn.baseY,
      'a live turn does not force a scrolled user back to the bottom',
    )
    const liveBuffer = normalizedBufferText(fixture.terminal)
    assert(
      liveBuffer.includes('tool output reliability 5'),
      'continuous tool updates retain their final result',
    )
    assert(
      liveBuffer.includes('search reliability 5'),
      'continuous search updates retain their final query',
    )

    const resizeDurations: number[] = []
    const resizeTrace: string[] = []
    for (const columns of [24, 220, 38, 160, 31, 120, 48, 80]) {
      const epoch = fixture.controller.getRenderEpoch()
      fixture.terminal.resize(columns, 40)
      const startedAt = performance.now()
      fixture.output.resize(columns, 40)
      await fixture.controller.waitForRender(epoch)
      await fixture.terminal.flush()
      const resizeMs = performance.now() - startedAt
      resizeDurations.push(resizeMs)
      resizeTrace.push(`${columns}:${resizeMs.toFixed(1)}ms`)

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

    fixture.controller.configureComposer({
      history: ['older prompt', 'newer prompt'],
    })
    const listenersBeforeInput = fixture.input.listenerCount('data')
    const inputResult = fixture.controller.readInput()
    assert(fixture.input.isRaw, 'long-session input acquires raw mode')
    const inputLatencies: number[] = []
    for (let index = 0; index < 48; index += 1) {
      const startedAt = performance.now()
      fixture.input.send('x')
      inputLatencies.push(performance.now() - startedAt)
    }
    inputLatencies.sort((left, right) => left - right)
    const inputP95 =
      inputLatencies[Math.ceil(inputLatencies.length * 0.95) - 1] ??
      Infinity
    assert(
      inputP95 <= 50,
      `long-session input p95 must stay <= 50ms, got ${inputP95.toFixed(1)}ms`,
    )
    fixture.input.send('\u0015')
    const pasteEpoch = fixture.controller.getRenderEpoch()
    fixture.input.send('\u001b[200~first\r\n')
    fixture.input.send('第二行✅')
    assert(
      fixture.controller.composer.getState().value === '',
      'running paste does not leak partial chunks into the Composer',
    )
    fixture.input.send('\u001b[201~')
    await fixture.controller.flush()
    await fixture.terminal.flush()
    const pastedValue = 'first\n第二行✅'
    assert(
      fixture.controller.composer.getState().value === pastedValue,
      'long-session paste commits normalized multiline text once',
    )
    assert(
      fixture.controller.getRenderEpoch() - pasteEpoch <= 1,
      'long-session paste remains one retained frame',
    )
    fixture.input.send('!')
    const composer = fixture.controller.composer
    const beforeOverlay = composer.getState()
    const stableComposer = {
      value: beforeOverlay.value,
      cursor: beforeOverlay.cursor,
      history: [...beforeOverlay.history],
      historyIndex: beforeOverlay.historyIndex,
      historyDraft: beforeOverlay.historyDraft,
    }

    const permission = fixture.controller.runPermissionOverlay({
      request: permissionRequest,
    })
    await fixture.controller.flush()
    await fixture.terminal.flush()
    const permissionScreen = fixture.terminal
      .viewport()
      .map((line) => line.text)
      .join('\n')
    assert(
      fixture.controller.getState().overlay.mode === 'permission',
      'permission opens over the long transcript',
    )
    assert(
      permissionScreen.includes(
        'npm.cmd run test:cli-tui-reliability',
      ),
      'long-session permission shows the complete command',
    )
    assert(
      fixture.controller.composer === composer,
      'overlay keeps the same long-session Composer component',
    )
    assert(
      JSON.stringify({
        value: composer.getState().value,
        cursor: composer.getState().cursor,
        history: composer.getState().history,
        historyIndex: composer.getState().historyIndex,
        historyDraft: composer.getState().historyDraft,
      }) === JSON.stringify(stableComposer),
      'overlay opening preserves draft, cursor and history state',
    )
    assert(
      fixture.input.isRaw &&
        fixture.input.rawTransitions.join(',') === 'true',
      'overlay reuses the existing raw input owner',
    )

    fixture.input.send('n')
    assert((await permission) === 'deny', 'permission closes with deny')
    await fixture.controller.flush()
    await fixture.terminal.flush()
    assert(
      fixture.controller.getState().overlay.mode === 'none',
      'permission roundtrip restores the root',
    )
    assert(
      fixture.controller.composer === composer &&
        composer.getState().value === stableComposer.value &&
        composer.getState().cursor === stableComposer.cursor,
      'permission return preserves Composer identity, draft and cursor',
    )
    fixture.input.send('\u001a')
    assert(
      composer.getState().value === pastedValue,
      'undo history survives the permission roundtrip',
    )
    fixture.input.send('\u0003')
    assert((await inputResult).type === 'exit', 'input exits after overlay return')
    assert(!fixture.input.isRaw, 'input exit restores cooked mode')
    assert(
      fixture.input.listenerCount('data') === listenersBeforeInput,
      'input exit releases the only data listener',
    )

    assertViewportFits(fixture.terminal, 80, 'final bottom viewport')
    assert(
      fixture.terminal
        .viewport()
        .some((line) => line.text.includes('search reliability 5')),
      'the final bottom viewport shows the latest search block',
    )

    const stats = fixture.controller.getTerminalStats()
    assert(
      stats.filteredScrollbackClears >= 8,
      'the adapter filters every resize scrollback clear',
    )
    assert(
      !fixture.writes.join('').includes('\u001b[3J'),
      'long-session output never deletes native scrollback',
    )

    const sortedResize = [...resizeDurations].sort((a, b) => a - b)
    const resizeP95 =
      sortedResize[Math.ceil(sortedResize.length * 0.95) - 1] ?? 0
    assert(
      resizeP95 <= 200,
      `long-session resize p95 must stay <= 200ms, got ` +
        `${resizeP95.toFixed(1)}ms; samples=${resizeTrace.join(',')}`,
    )
    console.log(
      `PASS: CLI TUI long-session reliability ` +
        `(initial=${initialRenderMs.toFixed(1)}ms, ` +
        `input-p95=${inputP95.toFixed(1)}ms, ` +
        `resize-p95=${resizeP95.toFixed(1)}ms)`,
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
