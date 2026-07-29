/**
 * H2: retained Composer geometry remains independent from the old surface.
 */
import {
  createTuiInputState,
  renderTuiInputBox,
} from '../packages/cli/src/tui/inputBox.ts'
import {
  resolveTuiDockWidth,
  resolveTuiFrameWidth,
} from '../packages/cli/src/tui/frame.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

async function main(): Promise<void> {
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
      `${columns}-column Composer uses the full dock width`,
    )
  }

  assert(
    resolveTuiFrameWidth(220) === 160,
    'content frame remains independently capped',
  )
  assert(
    resolveTuiDockWidth(220) === 218,
    'ultra-wide Composer fills the terminal',
  )

  console.log('PASS: CLI retained Composer geometry')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
