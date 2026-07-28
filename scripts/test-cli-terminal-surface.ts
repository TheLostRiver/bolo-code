/**
 * OI-11A: persistent terminal surface and full-width composer.
 */
import { EventEmitter } from 'node:events'
import {
  createTuiInputState,
  readTuiInput,
  renderTuiInputBox,
} from '../packages/cli/src/tui/inputBox.ts'
import {
  createTerminalSurface,
  type TerminalDock,
} from '../packages/cli/src/tui/terminalSurface.ts'
import {
  resolveTuiDockWidth,
  resolveTuiFrameWidth,
} from '../packages/cli/src/tui/frame.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import { createSessionEventPrinter } from '../packages/cli/src/tui/formatSessionEvent.ts'
import { createTurnActivityIndicator } from '../packages/cli/src/tui/turnActivity.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

class FakeRawInput extends EventEmitter {
  isTTY = true
  isRaw = false

  setRawMode(mode: boolean): void {
    this.isRaw = mode
  }

  resume(): this {
    return this
  }

  pause(): this {
    return this
  }

  setEncoding(): this {
    return this
  }
}

class TestTerminalScreen {
  private rows: string[][] = [[]]
  private row = 0
  private column = 0
  private saved = { row: 0, column: 0 }

  write(text: string): void {
    let index = 0
    while (index < text.length) {
      if (text.startsWith('\u001b7', index)) {
        this.saved = { row: this.row, column: this.column }
        index += 2
        continue
      }
      if (text.startsWith('\u001b8', index)) {
        this.row = this.saved.row
        this.column = this.saved.column
        this.ensureRow()
        index += 2
        continue
      }
      if (text[index] === '\u001b' && text[index + 1] === '[') {
        const sequence = text.slice(index).match(/^\u001b\[([?0-9;]*)([A-Za-z])/)
        if (sequence) {
          const amount = Math.max(1, Number(sequence[1]) || 1)
          if (sequence[2] === 'A') {
            this.row = Math.max(0, this.row - amount)
          } else if (sequence[2] === 'B') {
            this.row += amount
          } else if (sequence[2] === 'C') {
            this.column += amount
          } else if (sequence[2] === 'K' && sequence[1] === '2') {
            this.rows[this.row] = []
          }
          this.ensureRow()
          index += sequence[0].length
          continue
        }
      }

      const codePoint = text.codePointAt(index)
      if (codePoint === undefined) break
      const character = String.fromCodePoint(codePoint)
      index += character.length
      if (character === '\r') {
        this.column = 0
        continue
      }
      if (character === '\n') {
        this.row += 1
        this.column = 0
        this.ensureRow()
        continue
      }
      if (codePoint < 0x20) continue
      this.ensureRow()
      this.rows[this.row]![this.column] = character
      this.column += 1
    }
  }

  lines(): string[] {
    return this.rows.map((row) => row.join('').trimEnd())
  }

  private ensureRow(): void {
    while (this.rows.length <= this.row) this.rows.push([])
  }
}

function lastRowContaining(lines: readonly string[], needle: string): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.includes(needle)) return index
  }
  return -1
}

function dock(columns: number): TerminalDock {
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

async function main() {
  // The welcome/content frame may stay capped; the bottom dock must not.
  for (const columns of [24, 38, 80, 160, 220]) {
    const expected = Math.max(24, columns - 2)
    assert(
      resolveTuiDockWidth(columns) === expected,
      `${columns} columns resolve to ${expected}`,
    )
    const rendered = renderTuiInputBox({
      state: createTuiInputState({ value: 'hello' }),
      columns,
      color: false,
    })
    assert(
      measureTerminalText(rendered.lines[0] ?? '') === expected,
      `${columns}-column composer uses dock width`,
    )
  }
  assert(resolveTuiFrameWidth(220) === 160, 'content frame remains independently capped')
  assert(resolveTuiDockWidth(220) === 218, 'ultra-wide composer fills the terminal')

  const writes: Array<{ stream: 'out' | 'err'; text: string }> = []
  const surface = createTerminalSurface({
    writeOut: (text) => writes.push({ stream: 'out', text }),
    writeErr: (text) => writes.push({ stream: 'err', text }),
  })
  const composer = dock(80)

  surface.setDock(composer)
  assert(surface.isDockVisible(), 'dock becomes visible')
  assert(
    writes.map((entry) => entry.text).join('').includes('Message'),
    'composer is painted',
  )
  const idlePaint = writes.at(-1)?.text ?? ''
  assert(
    idlePaint.includes(`\n${composer.lines[0]}`),
    'idle history and composer keep one surface-owned breathing row',
  )

  surface.setActivity('✦ Thinking · 1.2s')
  assert(surface.isDockVisible(), 'activity update keeps the dock visible')
  assert(
    writes.map((entry) => entry.text).join('').includes('Thinking'),
    'activity is part of the temporary region',
  )
  const activityPaint = writes.at(-1)?.text ?? ''
  assert(
    activityPaint.includes(`✦ Thinking · 1.2s\n\n${composer.lines[0]}`),
    'activity and composer keep one surface-owned breathing row',
  )

  surface.writeOutput('● Bolo\nanswer chunk')
  surface.writeOutput(' continues\n')
  surface.writeError('warn: fixture\n')
  const transcript = writes.map((entry) => entry.text).join('')
  assert(transcript.includes('answer chunk'), 'history output is appended')
  assert(
    transcript.lastIndexOf('Message') > transcript.lastIndexOf('answer chunk'),
    'composer is repainted below appended history',
  )
  assert(
    !transcript.includes('\u001b[2J'),
    'append/repaint never clears the whole screen',
  )
  assert(
    transcript.includes('\u001b[2K'),
    'surface erases only the rows it owns',
  )

  surface.suspend()
  assert(!surface.isDockVisible(), 'permission owner can suspend the dock')
  surface.writeOutput('permission panel\n')
  surface.resume()
  assert(surface.isDockVisible(), 'dock resumes after permission owner exits')
  assert(
    writes.map((entry) => entry.text).join('').includes('permission panel'),
    'suspended output remains visible history',
  )

  surface.clearDock()
  assert(!surface.isDockVisible(), 'clear releases the temporary region')
  surface.writeOutput('idle output\n')
  assert(
    writes.at(-1)?.text === 'idle output\n',
    'inactive surface is append-only',
  )

  // Printer integration: user echo, activity, and streamed text all append
  // above the same persistent composer.
  const integrated: string[] = []
  const screen = new TestTerminalScreen()
  const capture = (text: string) => {
    integrated.push(text)
    screen.write(text)
  }
  const integratedSurface = createTerminalSurface({
    writeOut: capture,
    writeErr: capture,
  })
  const integratedActivity = createTurnActivityIndicator({
    writeOut: integratedSurface.writeOutput,
    renderFrame: (line) => integratedSurface.setActivity(line),
    clearFrame: () => integratedSurface.clearActivity(),
    columns: () => 80,
    color: false,
  })
  const eventPrinter = createSessionEventPrinter({
    writeOut: integratedSurface.writeOutput,
    writeErr: integratedSurface.writeError,
    timeline: true,
    activity: integratedActivity,
    color: false,
    columns: 80,
  })
  integratedSurface.setDock(dock(80))
  eventPrinter.beginTurn({
    prompt: 'keep the composer',
    echoUser: true,
    activity: true,
  })
  assert(integratedSurface.isDockVisible(), 'composer survives turn start')
  eventPrinter.onEvent({ type: 'text', text: 'streamed answer' })
  assert(integratedSurface.isDockVisible(), 'composer survives streamed text')
  eventPrinter.endTurn({ terminalReason: 'completed' })
  const integratedText = integrated.join('')
  assert(integratedText.includes('keep the composer'), 'user echo is present')
  assert(integratedText.includes('streamed answer'), 'assistant text is present')
  assert(
    integratedText.lastIndexOf('Message') >
      integratedText.lastIndexOf('streamed answer'),
    'composer remains the bottom-most rendered region',
  )
  assert(!integratedText.includes('\u001b[2J'), 'printer integration avoids full clear')
  integratedSurface.clearDock()

  const idleInput = new FakeRawInput()
  const idleAbort = new AbortController()
  const pendingIdleInput = readTuiInput({
    input: idleInput as never,
    writeOut: capture,
    columns: 80,
    color: false,
    signal: idleAbort.signal,
  })
  const idleRows = screen.lines()
  const answerRow = lastRowContaining(idleRows, 'streamed answer')
  const composerRow = lastRowContaining(idleRows, 'Message')
  assert(answerRow >= 0, 'VT screen retains the final assistant row')
  assert(composerRow >= 0, 'VT screen paints the idle composer')
  assert(
    composerRow - answerRow >= 2,
    `idle composer keeps a full blank row after the final assistant row: answer=${answerRow}, composer=${composerRow}`,
  )
  idleInput.emit('keypress', 'x', { name: 'x', sequence: 'x' })
  const redrawnIdleRows = screen.lines()
  const redrawnAnswerRow = lastRowContaining(redrawnIdleRows, 'streamed answer')
  const redrawnComposerRow = lastRowContaining(redrawnIdleRows, 'Message')
  assert(
    redrawnComposerRow - redrawnAnswerRow === 2,
    `idle redraw keeps exactly one gap row without accumulating space: answer=${redrawnAnswerRow}, composer=${redrawnComposerRow}`,
  )
  assert(
    redrawnIdleRows.filter((line) => line.includes('Message')).length === 1,
    'idle redraw leaves exactly one composer top border',
  )
  idleAbort.abort()
  await pendingIdleInput
  const clearedIdleRows = screen.lines()
  assert(
    lastRowContaining(clearedIdleRows, 'Message') === -1,
    'idle editor cleanup erases the composer and its gap region',
  )
  assert(
    lastRowContaining(clearedIdleRows, 'streamed answer') >= 0,
    'idle editor cleanup preserves assistant history',
  )
  integratedSurface.dispose()

  console.log('PASS: CLI terminal surface')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
