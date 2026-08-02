/**
 * OUT-5: 相邻只读工具调用聚合 — shared 纯契约与 retained renderer 组展示。
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import {
  groupAdjacentReadTools,
  READ_ONLY_GROUP_MIN_MEMBERS,
  createCliTuiViewState,
  type CliTuiBlock,
  type CliTuiToolBlock,
  type CliTuiViewState,
  type ReadToolGroup,
  type ToolPresentation,
} from '../packages/shared/src/index.ts'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { RetainedTranscript } from '../packages/cli/src/tui/retainedTranscript.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

function readBlock(
  id: string,
  overrides: Partial<CliTuiToolBlock> = {},
): CliTuiToolBlock {
  return {
    id,
    turnId: 'turn-1',
    kind: 'tool',
    status: 'complete',
    callId: id.replace(/^.*:/u, ''),
    name: 'Read',
    input: { path: 'large.txt' },
    output: 'bounded result',
    ok: true,
    presentation: {
      summary: `Read · large.txt · 1000 lines · ${id}`,
      preview: `preview of ${id}`,
      previewMode: 'head',
      originalChars: 100_000,
      originalLines: 1_000,
      retainedChars: 2_000,
      retainedLines: 20,
      truncated: true,
      overflow: true,
    },
    ...overrides,
  }
}

function toolBlock(
  id: string,
  name: string,
  overrides: Partial<CliTuiToolBlock> = {},
): CliTuiToolBlock {
  return readBlock(id, { name, ...overrides })
}

function viewWithBlocks(blocks: CliTuiBlock[]): CliTuiViewState {
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
}

type Fixture = {
  controller: CliTuiController
  input: RawInputHarness
  output: ResizableOutput
  terminal: HeadlessTerminalHarness
}

async function createFixture(columns = 90, rows = 40): Promise<Fixture> {
  const input = new RawInputHarness()
  const output = new ResizableOutput(columns, rows)
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
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

function emitTool(
  fixture: Fixture,
  callId: string,
  name: string,
  presentation: ToolPresentation,
): void {
  fixture.controller.printer.onEvent({
    type: 'tool_start',
    id: callId,
    name,
    input: { path: 'large.txt' },
  })
  fixture.controller.printer.onEvent({
    type: 'tool_end',
    id: callId,
    name,
    output: 'bounded provider result',
    ok: true,
    presentation,
  })
}

async function main(): Promise<void> {
  // ---- shared pure grouping contract ----
  assert.equal(READ_ONLY_GROUP_MIN_MEMBERS, 2)
  const r1 = readBlock('turn-1:tool:read-1')
  const g1 = toolBlock('turn-1:tool:grep-1', 'Grep', {
    input: { query: 'marker' },
    presentation: {
      ...r1.presentation!,
      summary: 'Grep · marker · 42 matches',
      preview: 'preview of turn-1:tool:grep-1',
    },
  })
  const grouped = groupAdjacentReadTools([r1, g1])
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0]!.kind, 'read-group')
  assert.deepEqual(
    (grouped[0] as ReadToolGroup).members.map((m) => m.id),
    [r1.id, g1.id],
    'adjacent Read+Grep form one group in original order',
  )

  const r2 = readBlock('turn-1:tool:read-2')
  const r3 = readBlock('turn-1:tool:read-3')
  const triple = groupAdjacentReadTools([r1, r2, r3])
  assert.equal(triple.length, 1)
  assert.equal(
    (triple[0] as ReadToolGroup).members.length,
    3,
    'three adjacent reads form one group of three',
  )

  const write = toolBlock('turn-1:tool:write-1', 'Write', {
    input: { path: 'out.txt' },
    ok: true,
  })
  const separated = groupAdjacentReadTools([r1, write, r2])
  assert.deepEqual(
    separated.map((entry) => (entry.kind === 'read-group' ? 'group' : entry.id)),
    [r1.id, write.id, r2.id],
    'a write tool cuts the group',
  )

  const single = groupAdjacentReadTools([r1, write])
  assert.equal(
    single.filter((entry) => entry.kind === 'read-group').length,
    0,
    'a lone read never becomes a group',
  )

  const assistantText = {
    id: 'turn-1:assistant-1',
    turnId: 'turn-1',
    kind: 'assistant' as const,
    status: 'complete' as const,
    text: 'inspecting sources',
  }
  const textCut = groupAdjacentReadTools([r1, assistantText, g1])
  assert.deepEqual(
    textCut.map((entry) => entry.kind),
    ['tool', 'assistant', 'tool'],
    'assistant body text cuts the group',
  )

  // Empty thinking placeholders between reads are absorbed by the group;
  // a reasoning block with actual text still cuts it.
  const emptyThinking = {
    id: 'turn-1:block-3',
    turnId: 'turn-1',
    kind: 'reasoning' as const,
    status: 'complete' as const,
    text: '',
  }
  const absorbed = groupAdjacentReadTools([r1, emptyThinking, g1])
  assert.equal(absorbed.length, 1)
  assert.deepEqual(
    (absorbed[0] as ReadToolGroup).members.map((m) => m.id),
    [r1.id, g1.id],
    'empty thinking placeholders are absorbed into the group',
  )
  const loneWithThinking = groupAdjacentReadTools([r1, emptyThinking, write])
  assert.deepEqual(
    loneWithThinking.map((entry) => entry.kind),
    ['tool', 'reasoning', 'tool'],
    'thinking placeholders stay visible when no group forms',
  )
  const realThinking = {
    id: 'turn-1:block-7',
    turnId: 'turn-1',
    kind: 'reasoning' as const,
    status: 'complete' as const,
    text: 'weighing approaches',
  }
  const thinkingCut = groupAdjacentReadTools([r1, realThinking, g1])
  assert.deepEqual(
    thinkingCut.map((entry) => entry.kind),
    ['tool', 'reasoning', 'tool'],
    'reasoning with visible text cuts the group',
  )

  const errorBlock = {
    id: 'turn-1:error-1',
    turnId: 'turn-1',
    kind: 'error' as const,
    status: 'error' as const,
    message: 'boom',
  }
  const errorCut = groupAdjacentReadTools([r1, errorBlock, g1])
  assert.deepEqual(
    errorCut.map((entry) => entry.kind),
    ['tool', 'error', 'tool'],
    'error blocks cut the group',
  )

  const running = readBlock('turn-1:tool:running-1', { status: 'running' })
  const runningCut = groupAdjacentReadTools([r1, running, g1])
  assert.deepEqual(
    runningCut.map((entry) => entry.kind),
    ['tool', 'tool', 'tool'],
    'running tools neither join nor bridge a group',
  )

  const interrupted = readBlock('turn-1:tool:interrupted-1', {
    status: 'interrupted',
  })
  const interruptedCut = groupAdjacentReadTools([r1, interrupted, g1])
  assert.deepEqual(
    interruptedCut.map((entry) => entry.kind),
    ['tool', 'tool', 'tool'],
    'interrupted tools neither join nor bridge a group',
  )

  const failed = readBlock('turn-1:tool:failed-1', {
    ok: false,
    status: 'error',
  })
  const failedCut = groupAdjacentReadTools([r1, failed, g1])
  assert.equal(
    failedCut.filter((entry) => entry.kind === 'read-group').length,
    0,
    'failed tools cut the group',
  )

  const mcp = toolBlock('turn-1:tool:mcp-1', 'mcp__server__search', {
    ok: true,
  })
  const mcpCut = groupAdjacentReadTools([r1, mcp, g1])
  assert.equal(
    mcpCut.filter((entry) => entry.kind === 'read-group').length,
    0,
    'MCP tools never join groups (read-only is not decidable by name)',
  )

  // ---- retained transcript renders groups ----
  const transcript = new RetainedTranscript({ env: { NO_COLOR: '1' } })
  transcript.setState(viewWithBlocks([r1, g1]))
  const rendered = transcript.render(80).join('\n')
  assert(
    rendered.includes('⇅ 2 read-only calls') &&
      rendered.includes('Read · large.txt · 1000 lines · turn-1:tool:read-1') &&
      rendered.includes('Grep · marker · 42 matches') &&
      !rendered.includes('preview of turn-1:tool:read-1'),
    'group header plus one summary line per member, never preview bodies',
  )
  const hits = transcript.getBlockHitLines()
  assert(
    hits.has(r1.id) && hits.has(g1.id),
    'group members keep independent hit regions',
  )

  const transcriptMixed = new RetainedTranscript({ env: { NO_COLOR: '1' } })
  transcriptMixed.setState(viewWithBlocks([r1, write, g1]))
  const mixedRendered = transcriptMixed.render(80).join('\n')
  assert(
    !mixedRendered.includes('read-only calls') &&
      mixedRendered.includes('✓ Write'),
    'non-adjacent reads render as ordinary blocks',
  )

  // ---- retained controller integration ----
  const fixture = await createFixture()
  try {
    fixture.controller.printer.beginTurn({ prompt: 'read and grep' })
    emitTool(
      fixture,
      'read-1',
      'Read',
      r1.presentation!,
    )
    emitTool(
      fixture,
      'grep-1',
      'Grep',
      g1.presentation!,
    )
    fixture.controller.printer.endTurn({ terminalReason: 'completed' })
    await settle(fixture)
    assert(
      screen(fixture).includes('⇅ 2 read-only calls') &&
        screen(fixture).includes('Read · large.txt · 1000 lines · turn-1:tool:read-1'),
      'live events render one aggregated read group',
    )

    // Ctrl+O does not expand grouped members into previews.
    fixture.input.send('\u000f')
    await settle(fixture)
    assert(
      screen(fixture).includes('⇅ 2 read-only calls') &&
        !screen(fixture).includes('preview of turn-1:tool:read-1'),
      'global preview toggle leaves grouped members as summaries',
    )

    // Clicking a member opens that member pager through the mouse path.
    const pending = fixture.controller.readInput()
    void pending
    const memberRow = findRow(fixture, 'Grep · marker · 42 matches')
    fixture.input.send(`\x1b[<0;20;${memberRow}M`)
    await settle(fixture)
    assert(
      screen(fixture).includes('preview of turn-1:tool:grep-1'),
      'clicking a grouped member opens its own pager',
    )
    fixture.input.send('\u001b')
    await waitFor(
      () => !screen(fixture).includes('preview of turn-1:tool:grep-1'),
      'escape closes the member pager',
    )
  } finally {
    await fixture.controller.stop()
    fixture.terminal.dispose()
  }

  // ---- /tools catalog still lists grouped members individually ----
  {
    const fixture2 = await createFixture()
    try {
      fixture2.controller.printer.beginTurn({ prompt: 'read and grep' })
      emitTool(fixture2, 'read-1', 'Read', r1.presentation!)
      emitTool(fixture2, 'grep-1', 'Grep', g1.presentation!)
      fixture2.controller.printer.endTurn({ terminalReason: 'completed' })
      await settle(fixture2)
      const viewedPromise = fixture2.controller.runToolHistoryOverlay({
        cwd: process.cwd(),
        sessionId: 'grouping-session',
      })
      await settle(fixture2)
      fixture2.input.send('\u001b')
      const viewed = await viewedPromise
      assert(
        viewed.ok === false && viewed.reason === 'cancel',
        'tool picker remains reachable while grouped members keep identities',
      )
    } finally {
      await fixture2.controller.stop()
      fixture2.terminal.dispose()
    }
  }

  console.log('PASS: OUT-5 adjacent read-only tool grouping')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
