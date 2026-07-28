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
import { buildDiffViewModelFromPreview } from '../packages/core/src/index.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import type { AskQuestion } from '../packages/shared/src/index.ts'
import type {
  RuntimeListView,
  RuntimeTurnListItem,
} from '../packages/shared/src/runtimeQuery.ts'
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

const questions: AskQuestion[] = [
  {
    header: 'Database',
    question: 'Which database should Bolo use?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  },
  {
    header: 'Features',
    question: 'Which features should be enabled?',
    multiSelect: true,
    options: [{ label: 'Search' }, { label: 'Cache' }],
  },
]

function createDiffModel() {
  return buildDiffViewModelFromPreview({
    tool: 'Edit',
    files: [
      {
        path: 'src/overlay.ts',
        op: 'update',
        added: 12,
        removed: 1,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 12,
            lines: [
              '-const mode = "legacy"',
              '+const mode = "retained"',
              ...Array.from(
                { length: 11 },
                (_, index) => `+const retainedLine${index + 1} = true`,
              ),
            ],
          },
        ],
      },
      {
        path: 'src/pager.ts',
        op: 'add',
        added: 1,
        removed: 0,
        structuredPatch: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ['+export const pager = true'],
          },
        ],
      },
    ],
  })
}

const FIXTURE_TIME = '2026-07-29T12:00:00.000Z'

function createRuntimeListView(count: number): RuntimeListView {
  const items: RuntimeTurnListItem[] = Array.from(
    { length: count },
    (_, index) => {
      const turnId = `turn_${index + 1}`
      return {
        entity: 'turn',
        entityId: turnId,
        record: {
          turnId,
          state: 'completed',
          updatedAt: FIXTURE_TIME,
          terminalReason: 'completed',
        },
        availableActions: [],
      }
    },
  )
  return {
    protocolVersion: 1,
    kind: 'runtime.list',
    generatedAt: FIXTURE_TIME,
    sessionId: 'runtime_overlay_session',
    phase: 'idle',
    runner: { state: 'idle' },
    entity: 'turn',
    items,
  }
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

    const question = fixture.controller.runQuestionOverlay({ questions })
    await settle(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'question' &&
        screen(fixture).includes('Which database should Bolo use?'),
      'question overlay opens with the real first question',
    )
    fixture.input.send('\u001b[B')
    fixture.input.send('\r')
    await settle(fixture)
    assert(
      screen(fixture).includes('Which features should be enabled?'),
      'answering advances inside the same question overlay',
    )
    fixture.input.send(' ')
    fixture.input.send('\u001b[B')
    fixture.input.send(' ')
    fixture.input.send('\r')
    const questionResult = await question
    assert(
      questionResult.kind === 'answered' &&
        questionResult.selections[0]?.selected[0] === 'SQLite' &&
        questionResult.selections[1]?.selected.join(',') === 'Search,Cache',
      'question overlay preserves single and multi-select business results',
    )

    const custom = fixture.controller.runQuestionOverlay({
      questions: [questions[0]!],
    })
    fixture.input.send('\u001b[B')
    fixture.input.send('\u001b[B')
    fixture.input.send('\r')
    await settle(fixture)
    assert(
      screen(fixture).includes('Your answer'),
      'Other opens an editor inside the same OverlayHost',
    )
    fixture.input.send('CockroachDB')
    fixture.input.send('\r')
    const customResult = await custom
    assert(
      customResult.kind === 'answered' &&
        customResult.selections[0]?.custom === true &&
        customResult.selections[0]?.selected[0] === 'CockroachDB',
      'question overlay returns custom text without a second readline owner',
    )

    const cancelledQuestion = fixture.controller.runQuestionOverlay({
      questions,
    })
    fixture.input.send('\u001b')
    assert(
      (await cancelledQuestion).kind === 'cancelled',
      'Esc cancels the whole question batch',
    )

    const provider = fixture.controller.runPickerOverlay({
      mode: 'provider',
      items: [
        { id: 'openai', label: 'OpenAI · active' },
        { id: 'anthropic', label: 'Anthropic' },
      ],
      title: 'Select provider',
      initialIndex: 0,
    })
    await settle(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'provider' &&
        screen(fixture).includes('Anthropic'),
      'provider picker uses the shared OverlayHost',
    )
    fixture.input.send('\u001b[B')
    fixture.input.send('\r')
    const providerResult = await provider
    assert(
      providerResult.ok && providerResult.id === 'anthropic',
      'provider picker returns the selected id',
    )

    const effort = fixture.controller.runPickerOverlay({
      mode: 'effort',
      items: [
        { id: 'auto', label: 'auto' },
        { id: 'high', label: 'high' },
      ],
      title: 'Select effort',
      initialIndex: 1,
    })
    await settle(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'effort' &&
        screen(fixture).includes('Select effort'),
      'effort picker exposes its retained mode and title',
    )
    fixture.input.send('\u001b')
    const effortResult = await effort
    assert(
      !effortResult.ok && effortResult.reason === 'cancel',
      'Esc cancels the effort picker without mutating settings',
    )

    fixture.terminal.resize(80, 48)
    fixture.output.resize(80, 48)
    await settle(fixture)

    const diffBrowse = fixture.controller.runDiffOverlay({
      mode: 'browse',
      model: createDiffModel(),
    })
    await settle(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'diff' &&
        screen(fixture).includes('src/overlay.ts'),
      'diff browser opens inside the shared OverlayHost',
    )
    fixture.input.send('\r')
    await settle(fixture)
    assert(
      screen(fixture).includes('detail:') &&
        screen(fixture).includes('src/overlay.ts'),
      'Enter opens structured diff detail in place',
    )
    const detailBeforeScroll = screen(fixture)
    for (let index = 0; index < 6; index += 1) {
      fixture.input.send('\u001b[B')
    }
    await settle(fixture)
    assert(
      screen(fixture) !== detailBeforeScroll,
      'long diff detail scrolls without a legacy painter',
    )
    fixture.input.send('\u001b[D')
    await settle(fixture)
    assert(
      screen(fixture).includes('Enter open'),
      'Left returns from detail to the diff file list',
    )
    const diffResizeEpoch = fixture.controller.getRenderEpoch()
    fixture.terminal.resize(52, 36)
    fixture.output.resize(52, 36)
    await fixture.controller.waitForRender(diffResizeEpoch)
    await fixture.terminal.flush()
    assertFits(fixture, 52, 'resized diff overlay')
    fixture.input.send('q')
    const diffBrowseResult = await diffBrowse
    assert(
      diffBrowseResult.ok &&
        'reason' in diffBrowseResult &&
        diffBrowseResult.reason === 'quit',
      'q exits retained diff browse mode',
    )

    const allow = fixture.controller.runDiffOverlay({
      mode: 'approve',
      model: createDiffModel(),
      toolName: 'Edit',
    })
    fixture.input.send('y')
    const allowResult = await allow
    assert(
      allowResult.ok &&
        'decision' in allowResult &&
        allowResult.decision === 'allow',
      'y allows a retained file permission',
    )

    const always = fixture.controller.runDiffOverlay({
      mode: 'approve',
      model: createDiffModel(),
      toolName: 'Edit',
    })
    fixture.input.send('a')
    const alwaysResult = await always
    assert(
      alwaysResult.ok &&
        'decision' in alwaysResult &&
        alwaysResult.decision === 'allow_always',
      'a always-allows a retained file permission',
    )

    const deny = fixture.controller.runDiffOverlay({
      mode: 'approve',
      model: createDiffModel(),
      toolName: 'Edit',
    })
    fixture.input.send('n')
    const denyResult = await deny
    assert(
      denyResult.ok &&
        'decision' in denyResult &&
        denyResult.decision === 'deny',
      'n denies a retained file permission',
    )

    const escapedDiff = fixture.controller.runDiffOverlay({
      mode: 'approve',
      model: createDiffModel(),
      toolName: 'Edit',
    })
    fixture.input.send('\u001b')
    const escapedDiffResult = await escapedDiff
    assert(
      escapedDiffResult.ok &&
        'decision' in escapedDiffResult &&
        escapedDiffResult.decision === 'deny',
      'Esc fails retained diff permission closed',
    )

    let diffInterrupts = 0
    const interruptedDiff = fixture.controller.runDiffOverlay({
      mode: 'approve',
      model: createDiffModel(),
      toolName: 'Edit',
      onInterrupt: () => diffInterrupts++,
    })
    fixture.input.send('\u0003')
    const interruptedDiffResult = await interruptedDiff
    assert(
      interruptedDiffResult.ok &&
        'decision' in interruptedDiffResult &&
        interruptedDiffResult.decision === 'deny' &&
        diffInterrupts === 1,
      'Ctrl+C denies diff permission and notifies the turn owner',
    )

    const diffAbort = new AbortController()
    const abortedDiff = fixture.controller.runDiffOverlay({
      mode: 'approve',
      model: createDiffModel(),
      toolName: 'Edit',
      signal: diffAbort.signal,
    })
    diffAbort.abort()
    const abortedDiffResult = await abortedDiff
    assert(
      abortedDiffResult.ok &&
        'decision' in abortedDiffResult &&
        abortedDiffResult.decision === 'deny',
      'abort fails retained diff permission closed',
    )

    fixture.terminal.resize(80, 36)
    fixture.output.resize(80, 36)
    const pager = fixture.controller.runPagerOverlay({
      view: createRuntimeListView(7),
      pageSize: 2,
    })
    await settle(fixture)
    assert(
      fixture.controller.getState().overlay.mode === 'pager' &&
        /page 1\/4/iu.test(screen(fixture)),
      'runtime pager opens on page one inside OverlayHost',
    )
    fixture.input.send('\u001b[6~')
    await settle(fixture)
    assert(/page 2\/4/iu.test(screen(fixture)), 'PgDn advances the pager')
    fixture.input.send('\u001b[5~')
    await settle(fixture)
    assert(/page 1\/4/iu.test(screen(fixture)), 'PgUp reverses the pager')
    fixture.input.send('\u001b[B')
    await settle(fixture)
    assert(/page 2\/4/iu.test(screen(fixture)), 'Down advances the pager')
    fixture.input.send('\u001b[A')
    await settle(fixture)
    assert(/page 1\/4/iu.test(screen(fixture)), 'Up reverses the pager')
    const pagerResizeEpoch = fixture.controller.getRenderEpoch()
    fixture.terminal.resize(44, 30)
    fixture.output.resize(44, 30)
    await fixture.controller.waitForRender(pagerResizeEpoch)
    await fixture.terminal.flush()
    assertFits(fixture, 44, 'resized pager overlay')
    fixture.input.send('q')
    const pagerResult = await pager
    assert(
      pagerResult.ok && pagerResult.reason === 'quit',
      'q exits the retained pager',
    )

    let pagerInterrupts = 0
    const interruptedPager = fixture.controller.runPagerOverlay({
      view: createRuntimeListView(7),
      pageSize: 2,
      onInterrupt: () => pagerInterrupts++,
    })
    fixture.input.send('\u0003')
    const interruptedPagerResult = await interruptedPager
    assert(
      interruptedPagerResult.ok &&
        interruptedPagerResult.reason === 'interrupt' &&
        pagerInterrupts === 1,
      'Ctrl+C interrupts the retained pager exactly once',
    )

    const eofPager = fixture.controller.runPagerOverlay({
      view: createRuntimeListView(7),
      pageSize: 2,
    })
    fixture.input.send('\u0004')
    const eofPagerResult = await eofPager
    assert(
      eofPagerResult.ok && eofPagerResult.reason === 'eof',
      'Ctrl+D preserves the pager eof exit',
    )

    const pagerAbort = new AbortController()
    const abortedPager = fixture.controller.runPagerOverlay({
      view: createRuntimeListView(7),
      pageSize: 2,
      signal: pagerAbort.signal,
    })
    pagerAbort.abort()
    const abortedPagerResult = await abortedPager
    assert(
      abortedPagerResult.ok && abortedPagerResult.reason === 'interrupt',
      'abort closes the retained pager as an interrupt',
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
    const runtimeSource = await fs.readFile(
      path.resolve('packages/cli/src/runtimeCli.ts'),
      'utf8',
    )
    assert(
      newSessionSource.includes(
        'runPermissionOverlay: controller.runPermissionOverlay',
      ) &&
        newSessionSource.includes(
          'runDiffOverlay: controller.runDiffOverlay',
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
    assert(
      (
        resumeSource.match(
          /runDiffOverlay: controller\.runDiffOverlay/gu,
        ) ?? []
      ).length >= 2 &&
        resumeSource.includes('await controller.runDiffOverlay({'),
      'resume permission and /diff paths use the retained diff OverlayHost',
    )
    assert(
      newSessionSource.includes(
        'runQuestionOverlay: controller.runQuestionOverlay',
      ),
      'new-session retained wiring injects the question OverlayHost',
    )
    assert(
      resumeSource.includes('session.askUserQuestion = askUserQuestion'),
      'resume reattaches AskUserQuestion instead of silently returning unavailable',
    )
    assert(
      resumeSource.includes(
        'return await controller.runPickerOverlay',
      ) &&
        resumeSource.includes("mode: 'provider'") &&
        resumeSource.includes("mode: 'effort'"),
      'one retained picker helper serves both provider and effort modes',
    )
    assert(
      !newSessionSource.includes('controller.suspendForLegacyPanel') &&
        !newSessionSource.includes('controller.resumeFromLegacyPanel') &&
        !resumeSource.includes('controller.suspendForLegacyPanel') &&
        !resumeSource.includes('controller.resumeFromLegacyPanel'),
      'retained new/resume paths no longer hand ownership to legacy panels',
    )
    assert(
      runtimeSource.includes(
        "resolveCliTuiEngine({ dynamicTui: true, env }) === 'retained'",
      ) &&
        runtimeSource.includes('await runRetainedRuntimePager({') &&
        runtimeSource.includes('await runRuntimePager({'),
      'runtime CLI selects retained pager only through the explicit engine gate',
    )

    console.log('PASS: CLI retained OverlayHost interaction lifecycle')
  } finally {
    await fixture.controller.stop()
    fixture.terminal.dispose()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
