/**
 * H2: the legacy direct-write surface is physically absent.
 *
 * Real-VT chunk, gutter, resize and Composer invariants are covered by the
 * retained transcript, base and reliability gates that run before this one.
 */
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'

async function main(): Promise<void> {
  await assert.rejects(
    access(path.resolve('packages/cli/src/tui/terminalSurface.ts')),
    'legacy terminal surface must be physically deleted',
  )
  console.log('PASS: legacy terminal surface removed')
}

await main()
