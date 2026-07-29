/**
 * OI-14H H0: production dynamic TTY composition has one retained owner.
 *
 * This guard intentionally allows legacy implementation modules to exist
 * until later deletion slices. It only forbids production entry points from
 * composing or attaching those implementations again.
 */

import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
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

async function assertFileMissing(relative: string): Promise<void> {
  await assert.rejects(
    access(path.resolve(relative)),
    `${relative} must be physically deleted`,
  )
}

async function main(): Promise<void> {
  const [
    newSessionSource,
    resumeSource,
    runtimeSource,
    retainedSource,
    adapterSource,
    runtimePagerSource,
    cliIndexSource,
    arrowPickerSource,
    diffPaneSource,
    permissionPanelSource,
    questionPickerSource,
  ] =
    await Promise.all([
      readSource('packages/cli/src/newSessionCli.ts'),
      readSource('packages/cli/src/resumeCli.ts'),
      readSource('packages/cli/src/runtimeCli.ts'),
      readSource('packages/cli/src/tui/retainedTui.ts'),
      readSource('packages/cli/src/tui/boloTerminalAdapter.ts'),
      readSource('packages/cli/src/tui/runtimePager.ts'),
      readSource('packages/cli/src/index.ts'),
      readSource('packages/cli/src/tui/arrowPicker.ts'),
      readSource('packages/cli/src/tui/diffPane.ts'),
      readSource('packages/cli/src/tui/permissionPanel.ts'),
      readSource('packages/cli/src/tui/questionPicker.ts'),
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
  assertOmits(retainedSource, 'retained controller', [
    'suspendForLegacyPanel',
    'resumeFromLegacyPanel',
    'isSuspended',
    'setExternalOwner',
    'writeExternal',
  ])
  assertOmits(adapterSource, 'retained terminal adapter', [
    'externalOwner',
    'externalWrites',
    'concurrentWriteViolations',
    'setExternalOwner',
    'writeExternal',
  ])
  assertOmits(runtimePagerSource, 'runtime pager module', [
    'RuntimePagerInput',
    'adaptRuntimePagerInput',
    'readRuntimePagerKey',
    'runRuntimePager',
  ])
  assertOmits(cliIndexSource, 'CLI public index', [
    'runArrowPicker',
    'runDiffPane',
    'runDiffApprovePane',
    'runPermissionPanel',
  ])
  assertOmits(arrowPickerSource, 'arrow picker module', [
    'createLocalPanelPainter',
    'runArrowPicker',
  ])
  assertOmits(diffPaneSource, 'diff view-model module', [
    'createLocalPanelPainter',
    'runDiffPaneLoop',
    'runDiffPane',
    'runDiffApprovePane',
  ])
  assertOmits(permissionPanelSource, 'permission view-model module', [
    'createLocalPanelPainter',
    'runPermissionPanel',
  ])
  assertOmits(questionPickerSource, 'question view-model module', [
    'createLocalPanelPainter',
    'runQuestionPicker',
  ])
  await assertFileMissing('packages/cli/src/tui/localPanel.ts')

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
