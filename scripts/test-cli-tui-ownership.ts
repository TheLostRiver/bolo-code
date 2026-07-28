/**
 * OI-14H H0: production dynamic TTY composition has one retained owner.
 *
 * This guard intentionally allows legacy implementation modules to exist
 * until later deletion slices. It only forbids production entry points from
 * composing or attaching those implementations again.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { createCliOnEvent } from '../packages/cli/src/resumeCli.ts'

async function readSource(relative: string): Promise<string> {
  return readFile(path.resolve(relative), 'utf8')
}

function assertOmits(
  source: string,
  label: string,
  forbidden: readonly string[],
): void {
  for (const symbol of forbidden) {
    assert.equal(
      source.includes(symbol),
      false,
      `${label} must not reference ${symbol}`,
    )
  }
}

async function main(): Promise<void> {
  const [newSessionSource, resumeSource, runtimeSource] =
    await Promise.all([
      readSource('packages/cli/src/newSessionCli.ts'),
      readSource('packages/cli/src/resumeCli.ts'),
      readSource('packages/cli/src/runtimeCli.ts'),
    ])

  assertOmits(newSessionSource, 'new-session composition', [
    'resolveCliTuiEngine',
    'attachSessionTerminalSurface',
    'BOLO_TUI_ENGINE',
  ])
  assertOmits(resumeSource, 'resume/REPL composition', [
    'resolveCliTuiEngine',
    'CliTuiEngine',
    'createTerminalSurface',
    'TerminalSurface',
    'attachSessionTerminalSurface',
    'getSessionTerminalSurface',
    'readTuiInput',
    'TERMINAL_SURFACE',
  ])
  assertOmits(runtimeSource, 'runtime query composition', [
    'resolveCliTuiEngine',
    'runRuntimePager',
    'BOLO_TUI_ENGINE',
  ])

  const dynamic = createCliOnEvent({
    writeOut: () => undefined,
    writeErr: () => undefined,
    timeline: true,
    terminalOutput: { columns: 80, rows: 24 },
    color: false,
    columns: 80,
  })
  assert.ok(
    dynamic.controller,
    'timeline production factory always creates the retained controller',
  )
  assert.equal(
    Reflect.has(dynamic, 'surface'),
    false,
    'timeline production factory exposes no legacy surface',
  )
  await dynamic.controller.stop()

  const plain = createCliOnEvent({
    writeOut: () => undefined,
    writeErr: () => undefined,
    timeline: false,
    color: false,
  })
  assert.equal(
    plain.controller,
    undefined,
    'plain production factory creates no dynamic controller',
  )
  assert.equal(
    Reflect.has(plain, 'surface'),
    false,
    'plain production factory exposes no dynamic surface',
  )

  console.log('PASS: CLI TUI production ownership')
}

await main()
