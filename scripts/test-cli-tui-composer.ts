/**
 * OI-14E: retained Composer, Activity and Footer through a real xterm buffer.
 */
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
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
  private paused = true

  constructor(private readonly failRawEnable = false) {
    super()
  }

  setRawMode(mode: boolean): this {
    this.rawTransitions.push(mode)
    if (mode && this.failRawEnable) {
      throw new Error('raw-mode fixture failure')
    }
    this.isRaw = mode
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  pause(): this {
    this.paused = true
    return this
  }

  isPaused(): boolean {
    return this.paused
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
  setNow(value: number): void
}

const slashCandidates = [
  {
    name: 'doctor',
    description: 'Show local diagnostics',
    source: 'builtin' as const,
  },
  {
    name: 'diff',
    description: 'Inspect file changes',
    source: 'builtin' as const,
  },
  {
    name: 'effort',
    description: 'Set reasoning effort',
    argumentHint: '[low|high|auto]',
    source: 'builtin' as const,
  },
  {
    name: 'demo:review',
    description: 'Review changes from the demo plugin',
    source: 'plugin' as const,
    sourceLabel: 'demo',
  },
]

const composerStatus = {
  permissionMode: 'ask',
  providerId: 'openai',
  providerKind: 'openai-responses',
  model: 'gpt-5.4',
  effortLevel: 'high',
  usage: {
    inputTokens: 20_234,
    outputTokens: 1_500,
  },
}

async function createFixture(
  columns = 80,
  rows = 96,
  input = new RawInputHarness(),
): Promise<Fixture> {
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 1_000,
  })
  const output = new ResizableOutput(columns, rows)
  const writes: string[] = []
  let now = 0
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
    color: false,
    env: { NO_COLOR: '1' },
    now: () => now,
    activityIntervalMs: 100,
  })
  controller.setWelcomeVisible(false)
  controller.configureComposer({
    history: ['older prompt'],
    slashCandidates,
    status: composerStatus,
  })
  await controller.start()
  await settle(controller, terminal)
  return {
    controller,
    input,
    output,
    terminal,
    writes,
    setNow(value) {
      now = value
    },
  }
}

async function settle(
  controller: CliTuiController,
  terminal: HeadlessTerminalHarness,
): Promise<void> {
  await controller.flush()
  await terminal.flush()
}

function renderedText(fixture: Fixture): string {
  return fixture.terminal
    .viewport()
    .map((line) => line.text)
    .join('\n')
}

function assertFrameFits(
  fixture: Fixture,
  columns: number,
  label: string,
): void {
  for (const line of fixture.terminal.viewport()) {
    assert(
      measureTerminalText(line.text) <= columns,
      `${label}: row ${line.index} exceeds ${columns} cells`,
    )
    assert(
      !line.isWrapped,
      `${label}: logical row ${line.index} triggered terminal auto-wrap`,
    )
  }
}

function activityLine(fixture: Fixture): string | undefined {
  return fixture.terminal
    .viewport()
    .map((line) => line.text)
    .find((line) => /[✦✧✶].*Thinking/u.test(line))
}

async function dispose(fixture: Fixture | undefined): Promise<void> {
  if (!fixture) return
  await fixture.controller.stop()
  fixture.terminal.dispose()
}

async function main(): Promise<void> {
  let fixture: Fixture | undefined
  const widthFixtures: Fixture[] = []
  try {
    fixture = await createFixture()
    const composer = fixture.controller.composer
    let text = renderedText(fixture)
    assert(text.includes('Message'), 'idle retained root contains the Composer')
    assert(text.includes('gpt-5.4'), 'footer shows the active model')
    assert(text.includes('effort high'), 'footer shows the effort level')
    assert(text.includes('↓20.2k'), 'footer shows cumulative input usage')
    assert(text.includes('↑1.5k'), 'footer shows cumulative output usage')
    assert(text.includes('Enter send'), 'footer keeps the send shortcut')

    fixture.controller.writeOutput('local output marker\n')
    await settle(fixture.controller, fixture.terminal)
    const initialLines = fixture.terminal.viewport()
    const localOutputRow = initialLines.findIndex((line) =>
      line.text.includes('local output marker'),
    )
    const initialComposerRow = initialLines.findIndex((line) =>
      line.text.includes('Message'),
    )
    assert(
      localOutputRow >= 0 && initialComposerRow > localOutputRow,
      'compatibility output stays above the bottom Composer/Footer region',
    )

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const rawTransitionsBeforeAbort = fixture.input.rawTransitions.length
    const abortedInput = await fixture.controller.readInput({
      signal: alreadyAborted.signal,
    })
    assert(
      abortedInput.type === 'aborted',
      'an already-aborted signal settles the retained input immediately',
    )
    assert(
      fixture.input.rawTransitions.length === rawTransitionsBeforeAbort &&
        !fixture.input.isRaw,
      'an already-settled Composer never acquires raw input',
    )

    const firstInput = fixture.controller.readInput()
    assert(fixture.input.isRaw, 'readInput acquires raw mode')
    assert(
      fixture.writes.join('').includes('\u001b[?2004h'),
      'readInput enables bracketed paste',
    )

    fixture.input.send('/')
    await settle(fixture.controller, fixture.terminal)
    text = renderedText(fixture)
    assert(text.includes('/doctor'), 'bare slash opens the command menu')
    assert(text.includes('/effort'), 'bare slash shows multiple command sources')

    fixture.input.send('d')
    await settle(fixture.controller, fixture.terminal)
    assert(
      renderedText(fixture).includes('/doctor'),
      '/d filters to the doctor command',
    )

    fixture.input.send('\u0015')
    fixture.input.send('/effort')
    fixture.input.send('\t')
    await settle(fixture.controller, fixture.terminal)
    assert(
      fixture.controller.composer.getState().value === '/effort ',
      'Tab writes the selected slash command back to the same editor',
    )
    assert(
      renderedText(fixture).includes('[low|high|auto]'),
      'completed slash command keeps its argument ghost hint',
    )

    fixture.input.send('\r')
    const firstResult = await firstInput
    assert(
      firstResult.type === 'submit' && firstResult.value === '/effort ',
      'retained readInput resolves the existing submit intent',
    )
    assert(!fixture.input.isRaw, 'submit releases raw mode before the turn')
    assert(
      fixture.writes.join('').includes('\u001b[?2004l'),
      'submit disables bracketed paste',
    )

    fixture.controller.printer.beginTurn({
      prompt: '/effort ',
      echoUser: true,
      activity: true,
    })
    await settle(fixture.controller, fixture.terminal)
    const firstActivity = activityLine(fixture)
    assert(firstActivity, 'Thinking is visible before the first provider token')
    assert(
      renderedText(fixture).includes('Message'),
      'running keeps the same Composer visible',
    )
    assert(
      fixture.controller.composer === composer,
      'idle and running retain one Composer component identity',
    )
    assert(
      fixture.controller.getState().composer.mode === 'running',
      'beginTurn only switches the shared Composer mode',
    )

    fixture.setNow(420)
    await new Promise((resolve) => setTimeout(resolve, 120))
    await settle(fixture.controller, fixture.terminal)
    const animatedActivity = activityLine(fixture)
    assert(animatedActivity, 'activity never exposes a blank animation frame')
    assert(
      animatedActivity !== firstActivity,
      'activity glyph/time advances without erase-then-draw flicker',
    )

    fixture.controller.printer.onEvent({
      type: 'text',
      text: 'final answer marker',
    })
    fixture.controller.printer.endTurn({ terminalReason: 'completed' })
    await settle(fixture.controller, fixture.terminal)
    text = renderedText(fixture)
    assert(text.includes('Thought for 0.4s'), 'silent wait leaves one segment Thought')
    assert(
      (text.match(/Thought for/gu) ?? []).length === 1,
      'one thinking segment renders one completed Thought',
    )
    assert(text.includes('final answer marker'), 'assistant text remains visible')
    assert(text.includes('Message'), 'turn completion keeps the Composer mounted')
    assert(
      fixture.controller.composer === composer,
      'turn completion does not replace the Composer',
    )
    assert(
      fixture.controller.getState().composer.mode === 'editing',
      'turn completion returns the shared Composer to editing',
    )
    const visibleLines = fixture.terminal.viewport()
    const answerRow = visibleLines.findIndex((line) =>
      line.text.includes('final answer marker'),
    )
    const composerRow = visibleLines.findIndex((line) =>
      line.text.includes('Message'),
    )
    assert(
      answerRow >= 0 && composerRow > answerRow + 1,
      'root layout owns a full gap between final answer and Composer',
    )

    fixture.controller.configureComposer({
      history: ['older prompt', '/effort '],
      slashCandidates,
      status: composerStatus,
    })
    const secondInput = fixture.controller.readInput()
    fixture.input.send('\u001b[A')
    assert(
      fixture.controller.composer.getState().value === '/effort ',
      'history remains available after idle/running mode changes',
    )
    fixture.input.send('\u0015')

    const latency: number[] = []
    for (let index = 0; index < 48; index++) {
      const startedAt = performance.now()
      fixture.input.send('x')
      latency.push(performance.now() - startedAt)
    }
    latency.sort((left, right) => left - right)
    const p95 = latency[Math.floor(latency.length * 0.95)] ?? Infinity
    assert(p95 < 20, `raw input p95 stays below 20ms, got ${p95.toFixed(2)}ms`)
    fixture.input.send('\u001a')
    assert(
      fixture.controller.composer.getState().value.length === 47,
      'Ctrl+Z undoes the last edit without replacing the Composer',
    )
    fixture.input.send('\u0015')

    const epochBeforePaste = fixture.controller.getRenderEpoch()
    fixture.input.send('\u001b[200~first\r\n')
    fixture.input.send('第二行✅')
    assert(
      fixture.controller.composer.getState().value === '',
      'paste chunks do not leak into editor state before paste-end',
    )
    fixture.input.send('\u001b[201~')
    await settle(fixture.controller, fixture.terminal)
    assert(
      fixture.controller.composer.getState().value === 'first\n第二行✅',
      'bracketed paste commits normalized multiline text once',
    )
    assert(
      fixture.controller.getRenderEpoch() - epochBeforePaste <= 1,
      'multiline paste produces one merged retained frame',
    )

    const epoch = fixture.controller.getRenderEpoch()
    fixture.terminal.resize(38, 96)
    fixture.output.resize(38, 96)
    await fixture.controller.waitForRender(epoch)
    await fixture.terminal.flush()
    assert(
      fixture.controller.composer.getState().value === 'first\n第二行✅',
      'resize reflows without losing Composer value',
    )
    assertFrameFits(fixture, 38, 'resized active Composer')

    const valueBeforeSuspend = fixture.controller.composer.getState().value
    await fixture.controller.suspendForLegacyPanel()
    assert(!fixture.input.isRaw, 'legacy panel suspend releases retained raw input')
    fixture.input.send('ignored while suspended')
    await fixture.controller.resumeFromLegacyPanel()
    assert(fixture.input.isRaw, 'resume reacquires a pending retained input session')
    assert(
      fixture.controller.composer.getState().value === valueBeforeSuspend,
      'suspended retained input fails silent and preserves value',
    )
    fixture.input.send('!')
    assert(
      fixture.controller.composer.getState().value === `${valueBeforeSuspend}!`,
      'resumed focus routes input back to the same Composer',
    )
    fixture.input.send('\u0003')
    const secondResult = await secondInput
    assert(secondResult.type === 'exit', 'Ctrl+C resolves the idle retained input')

    for (const columns of [24, 38, 56, 80, 120, 160, 220]) {
      const widthFixture = await createFixture(columns, 64)
      widthFixtures.push(widthFixture)
      assert(
        renderedText(widthFixture).includes('Message'),
        `${columns}-column frame keeps the Composer`,
      )
      assertFrameFits(widthFixture, columns, `${columns}-column Composer`)
    }

    const writesBeforeBurst = fixture.controller.getTerminalStats().writes
    fixture.controller.printer.beginTurn({
      prompt: 'burst prompt',
      echoUser: true,
    })
    for (const character of Array.from('x'.repeat(500))) {
      fixture.controller.printer.onEvent({ type: 'text', text: character })
    }
    fixture.controller.printer.endTurn({ terminalReason: 'completed' })
    await settle(fixture.controller, fixture.terminal)
    assert(
      fixture.controller.getTerminalStats().writes - writesBeforeBurst < 80,
      'character burst is coalesced instead of redrawing per token',
    )
    assert(
      fixture.controller.getTerminalStats().concurrentWriteViolations === 0,
      'Composer, Activity and transcript keep one terminal writer',
    )

    const failingInput = new RawInputHarness(true)
    const failingFixture = await createFixture(80, 96, failingInput)
    widthFixtures.push(failingFixture)
    let rawFailure: unknown
    try {
      await failingFixture.controller.readInput()
    } catch (error) {
      rawFailure = error
    }
    assert(
      rawFailure instanceof Error &&
        rawFailure.message === 'raw-mode fixture failure',
      'raw-mode acquisition preserves the original terminal error',
    )
    assert(
      failingInput.listenerCount('data') === 0,
      'failed raw-mode acquisition removes the staged data listener',
    )
    assert(
      failingInput.isPaused(),
      'failed raw-mode acquisition leaves the input stream paused',
    )

    console.log('PASS: CLI retained Composer, Activity and Footer')
  } finally {
    for (const widthFixture of widthFixtures.reverse()) {
      await dispose(widthFixture)
    }
    await dispose(fixture)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
