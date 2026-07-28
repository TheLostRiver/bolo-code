/**
 * OI-14F: retained OverlayHost through a real xterm buffer.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
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

class RawInputHarness extends EventEmitter {
  readonly isTTY = true
  isRaw = false
  readonly rawTransitions: boolean[] = []

  setRawMode(mode: boolean): this {
    this.rawTransitions.push(mode)
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

type Fixture = {
  controller: CliTuiController
  input: RawInputHarness
  output: ResizableOutput
  terminal: HeadlessTerminalHarness
}

const request = {
  toolName: 'Bash',
  toolInput: {
    command: 'npm.cmd test -- --runInBand',
    timeout: 120_000,
    run_in_background: false,
    description: 'Verify the retained overlay',
  },
  toolUseId: 'bash_overlay_1',
  cwd: 'E:\\DEV\\HelsincyAgent',
}

async function createFixture(
  columns = 80,
  rows = 48,
): Promise<Fixture> {
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 1_000,
  })
  const output = new ResizableOutput(columns, rows)
  const input = new RawInputHarness()
  const controller = createRetainedTuiController({
    writeOut: (text) => terminal.write(text),
    writeErr: (text) => terminal.write(text),
    input,
    output,
    color: false,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  controller.configureComposer({
    history: ['older prompt'],
    slashCandidates: [],
    status: {
      permissionMode: 'default',
      providerId: 'openai',
      model: 'gpt-5.4',
    },
  })
  await controller.start()
  await settle({ controller, input, output, terminal })
  return { controller, input, output, terminal }
}

async function settle(fixture: Fixture): Promise<void> {
  await fixture.controller.flush()
  await fixture.terminal.flush()
}

function screen(fixture: Fixture): string {
  return fixture.terminal
    .viewport()
    .map((line) => line.text)
    .join('\n')
}

function assertFits(fixture: Fixture, columns: number, label: string): void {
  for (const line of fixture.terminal.viewport()) {
    assert(
      measureTerminalText(line.text) <= columns,
      `${label}: row ${line.index} exceeds ${columns} cells`,
    )
    assert(
      !line.isWrapped,
      `${label}: row ${line.index} triggered terminal auto-wrap`,
    )
  }
}

async function main(): Promise<void> {
  const fixture = await createFixture()
  try {
    const composer = fixture.controller.composer
    const inputResult = fixture.controller.readInput()
    fixture.input.send('draft!')
    assert(
      composer.getState().value === 'draft!',
      'fixture starts with an editable Composer draft',
    )

    const permission = fixture.controller.runPermissionOverlay({ request })
    await settle(fixture)
    const openScreen = screen(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'permission',
      'permission opens the shared overlay state',
    )
    assert(
      openScreen.includes('npm.cmd test -- --runInBand') &&
        openScreen.includes('E:\\DEV\\HelsincyAgent'),
      'permission overlay shows command and cwd in the xterm buffer',
    )
    assert(
      openScreen.includes('Allow once') &&
        openScreen.includes('Always allow') &&
        openScreen.includes('Deny'),
      'permission overlay exposes all three decisions',
    )
    assert(
      openScreen.includes('❯ 3. Deny'),
      'permission overlay defaults to deny',
    )
    assert(
      fixture.input.isRaw,
      'opening an overlay keeps one retained raw-input owner',
    )
    assert(
      composer === fixture.controller.composer &&
        composer.getState().value === 'draft!',
      'opening an overlay keeps the same Composer and draft',
    )

    let nestedError: unknown
    try {
      await fixture.controller.runPermissionOverlay({ request })
    } catch (error) {
      nestedError = error
    }
    assert(
      nestedError instanceof Error &&
        /overlay already active/iu.test(nestedError.message),
      'a second business overlay is rejected deterministically',
    )

    const epoch = fixture.controller.getRenderEpoch()
    fixture.terminal.resize(38, 48)
    fixture.output.resize(38, 48)
    await fixture.controller.waitForRender(epoch)
    await fixture.terminal.flush()
    assertFits(fixture, 38, 'resized permission overlay')
    assert(
      screen(fixture).includes('npm.cmd test'),
      'permission details remain visible after resize',
    )

    fixture.input.send('\r')
    assert((await permission) === 'deny', 'Enter accepts the safe default')
    await settle(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'none',
      'permission completion closes the overlay state',
    )
    assert(
      composer.getState().value === 'draft!' && fixture.input.isRaw,
      'completion restores the same pending Composer and raw owner',
    )
    fixture.input.send('\u001a')
    assert(
      composer.getState().value === 'draft',
      'Composer undo history survives the overlay lifecycle',
    )
    fixture.input.send('\u0015')
    fixture.input.send('\u001b[A')
    assert(
      composer.getState().value === 'older prompt',
      'Composer prompt history survives the overlay lifecycle',
    )
    fixture.input.send('\u0003')
    assert(
      (await inputResult).type === 'exit',
      'restored Composer receives Ctrl+C after overlay close',
    )

    const escaped = fixture.controller.runPermissionOverlay({ request })
    await settle(fixture)
    assert(fixture.input.isRaw, 'running-turn overlay acquires retained raw input')
    fixture.input.send('\u001b')
    assert((await escaped) === 'deny', 'Esc denies permission')
    assert(
      !fixture.input.isRaw,
      'overlay releases raw input when no Composer read is pending',
    )

    let interrupted = 0
    const ctrlC = fixture.controller.runPermissionOverlay({
      request,
      onInterrupt: () => interrupted++,
    })
    fixture.input.send('\u0003')
    assert((await ctrlC) === 'deny', 'Ctrl+C denies permission')
    assert(interrupted === 1, 'Ctrl+C notifies the active turn owner')

    const abort = new AbortController()
    const aborted = fixture.controller.runPermissionOverlay({
      request,
      signal: abort.signal,
    })
    abort.abort()
    assert((await aborted) === 'deny', 'abort fails permission closed')
    assert(
      fixture.controller.getState().overlay.mode === 'none',
      'abort restores the closed overlay state',
    )

    const stats = fixture.controller.getTerminalStats()
    assert(stats.externalWrites === 0, 'overlay never uses the legacy writer')
    assert(
      stats.concurrentWriteViolations === 0,
      'overlay and root retain one terminal writer',
    )

    const newSessionSource = await fs.readFile(
      path.resolve('packages/cli/src/newSessionCli.ts'),
      'utf8',
    )
    const resumeSource = await fs.readFile(
      path.resolve('packages/cli/src/resumeCli.ts'),
      'utf8',
    )
    assert(
      newSessionSource.includes(
        'runPermissionOverlay: controller.runPermissionOverlay',
      ),
      'new-session retained wiring injects the permission OverlayHost',
    )
    assert(
      (
        resumeSource.match(
          /runPermissionOverlay: controller\.runPermissionOverlay/gu,
        ) ?? []
      ).length >= 2,
      'resume setup and each REPL turn inject the permission OverlayHost',
    )

    console.log('PASS: CLI retained OverlayHost permission lifecycle')
  } finally {
    await fixture.controller.stop()
    fixture.terminal.dispose()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
