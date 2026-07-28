/**
 * OI-14A: preserve executable evidence that the legacy direct-write surface
 * violates real terminal layout invariants.
 *
 * Default mode passes only when the known legacy failures are detected, so
 * main stays green while the red evidence remains reproducible.
 *
 * BOLO_TUI_VT_EXPECT=fixed npx tsx scripts/test-cli-tui-vt-legacy.ts
 * flips the same fixture to the target invariant and must fail until the
 * retained renderer replaces the legacy path.
 */
import {
  createTuiContentPrefixer,
  resolveTuiContentGutter,
} from '../packages/cli/src/tui/contentLayout.ts'
import {
  createTuiInputState,
  renderTuiInputBox,
} from '../packages/cli/src/tui/inputBox.ts'
import {
  createTerminalSurface,
  type TerminalDock,
} from '../packages/cli/src/tui/terminalSurface.ts'
import { createSessionEventPrinter } from '../packages/cli/src/tui/formatSessionEvent.ts'
import {
  HeadlessTerminalHarness,
  type HeadlessTerminalLine,
  type HeadlessTerminalSnapshot,
} from './lib/headlessTerminalHarness.ts'

type LegacyFailure = {
  code:
    | 'wrapped-continuation-lost-gutter'
    | 'dock-column-drift'
    | 'chunk-boundary-changes-screen'
    | 'resize-breaks-composer'
  detail: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function locateLast(
  lines: readonly HeadlessTerminalLine[],
  needle: string,
): { row: number; column: number } | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const column = lines[index]?.text.indexOf(needle) ?? -1
    if (column >= 0) return { row: lines[index]!.index, column }
  }
  return undefined
}

function createRunningDock(columns: number): TerminalDock {
  const rendered = renderTuiInputBox({
    state: createTuiInputState(),
    columns,
    color: false,
    mode: 'running',
    status: {
      permissionMode: 'default',
      providerId: 'fixture',
      model: 'fixture-model',
      effortLevel: 'high',
    },
  })
  return {
    lines: rendered.lines,
    cursorRow: rendered.cursorRow,
    cursorColumn: rendered.cursorColumn,
    showCursor: false,
  }
}

function splitByPattern(text: string, pattern: readonly number[]): string[] {
  const characters = Array.from(text)
  const chunks: string[] = []
  let offset = 0
  let patternIndex = 0
  while (offset < characters.length) {
    const size = Math.max(1, pattern[patternIndex % pattern.length] ?? 1)
    chunks.push(characters.slice(offset, offset + size).join(''))
    offset += size
    patternIndex += 1
  }
  return chunks
}

function canonicalSnapshot(snapshot: HeadlessTerminalSnapshot): string {
  const lines = snapshot.lines.map((line) => ({
    text: line.text,
    wrapped: line.isWrapped,
  }))
  while (
    lines.length > 0 &&
    lines.at(-1)?.text === '' &&
    lines.at(-1)?.wrapped === false
  ) {
    lines.pop()
  }
  return JSON.stringify({
    cursor: snapshot.cursor,
    baseY: snapshot.baseY,
    viewportY: snapshot.viewportY,
    lines,
  })
}

async function renderPrinterFixture(options: {
  chunks: readonly string[]
  resizeAfterChunk?: number
}): Promise<HeadlessTerminalSnapshot> {
  const columns = 56
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows: 30,
    scrollback: 400,
  })
  const surface = createTerminalSurface({
    writeOut: terminal.write,
    writeErr: terminal.write,
  })
  surface.setDock(createRunningDock(columns))
  const printer = createSessionEventPrinter({
    writeOut: surface.writeOutput,
    writeErr: surface.writeError,
    timeline: true,
    color: true,
    columns,
  })
  printer.beginTurn({
    prompt: '请解释真实终端布局，并保持输入框。',
    echoUser: true,
    activity: false,
  })
  for (let index = 0; index < options.chunks.length; index++) {
    printer.onEvent({ type: 'text', text: options.chunks[index]! })
    if (index === options.resizeAfterChunk) {
      await terminal.flush()
      terminal.resize(38, 30)
    }
  }
  printer.endTurn({ terminalReason: 'completed' })
  await terminal.flush()
  const snapshot = terminal.snapshot()
  terminal.dispose()
  return snapshot
}

async function detectWrappedContinuationFailure(): Promise<LegacyFailure | undefined> {
  const columns = 38
  const gutter = resolveTuiContentGutter(columns)
  const terminal = new HeadlessTerminalHarness({ columns, rows: 10 })
  const prefixer = createTuiContentPrefixer({ columns })
  const source =
    'Agent explains https://example.com/a/very/long/path/that/cannot/fit?query=terminal-layout'
  terminal.write(prefixer.format(source))
  await terminal.flush()
  const physical = terminal
    .snapshot()
    .lines.filter((line) => line.text.length > 0)
  terminal.dispose()

  const broken = physical.find(
    (line) =>
      line.isWrapped &&
      !line.text.startsWith(' '.repeat(gutter)),
  )
  if (!broken) return undefined
  return {
    code: 'wrapped-continuation-lost-gutter',
    detail: `row=${broken.index} text=${JSON.stringify(broken.text)}`,
  }
}

async function detectDockColumnDrift(): Promise<LegacyFailure | undefined> {
  const columns = 38
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows: 18,
    scrollback: 200,
  })
  const surface = createTerminalSurface({ writeOut: terminal.write })
  surface.setDock(createRunningDock(columns))
  await terminal.flush()
  const baseline = locateLast(terminal.snapshot().lines, 'Message')
  assert(baseline, 'baseline composer is visible in the real VT')

  const prefixer = createTuiContentPrefixer({ columns })
  surface.writeOutput(
    prefixer.format(
      'Streaming answer ends at a nonzero cell after this long physical line and URL https://example.com/layout',
    ),
  )
  await terminal.flush()
  const streamed = locateLast(terminal.snapshot().lines, 'Message')
  terminal.dispose()

  if (!streamed) {
    return {
      code: 'dock-column-drift',
      detail: 'running composer disappeared from the physical terminal buffer',
    }
  }
  if (streamed.column === baseline.column) return undefined
  return {
    code: 'dock-column-drift',
    detail:
      `baseline=${baseline.column}, streamed=${streamed.column}, ` +
      `baselineRow=${baseline.row}, streamedRow=${streamed.row}`,
  }
}

async function detectChunkBoundaryFailure(): Promise<LegacyFailure | undefined> {
  const source =
    '**结构化回答**：中英混排与 emoji 🚀 必须稳定；长链接 ' +
    'https://example.com/a/very/long/path?query=physical-terminal-layout ' +
    '之后继续输出列表语义与最终结论。'
  const whole = await renderPrinterFixture({ chunks: [source] })
  const characters = await renderPrinterFixture({
    chunks: splitByPattern(source, [1]),
  })
  const random = await renderPrinterFixture({
    chunks: splitByPattern(source, [7, 1, 4, 2, 11, 3, 5]),
  })
  const wholeCanonical = canonicalSnapshot(whole)
  const characterCanonical = canonicalSnapshot(characters)
  const randomCanonical = canonicalSnapshot(random)
  if (
    wholeCanonical === characterCanonical &&
    wholeCanonical === randomCanonical
  ) {
    return undefined
  }
  return {
    code: 'chunk-boundary-changes-screen',
    detail:
      `whole=${whole.lines.length}/${whole.cursor.column}, ` +
      `char=${characters.lines.length}/${characters.cursor.column}, ` +
      `random=${random.lines.length}/${random.cursor.column}`,
  }
}

async function detectResizeFailure(): Promise<LegacyFailure | undefined> {
  const source =
    '**Resize fixture** 中文与 emoji 🧊 ' +
    'https://example.com/resize/reflow/must/use/current-terminal-width ' +
    '继续输出以验证 composer 与 transcript 一起重排。'
  const chunks = splitByPattern(source, [5, 2, 9, 1])
  const resized = await renderPrinterFixture({
    chunks,
    resizeAfterChunk: Math.floor(chunks.length / 2),
  })
  const message = locateLast(resized.lines, 'Message')
  const brokenWrappedRow = resized.lines.find(
    (line) =>
      line.isWrapped &&
      line.text.length > 0 &&
      !line.text.startsWith('  '),
  )
  if (message && !brokenWrappedRow) return undefined
  return {
    code: 'resize-breaks-composer',
    detail: message
      ? `wrapped row ${brokenWrappedRow?.index ?? '?'} lost current-width layout`
      : 'composer disappeared after 56 -> 38 resize',
  }
}

async function main() {
  const failures = (
    await Promise.all([
      detectWrappedContinuationFailure(),
      detectDockColumnDrift(),
      detectChunkBoundaryFailure(),
      detectResizeFailure(),
    ])
  ).filter((failure): failure is LegacyFailure => failure !== undefined)

  const expectedCodes: LegacyFailure['code'][] = [
    'wrapped-continuation-lost-gutter',
    'dock-column-drift',
    'chunk-boundary-changes-screen',
    'resize-breaks-composer',
  ]
  const mode = process.env.BOLO_TUI_VT_EXPECT === 'fixed' ? 'fixed' : 'legacy'

  if (mode === 'fixed') {
    assert(
      failures.length === 0,
      `real VT invariants still fail: ${failures
        .map((failure) => `${failure.code} (${failure.detail})`)
        .join('; ')}`,
    )
    console.log('PASS: CLI TUI real VT invariants')
    return
  }

  for (const code of expectedCodes) {
    assert(
      failures.some((failure) => failure.code === code),
      `legacy fixture must reproduce ${code}`,
    )
  }
  console.log('PASS: CLI TUI legacy real-VT failures captured')
  for (const failure of failures) {
    console.log(`  ${failure.code}: ${failure.detail}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
