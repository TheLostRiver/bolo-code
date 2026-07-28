/**
 * OI-11A: persistent terminal surface and full-width composer.
 */
import {
  createTuiInputState,
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
import { createCliOnEvent } from '../packages/cli/src/resumeCli.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
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
  const eventOutput = createCliOnEvent({
    writeOut: (text) => integrated.push(text),
    writeErr: (text) => integrated.push(text),
    timeline: true,
    color: false,
    columns: 80,
  })
  assert(eventOutput.surface, 'timeline owns a terminal surface')
  eventOutput.surface.setDock(dock(80))
  eventOutput.printer.beginTurn({
    prompt: 'keep the composer',
    echoUser: true,
    activity: true,
  })
  assert(eventOutput.surface.isDockVisible(), 'composer survives turn start')
  eventOutput.printer.onEvent({ type: 'text', text: 'streamed answer' })
  assert(eventOutput.surface.isDockVisible(), 'composer survives streamed text')
  eventOutput.printer.endTurn({ terminalReason: 'completed' })
  const integratedText = integrated.join('')
  assert(integratedText.includes('keep the composer'), 'user echo is present')
  assert(integratedText.includes('streamed answer'), 'assistant text is present')
  assert(
    integratedText.lastIndexOf('Message') >
      integratedText.lastIndexOf('streamed answer'),
    'composer remains the bottom-most rendered region',
  )
  assert(!integratedText.includes('\u001b[2J'), 'printer integration avoids full clear')
  eventOutput.surface.clearDock()

  const plain = createCliOnEvent({
    writeOut: () => {},
    writeErr: () => {},
    timeline: false,
  })
  assert(plain.surface === undefined, 'plain/non-TTY output stays append-only')

  console.log('PASS: CLI terminal surface')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
