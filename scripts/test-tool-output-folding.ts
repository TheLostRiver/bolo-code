/**
 * OUT-2: retained tool output folding, global keyboard path, and bounded pager.
 */
import { EventEmitter } from 'node:events'
import {
  createCliToolDisplayState,
  createCliTuiViewState,
  projectCliToolDisplay,
  reduceCliToolDisplayState,
  reduceCliTuiViewState,
  type CliTuiToolBlock,
  type CliTuiViewState,
  type ToolPresentation,
} from '../packages/shared/src/index.ts'
import {
  attachSessionTuiController,
  runOnePrompt,
} from '../packages/cli/src/resumeCli.ts'
import {
  CLI_LOCAL_SLASH_COMMANDS,
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { RetainedTranscript } from '../packages/cli/src/tui/retainedTranscript.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import type { BoloSession } from '../packages/core/src/index.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const longPresentation: ToolPresentation = {
  summary: 'Read 路 large.txt 路 200 lines',
  preview: 'preview first\n...\npreview last',
  previewMode: 'head',
  originalChars: 20_000,
  originalLines: 200,
  retainedChars: 8_000,
  retainedLines: 80,
  truncated: true,
  overflow: true,
  fullResult: {
    kind: 'session-file',
    path: 'E:\\DEV\\HelsincyAgent\\.bolo\\tool-results\\session\\read.txt',
    bytes: 20_000,
  },
}

function toolBlock(
  overrides: Partial<CliTuiToolBlock> = {},
): CliTuiToolBlock {
  return {
    id: 'turn-1:tool:read-1',
    turnId: 'turn-1',
    kind: 'tool',
    status: 'complete',
    callId: 'read-1',
    name: 'Read',
    input: { path: 'large.txt' },
    output: 'retained full marker must stay hidden',
    ok: true,
    presentation: longPresentation,
    ...overrides,
  }
}

function viewWithTools(blocks: CliTuiToolBlock[]): CliTuiViewState {
  return {
    ...createCliTuiViewState(),
    turns: [
      {
        id: 'turn-1',
        status: 'complete',
        blocks,
        terminal: { reason: 'completed' },
      },
    ],
    nextTurnSequence: 2,
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

async function createFixture(): Promise<Fixture> {
  const input = new RawInputHarness()
  const output = new ResizableOutput(76, 32)
  const terminal = new HeadlessTerminalHarness({
    columns: output.columns,
    rows: output.rows,
    scrollback: 400,
  })
  const controller = createRetainedTuiController({
    writeOut: (text) => terminal.write(text),
    writeErr: (text) => terminal.write(text),
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

async function settle(fixture: Fixture): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  await fixture.controller.flush()
  await fixture.terminal.flush()
}

async function main() {
  const long = toolBlock()
  let display = createCliToolDisplayState(long)
  assert(
    display.mode === 'summary',
    'successful long output defaults to summary',
  )
  let projection = projectCliToolDisplay(long, display)
  assert(
    projection.content === longPresentation.summary &&
      !projection.content.includes('preview first'),
    'summary projection does not retain the preview body',
  )

  display = reduceCliToolDisplayState(display, { type: 'toggle' })
  projection = projectCliToolDisplay(long, display)
  assert(
    display.mode === 'preview' &&
      projection.content.includes('preview first') &&
      !projection.content.includes('retained full marker'),
    'expanded projection uses only the bounded OUT-1 preview',
  )

  const short = toolBlock({
    id: 'turn-1:tool:short-1',
    callId: 'short-1',
    output: 'short result',
    presentation: {
      summary: 'Read 路 1 line',
      preview: 'short result',
      previewMode: 'head',
      originalChars: 12,
      originalLines: 1,
      retainedChars: 12,
      retainedLines: 1,
      truncated: false,
      overflow: false,
    },
  })
  assert(
    createCliToolDisplayState(short).mode === 'preview',
    'short successful output defaults to preview',
  )

  const failed = toolBlock({
    id: 'turn-1:tool:error-1',
    callId: 'error-1',
    status: 'error',
    ok: false,
    output: '<tool_use_error>failed full body</tool_use_error>',
    presentation: {
      summary: 'Read 路 failed: denied',
      preview: 'failed bounded detail',
      previewMode: 'head-tail',
      originalChars: 5_000,
      originalLines: 40,
      retainedChars: 5_000,
      retainedLines: 40,
      truncated: false,
      overflow: true,
    },
  })
  assert(
    createCliToolDisplayState(failed).mode === 'preview' &&
      projectCliToolDisplay(
        failed,
        createCliToolDisplayState(failed),
      ).content === 'failed bounded detail',
    'errors stay expanded but consume only bounded preview',
  )
  assert(
    projectCliToolDisplay(failed, { mode: 'summary' }).content ===
      'failed bounded detail',
    'global summary never hides an actionable bounded error preview',
  )

  const progress = Array.from(
    { length: 40 },
    (_, index) => `old-${index}`,
  ).join('\n') + '\nlatest-tail-marker'
  const running = toolBlock({
    id: 'turn-1:tool:running-1',
    callId: 'running-1',
    status: 'running',
    ok: undefined,
    output: undefined,
    presentation: undefined,
    progress,
  })
  const runningProjection = projectCliToolDisplay(
    running,
    createCliToolDisplayState(running),
  )
  assert(
    runningProjection.content.includes('latest-tail-marker') &&
      !runningProjection.content.includes('old-0') &&
      runningProjection.content.length <= 1_200,
    'running tools expose a bounded tail instead of unbounded progress',
  )

  const legacy = toolBlock({
    id: 'turn-1:tool:legacy-1',
    callId: 'legacy-1',
    output: Array.from(
      { length: 100 },
      (_, index) => `legacy-${index}`,
    ).join('\n'),
    presentation: undefined,
  })
  const legacyState = createCliToolDisplayState(legacy)
  const legacyPreview = projectCliToolDisplay(
    legacy,
    reduceCliToolDisplayState(legacyState, {
      type: 'set_mode',
      mode: 'preview',
    }),
  )
  assert(
    legacyState.mode === 'summary' &&
      legacyPreview.content.length <= 4_000 &&
      legacyPreview.content.split('\n').length <= 20,
    'old events remain compatible without flooding the retained transcript',
  )

  const transcript = new RetainedTranscript({ env: { NO_COLOR: '1' } })
  transcript.setState(viewWithTools([long, short, failed, legacy]))
  const collapsed = transcript.render(40).join('\n')
  assert(
    collapsed.includes(longPresentation.summary) &&
      !collapsed.includes('preview first') &&
      !collapsed.includes('retained full marker'),
    'retained transcript applies the default long-result summary',
  )
  assert(
    transcript.toggleToolDisplayMode() === 'preview' &&
      transcript.render(40).join('\n').includes('preview first'),
    'retained transcript globally toggles stable tool blocks to previews',
  )
  const narrowLines = transcript.render(18)
  assert(
    narrowLines.length <= 96 &&
      narrowLines.every((line) => measureTerminalText(line) <= 18),
    'four bounded tool blocks remain finite and fit after narrow reflow',
  )
  const catalog = transcript.getToolCatalogItems()
  assert(
    catalog.length === 4 &&
      catalog[0]?.id === legacy.id &&
      catalog.at(-1)?.id === long.id,
    'tool picker catalog is stable and newest-first',
  )
  const pager = transcript.getToolPagerContent(long.id)
  assert(
    pager?.content.includes('preview first') &&
      !pager.content.includes('retained full marker') &&
      !pager.content.includes(longPresentation.fullResult!.path),
    'OUT-2 pager receives bounded preview, never spill contents or paths',
  )
  const laterLong = toolBlock({
    id: 'turn-1:tool:later-1',
    callId: 'later-1',
    presentation: {
      ...longPresentation,
      summary: 'Read · later.txt · 300 lines',
      preview: 'later inherited preview',
    },
  })
  transcript.setState(
    viewWithTools([long, short, failed, legacy, laterLong]),
  )
  assert(
    transcript.render(40).join('\n').includes('later inherited preview'),
    'new long tools inherit an active global preview override',
  )

  const fixture = await createFixture()
  try {
    fixture.controller.printer.beginTurn({ prompt: 'read a large file' })
    fixture.controller.printer.onEvent({
      type: 'tool_start',
      id: long.callId,
      name: long.name,
      input: long.input,
    })
    fixture.controller.printer.onEvent({
      type: 'tool_end',
      id: long.callId,
      name: long.name,
      output: long.output!,
      ok: true,
      presentation: longPresentation,
    })
    fixture.controller.printer.endTurn({ terminalReason: 'completed' })
    await settle(fixture)
    assert(
      screen(fixture).includes(longPresentation.summary) &&
        !screen(fixture).includes('preview first'),
      'controller renders a long tool summary before Ctrl+O',
    )

    const inputResult = fixture.controller.readInput()
    fixture.input.send('draft')
    fixture.input.send('\u001b[D')
    fixture.input.send('\u001b[D')

    fixture.input.send('\u000f')
    await settle(fixture)
    assert(
      screen(fixture).includes('preview first') &&
        !screen(fixture).includes('retained full marker'),
      'Ctrl+O globally expands bounded previews without submitting input',
    )

    const history = fixture.controller.runToolHistoryOverlay()
    await settle(fixture)
    assert(
      /Tool results/iu.test(screen(fixture)),
      '/tools picker is hosted by the retained overlay',
    )
    fixture.input.send('\r')
    await settle(fixture)
    assert(
      screen(fixture).includes('preview first'),
      'picker Enter opens the bounded embedded pager',
    )
    fixture.input.send('\u000f')
    await settle(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'pager',
      'Ctrl+O does not escape or replace an active business overlay',
    )
    fixture.input.send('\u001b')
    const historyResult = await history
    assert(
      historyResult.ok &&
        historyResult.blockId.endsWith(`:tool:${long.callId}`),
      `Esc closes the pager after a stable block selection: ${JSON.stringify(
        historyResult,
      )}`,
    )

    fixture.input.send('X')
    fixture.input.send('\u001b[200~\nsecond\u001b[201~')
    fixture.input.send('\r')
    const submitted = await inputResult
    assert(
      submitted.type === 'submit' &&
        submitted.value === 'draX\nsecondft' &&
        fixture.controller.composer.focused,
      'pager close restores draft, cursor, focus, and bracketed paste',
    )

    fixture.terminal.resize(34, 24)
    fixture.output.resize(34, 24)
    await settle(fixture)
    assert(
      fixture.terminal
        .viewport()
        .every((line) => measureTerminalText(line.text) <= 34),
      'expanded preview remains bounded after resize/reflow',
    )

    const fakeSession = {
      id: 'out-2-session',
      cwd: 'E:\\DEV\\HelsincyAgent',
      messages: [],
    } as unknown as BoloSession
    attachSessionTuiController(fakeSession, fixture.controller)
    const localTools = runOnePrompt(fakeSession, '/tools')
    await settle(fixture)
    fixture.input.send('\r')
    await settle(fixture)
    fixture.input.send('\u001b')
    const localResult = await localTools
    assert(
      localResult.terminalReason === 'slash' &&
        fakeSession.messages.length === 0,
      'retained /tools is intercepted without persisting session messages',
    )
  } finally {
    await fixture.controller.stop()
    fixture.terminal.dispose()
  }

  assert(
    CLI_LOCAL_SLASH_COMMANDS.some(
      (candidate) => candidate.name === 'tools' && !candidate.hidden,
    ),
    'interactive completion advertises /tools',
  )

  let restored = reduceCliTuiViewState(createCliTuiViewState(), {
    type: 'begin_turn',
    prompt: 'legacy restore',
  })
  restored = reduceCliTuiViewState(restored, {
    type: 'session_event',
    event: {
      type: 'tool_end',
      id: 'legacy-event',
      name: 'Read',
      output: 'legacy event output',
      ok: true,
    },
  })
  assert(
    restored.turns[0]?.blocks.some(
      (block) => block.kind === 'tool' && block.presentation === undefined,
    ),
    'shared view-state still accepts old tool events without presentation',
  )

  console.log('PASS: OUT-2 retained tool output folding')
}

await main()
