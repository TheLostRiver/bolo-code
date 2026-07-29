/**
 * H2/H3: legacy direct-write and engine-selection modules are absent.
 *
 * Real-VT chunk, gutter, resize and Composer invariants are covered by the
 * retained transcript, base and reliability gates that run before this one.
 */
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'

async function main(): Promise<void> {
  for (const relative of [
    'packages/cli/src/tui/terminalSurface.ts',
    'packages/cli/src/tui/composerSpacing.ts',
    'packages/cli/src/tui/terminalMarkdown.ts',
    'packages/cli/src/tui/tuiEngine.ts',
  ]) {
    await assert.rejects(
      access(path.resolve(relative)),
      `${relative} must be physically deleted`,
    )
  }
  console.log('PASS: legacy terminal surface, layout and engine modules removed')
}

await main()
