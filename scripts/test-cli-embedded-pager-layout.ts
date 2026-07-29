/**
 * OI-17: REPL pagers belong next to the Composer, not at terminal bottom.
 */
import { EventEmitter } from 'node:events'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
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

type Fixture = {
  controller: CliTuiController
  input: RawInputHarness
  terminal: HeadlessTerminalHarness
}

const doctorContent = Array.from(
  { length: 29 },
  (_, index) => `diagnostic row ${index + 1}: ready`,
).join('\n')

async function createFixture(rows: number): Promise<Fixture> {
  const columns = 100
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 500,
  })
  const output = new ResizableOutput(columns, rows)
  const input = new RawInputHarness()
  const controller = createRetainedTuiController({
    writeOut: (text) => terminal.write(text),
    writeErr: (text) => terminal.write(text),
    input,
    output,
    color: false,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  controller.configureComposer({
    history: [],
    slashCandidates: [],
    status: {
      permissionMode: 'default',
      providerId: 'openai',
      model: 'gpt-5.4',
    },
  })
  await controller.start()
  await settle({ controller, input, terminal })
  return { controller, input, terminal }
}

async function settle(fixture: Fixture): Promise<void> {
  await fixture.controller.flush()
  await fixture.terminal.flush()
}

function visibleLines(fixture: Fixture): string[] {
  return fixture.terminal.viewport().map((line) => line.text)
}

function findLine(
  lines: readonly string[],
  predicate: (line: string) => boolean,
  label: string,
): number {
  const index = lines.findIndex(predicate)
  assert(index >= 0, `${label} is visible`)
  return index
}

async function testEmbeddedDoctorPager(rows: number): Promise<void> {
  const fixture = await createFixture(rows)
  const pendingInput = fixture.controller.readInput()
  try {
    fixture.input.send('draft!')
    await settle(fixture)

    const pager = fixture.controller.runTextPagerOverlay({
      key: 'slash:doctor',
      title: 'Doctor',
      content: doctorContent,
    })
    await settle(fixture)

    const lines = visibleLines(fixture)
    const composerTop = findLine(
      lines,
      (line) => line.includes('Message'),
      `${rows}-row Composer`,
    )
    const composerBottom = findLine(
      lines.slice(composerTop + 1),
      (line) => line.includes('╰'),
      `${rows}-row Composer bottom border`,
    ) + composerTop + 1
    const pagerTitle = findLine(
      lines,
      (line) => line.trim() === 'Doctor',
      `${rows}-row Doctor title`,
    )
    const pagerFooter = findLine(
      lines,
      (line) => line.includes('1/2') && line.includes('q/Esc close'),
      `${rows}-row Doctor footer`,
    )

    assert(
      pagerTitle > composerBottom && pagerTitle - composerBottom <= 2,
      `${rows}-row Doctor starts next to Composer; got rows ${composerBottom} and ${pagerTitle}`,
    )
    assert(
      pagerFooter > pagerTitle && pagerFooter - pagerTitle <= 20,
      `${rows}-row Doctor footer remains inside the bounded pager`,
    )
    assert(
      fixture.controller.getState().overlay.mode === 'pager',
      `${rows}-row pager keeps the shared interactive state`,
    )

    fixture.input.send('q')
    assert((await pager).reason === 'quit', 'q closes the embedded pager')
    await settle(fixture)
    fixture.input.send(' restored')
    assert(
      fixture.controller.composer.getState().value === 'draft! restored',
      `${rows}-row Composer regains input focus after pager close`,
    )
  } finally {
    await fixture.controller.stop()
    await pendingInput
    fixture.terminal.dispose()
  }
}

for (const rows of [48, 80]) {
  await testEmbeddedDoctorPager(rows)
}

console.log('PASS: CLI embedded pager layout')
