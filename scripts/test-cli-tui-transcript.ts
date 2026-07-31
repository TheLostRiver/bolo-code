/**
 * OI-14D: retained transcript projection and Markdown are verified through
 * xterm's real cell buffer, never a string-only terminal simulation.
 */
import { EventEmitter } from 'node:events'
import {
  getCapabilities,
  setCapabilities,
} from '../packages/cli/src/tui/piCompat.ts'
import {
  createRetainedTuiController,
  resolveTuiContentGutter,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { RetainedTranscript } from '../packages/cli/src/tui/retainedTranscript.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import {
  createCliTuiViewState,
  reduceCliTuiViewState,
  type ChatMessage,
} from '../packages/shared/src/index.ts'
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

async function createFixture(columns = 80, rows = 120): Promise<Fixture> {
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 1_000,
  })
  const output = new ResizableOutput(columns, rows)
  const writes: string[] = []
  let nowCall = 0
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
    now: () => (nowCall++ === 0 ? 0 : 4_200),
  })
  controller.setWelcomeVisible(false)
  await controller.start()
  await terminal.flush()
  return { controller, output, terminal, writes }
}

function renderedLines(fixture: Fixture) {
  return fixture.terminal.viewport()
}

function renderedText(fixture: Fixture): string {
  return renderedLines(fixture)
    .map((line) => line.text)
    .join('\n')
}

function assertFrameFits(
  fixture: Fixture,
  width: number,
  label: string,
): void {
  for (const line of renderedLines(fixture)) {
    assert(
      measureTerminalText(line.text) <= width,
      `${label}: physical row ${line.index} exceeds ${width} cells`,
    )
    assert(
      !line.isWrapped,
      `${label}: terminal auto-wrapped physical row ${line.index}`,
    )
  }
}

function assertGutter(
  fixture: Fixture,
  needle: string,
  columns: number,
): void {
  const line = renderedLines(fixture).find((item) =>
    item.text.includes(needle),
  )
  assert(line, `rendered transcript includes ${JSON.stringify(needle)}`)
  const gutter = ' '.repeat(resolveTuiContentGutter(columns))
  assert(
    !gutter || line.text.startsWith(gutter),
    `${JSON.stringify(needle)} retains the ${gutter.length}-cell transcript gutter`,
  )
}

function splitCharacters(text: string): string[] {
  return Array.from(text)
}

function splitFixedRandom(text: string, seed = 0x14d): string[] {
  const chunks: string[] = []
  let index = 0
  let state = seed >>> 0
  while (index < text.length) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    const width = 1 + (state % 7)
    chunks.push(text.slice(index, index + width))
    index += width
  }
  return chunks
}

const MARKDOWN = [
  '# Markdown transcript',
  '',
  'A **stable** answer with CJK 中文, emoji ✅, ANSI \u001b[31mred\u001b[0m, and a [long link](https://example.test/a/path/that/needs/to/wrap/without/losing/the/gutter).',
  '',
  '1. Preserve this ordered marker',
  '   - nested list continuation must keep its own indent',
  '',
  '> Quoted content should also reflow as one semantic block.',
  '',
  '```ts',
  'const crystal = "Bolo ✅";',
  '```',
  '',
  '| left | right |',
  '| --- | --- |',
  '| CJK 中文 | table cell wraps |',
  '',
  'assistant unique marker',
].join('\n')

async function renderTranscriptChunks(
  chunks: readonly string[],
  columns = 80,
  rows = 120,
): Promise<Fixture> {
  const fixture = await createFixture(columns, rows)
  const { printer } = fixture.controller
  assert(
    !printer.didStreamText(),
    'a fresh retained turn has no rendered assistant stream',
  )
  printer.beginTurn({
    prompt: 'user unique marker\nwith a second source line',
    echoUser: true,
    activity: true,
  })
  printer.onEvent({
    type: 'reasoning',
    text: 'reasoning unique marker',
  })
  printer.onEvent({ type: 'reasoning_end' })
  assert(
    !printer.didStreamText(),
    'reasoning alone does not suppress a non-streamed final answer',
  )
  for (const chunk of chunks) {
    printer.onEvent({ type: 'text', text: chunk })
  }
  printer.onEvent({
    type: 'tool_start',
    id: 'bash-1',
    name: 'Bash',
    input: { command: 'git status --short' },
    argumentsJson: '{"command":"git status --short"}',
  })
  printer.onEvent({
    type: 'tool_progress',
    id: 'bash-1',
    name: 'Bash',
    message: 'reading repository status',
  })
  printer.onEvent({
    type: 'tool_end',
    id: 'bash-1',
    name: 'Bash',
    output: ' M packages/cli/src/tui/retainedTui.ts',
    ok: true,
    summaryLine: '✓ Bash · repository status',
  })
  printer.onEvent({
    type: 'web_search',
    phase: 'query',
    query: 'Bolo retained Markdown',
  })
  printer.onEvent({
    type: 'web_search',
    phase: 'results',
    resultCount: 1,
  })
  printer.onEvent({
    type: 'web_search',
    phase: 'citation',
    title: 'Bolo docs',
    url: 'https://docs.example.test/bolo',
  })
  printer.onEvent({
    type: 'warning',
    message: 'warning unique marker',
  })
  printer.onEvent({
    type: 'error',
    message: 'error unique marker',
  })
  printer.onEvent({
    type: 'summary',
    text: 'summary unique marker',
  })
  printer.endTurn({ terminalReason: 'completed' })
  await fixture.controller.flush()
  await fixture.terminal.flush()
  return fixture
}

async function dispose(fixture: Fixture | undefined): Promise<void> {
  if (!fixture) return
  await fixture.controller.stop()
  fixture.terminal.dispose()
}

async function main() {
  let whole: Fixture | undefined
  let characters: Fixture | undefined
  let random: Fixture | undefined
  let resumed: Fixture | undefined
  const widthFixtures: Fixture[] = []
  const originalCapabilities = getCapabilities()
  setCapabilities({
    images: null,
    trueColor: true,
    hyperlinks: true,
  })
  try {
    const transcript = new RetainedTranscript({ env: { NO_COLOR: '1' } })
    let identityState = reduceCliTuiViewState(
      createCliTuiViewState(),
      {
        type: 'begin_turn',
        prompt: 'stable component identity',
      },
    )
    identityState = reduceCliTuiViewState(identityState, {
      type: 'session_event',
      event: { type: 'text', text: 'first' },
    })
    transcript.setState(identityState)
    const assistantBlock = identityState.turns[0]?.blocks.find(
      (block) => block.kind === 'assistant',
    )
    assert(assistantBlock, 'identity fixture allocated an assistant block')
    const firstComponent = transcript.getBlockComponent(assistantBlock.id)
    identityState = reduceCliTuiViewState(identityState, {
      type: 'session_event',
      event: { type: 'text', text: ' second' },
    })
    transcript.setState(identityState)
    assert(
      transcript.getBlockComponent(assistantBlock.id) === firstComponent,
      'stream chunks update the stable block component in place',
    )

    const colorTranscript = new RetainedTranscript({ env: {} })
    const colorState = reduceCliTuiViewState(
      createCliTuiViewState(),
      {
        type: 'begin_turn',
        prompt: 'full-width user background',
      },
    )
    colorTranscript.setState(colorState)
    const colorUserLine = colorTranscript
      .render(80)
      .find((line) => line.includes('full-width user background'))
    assert(colorUserLine, 'color transcript renders the user block')
    assert(
      colorUserLine.includes('\u001b[48;5;236m'),
      'default theme gives the user history block a gray background',
    )
    assert(
      measureTerminalText(colorUserLine) === 80,
      'user history background occupies the full physical row',
    )

    whole = await renderTranscriptChunks([MARKDOWN])
    const wholeText = renderedText(whole)

    // Before OI-14D this controller held all of the same state but rendered
    // only status/compatibility text, so these observable semantic blocks are
    // deliberately the first red assertions.
    for (const needle of [
      'user unique marker',
      'reasoning unique marker',
      'Thought for 4.2s',
      'Markdown transcript',
      'assistant unique marker',
      'Bash',
      'git status --short',
      'web search',
      'Bolo retained Markdown',
      'warning unique marker',
      'error unique marker',
      'summary unique marker',
    ]) {
      assert(
        wholeText.includes(needle),
        `retained transcript projects ${JSON.stringify(needle)}`,
      )
      assertGutter(whole, needle, 80)
    }
    assert(
      whole.controller.printer.didStreamText(),
      'a rendered assistant stream suppresses runOnePrompt final-answer fallback',
    )
    const writerBytes = whole.writes.join('')
    assert(
      writerBytes.includes(
        '\u001b]8;;https://example.test/a/path/that/needs/to/wrap/without/losing/the/gutter\u001b\\',
      ),
      'hyperlink-capable terminals receive an OSC 8 link',
    )
    assert(
      writerBytes.includes('\u001b[31mred\u001b[0m'),
      'source ANSI survives Markdown rendering without corrupting cell width',
    )
    assertFrameFits(whole, 80, 'whole transcript')

    const state = whole.controller.getState()
    assert(
      state.turns.length === 1 &&
        state.turns[0]?.blocks.every((block) => block.id.startsWith('turn-0:')),
      'transcript uses the shared OI-14B stable block ids',
    )

    const assistantLine = renderedLines(whole).findIndex((line) =>
      line.text.includes('assistant unique marker'),
    )
    const toolLine = renderedLines(whole).findIndex((line) =>
      line.text.includes('Bash'),
    )
    assert(
      assistantLine >= 0 && toolLine > assistantLine + 1,
      'parent-owned section gap separates assistant and tool blocks',
    )

    characters = await renderTranscriptChunks(splitCharacters(MARKDOWN))
    random = await renderTranscriptChunks(splitFixedRandom(MARKDOWN))
    assert(
      renderedText(characters) === wholeText,
      'character chunks converge to the same retained physical frame',
    )
    assert(
      renderedText(random) === wholeText,
      'fixed-random chunks converge to the same retained physical frame',
    )
    assert(
      characters.controller.getTerminalStats().writes <
        Math.max(20, splitCharacters(MARKDOWN).length / 4),
      'character burst is coalesced instead of writing once per provider chunk',
    )

    for (const columns of [24, 31, 32, 47, 48, 120, 160, 220]) {
      const fixture = await renderTranscriptChunks(
        [MARKDOWN],
        columns,
        260,
      )
      widthFixtures.push(fixture)
      assertFrameFits(fixture, columns, `${columns}-column transcript`)
      assertGutter(fixture, 'assistant unique marker', columns)
      assertGutter(fixture, 'summary unique marker', columns)
    }

    const root = whole.controller.root
    const epoch = whole.controller.getRenderEpoch()
    whole.terminal.resize(38, 120)
    whole.output.resize(38, 120)
    await whole.controller.waitForRender(epoch)
    await whole.terminal.flush()
    assert(
      whole.controller.root === root,
      'resize retains the same retained root component',
    )
    assertFrameFits(whole, 38, '80-to-38 transcript resize')
    assertGutter(whole, 'assistant unique marker', 38)
    assert(
      renderedText(whole).includes('summary unique marker'),
      'resize reflows raw source instead of dropping later transcript blocks',
    )

    resumed = await createFixture(56)
    resumed.controller.restoreMessages([
      {
        role: 'user',
        content: 'resume user unique marker',
      },
      {
        role: 'assistant',
        content: 'resume assistant unique marker\n\n- resumed Markdown',
        reasoning_content: 'resume thought unique marker',
        tool_calls: [
          {
            id: 'resume-read',
            name: 'Read',
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'resume-read',
        name: 'Read',
        content: 'resume tool unique marker',
      },
    ] satisfies ChatMessage[])
    await resumed.controller.flush()
    await resumed.terminal.flush()
    const resumedText = renderedText(resumed)
    for (const needle of [
      'resume user unique marker',
      'resume thought unique marker',
      'resume assistant unique marker',
      'resume tool unique marker',
    ]) {
      assert(
        resumedText.includes(needle),
        `resume uses the same transcript path for ${JSON.stringify(needle)}`,
      )
      assertGutter(resumed, needle, 56)
    }
    assertFrameFits(resumed, 56, 'resume transcript')

    console.log('PASS: CLI retained transcript Markdown')
  } finally {
    setCapabilities(originalCapabilities)
    for (const fixture of widthFixtures.reverse()) {
      await dispose(fixture)
    }
    await dispose(resumed)
    await dispose(random)
    await dispose(characters)
    await dispose(whole)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
