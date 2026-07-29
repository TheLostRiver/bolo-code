/**
 * OI-15B: retained single-slot command panel/toast state and effects.
 */
import { EventEmitter } from 'node:events'
import {
  createCliCommandSurfaceState,
  reduceCliCommandSurfaceState,
  type CliCommandSurfaceState,
} from '../packages/shared/src/index.ts'
import {
  createRetainedTuiController,
  formatCliCommandSurface,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const PANEL_INPUT = {
  key: 'slash:context',
  title: 'Context',
  content: 'context generation one',
  dismissOnInput: true,
  dismissOnEscape: true,
  ttlMs: 12_000,
  overflow: 'compact' as const,
}

function testSharedReducer(): void {
  let state = createCliCommandSurfaceState()
  assert(!state.panel && !state.toast, 'surface starts empty')
  assert(state.nextGeneration === 1, 'surface generation starts at one')

  state = reduceCliCommandSurfaceState(state, {
    type: 'show_panel',
    panel: PANEL_INPUT,
  })
  const firstPanel = state.panel
  assert(firstPanel?.generation === 1, 'first panel receives generation one')

  state = reduceCliCommandSurfaceState(state, {
    type: 'show_panel',
    panel: {
      ...PANEL_INPUT,
      content: 'context generation two',
    },
  })
  const secondPanel = state.panel
  assert(
    secondPanel?.generation === 2 &&
      secondPanel.content === 'context generation two',
    'same-key panel replaces in one slot with a new generation',
  )

  const beforeStalePanel = state
  state = reduceCliCommandSurfaceState(state, {
    type: 'expire_panel',
    key: firstPanel!.key,
    generation: firstPanel!.generation,
  })
  assert(
    state === beforeStalePanel && state.panel === secondPanel,
    'stale panel timer is a reference-preserving no-op',
  )

  state = reduceCliCommandSurfaceState(state, {
    type: 'show_toast',
    toast: {
      key: 'slash:settings',
      content: 'settings updated',
      tone: 'success',
      ttlMs: 5_000,
    },
  })
  const firstToast = state.toast
  state = reduceCliCommandSurfaceState(state, {
    type: 'show_toast',
    toast: {
      key: 'slash:settings',
      content: 'settings updated again',
      tone: 'success',
      ttlMs: 5_000,
    },
  })
  const secondToast = state.toast
  assert(
    firstToast?.generation === 3 &&
      secondToast?.generation === 4 &&
      secondToast.content === 'settings updated again',
    'toast is also one replaceable slot',
  )

  const beforeStaleToast = state
  state = reduceCliCommandSurfaceState(state, {
    type: 'expire_toast',
    key: firstToast!.key,
    generation: firstToast!.generation,
  })
  assert(
    state === beforeStaleToast && state.toast === secondToast,
    'stale toast timer cannot clear its replacement',
  )

  state = reduceCliCommandSurfaceState(state, { type: 'accepted_input' })
  assert(
    !state.panel && !state.toast && state.nextGeneration === 5,
    'accepted input clears dismissible panel and toast without rewinding ids',
  )

  state = reduceCliCommandSurfaceState(state, {
    type: 'show_panel',
    panel: {
      ...PANEL_INPUT,
      dismissOnInput: false,
      dismissOnEscape: false,
    },
  })
  const persistentPanel = state.panel
  state = reduceCliCommandSurfaceState(state, { type: 'accepted_input' })
  assert(
    state.panel === persistentPanel,
    'accepted input respects panel dismissOnInput=false',
  )
  state = reduceCliCommandSurfaceState(state, { type: 'escape' })
  assert(
    state.panel === persistentPanel,
    'escape respects panel dismissOnEscape=false',
  )

  state = reduceCliCommandSurfaceState(state, { type: 'reset' })
  assert(
    !state.panel &&
      !state.toast &&
      state.nextGeneration === 6,
    'reset clears slots while keeping generation monotonic',
  )
}

class TestOutput extends EventEmitter {
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

class TestInput extends EventEmitter {
  readonly isTTY = true
  isRaw = false

  setRawMode(mode: boolean): this {
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

type TimerRecord = {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

class FakeTimers {
  private nextId = 1
  readonly records = new Map<number, TimerRecord>()
  readonly cleared: number[] = []

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.records.set(id, { callback, delayMs, cancelled: false })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    const id = Number(handle)
    const record = this.records.get(id)
    if (record) record.cancelled = true
    this.cleared.push(id)
  }

  latestId(): number {
    return Math.max(0, ...this.records.keys())
  }

  fire(id: number, includeCancelled = false): void {
    const record = this.records.get(id)
    assert(record, `timer ${id} exists`)
    if (record.cancelled && !includeCancelled) return
    record.callback()
  }

  activeCount(): number {
    return [...this.records.values()].filter((record) => !record.cancelled)
      .length
  }
}

type Fixture = {
  controller: CliTuiController
  input: TestInput
  output: TestOutput
  timers: FakeTimers
}

async function createFixture(
  columns = 80,
  rows = 24,
): Promise<Fixture> {
  const input = new TestInput()
  const output = new TestOutput(columns, rows)
  const timers = new FakeTimers()
  const controller = createRetainedTuiController({
    writeOut: () => {},
    input,
    output,
    color: false,
    env: { NO_COLOR: '1' },
    commandSurfaceTimers: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  })
  controller.setWelcomeVisible(false)
  controller.configureComposer({
    history: ['history prompt'],
    slashCandidates: [
      {
        name: 'doctor',
        description: 'Show diagnostics',
        source: 'builtin',
      },
    ],
    status: {
      permissionMode: 'ask',
      model: 'surface-model',
    },
  })
  await controller.start()
  return { controller, input, output, timers }
}

function renderRoot(controller: CliTuiController, columns: number): string[] {
  return controller.root.render(columns)
}

function testFormatter(state: CliCommandSurfaceState): void {
  for (const columns of [24, 38, 80, 160]) {
    const lines = formatCliCommandSurface(state, {
      columns,
      rows: 24,
      color: false,
    })
    assert(lines.length <= 11, `${columns}: panel plus toast remains bounded`)
    for (const line of lines) {
      assert(
        measureTerminalText(line) <= columns,
        `${columns}: command surface line fits terminal cells`,
      )
    }
  }
}

async function testRetainedIntegration(): Promise<void> {
  const fixture = await createFixture()
  try {
    const first = fixture.controller.showCommandPanel({
      ...PANEL_INPUT,
      content: Array.from(
        { length: 30 },
        (_, index) => `panel row ${index}`,
      ).join('\n'),
    })
    fixture.controller.showCommandToast({
      key: 'slash:toast',
      content: 'toast marker',
      tone: 'success',
      ttlMs: 5_000,
    })
    await fixture.controller.flush()

    let state = fixture.controller.getCommandSurfaceState()
    assert(
      state.panel?.generation === first.generation && state.toast,
      'controller exposes the shared single-slot state',
    )
    testFormatter(state)

    let lines = renderRoot(fixture.controller, 80)
    const composerRow = lines.findIndex((line) => line.includes('Message'))
    const panelRow = lines.findIndex((line) => line.includes('Context'))
    const footerRow = lines.findIndex((line) => line.includes('surface-model'))
    assert(
      composerRow >= 0 &&
        panelRow > composerRow &&
        footerRow > panelRow,
      'panel renders below Composer and before the footer',
    )
    assert(
      lines.filter((line) => line.includes('toast marker')).length === 1,
      'toast renders once in the footer-adjacent command surface',
    )

    const originalLineCount = lines.length
    for (let index = 0; index < 20; index += 1) {
      fixture.controller.showCommandPanel({
        ...PANEL_INPUT,
        content: `replace marker ${index}`,
      })
    }
    lines = renderRoot(fixture.controller, 80)
    assert(
      lines.length <= originalLineCount &&
        lines.some((line) => line.includes('replace marker 19')) &&
        !lines.some((line) => line.includes('replace marker 18')),
      'twenty panel updates replace in place without growing root height',
    )

    const beforeResize = fixture.controller.getCommandSurfaceState()
    fixture.output.resize(38, 18)
    await fixture.controller.flush()
    assert(
      fixture.controller.getCommandSurfaceState() === beforeResize,
      'resize does not change command surface lifetime or generation',
    )

    const readHistory = fixture.controller.readInput()
    fixture.input.send('\u001b[A')
    assert(
      fixture.controller.getCommandSurfaceState().panel,
      'history navigation does not dismiss the panel',
    )
    fixture.input.send('x')
    assert(
      !fixture.controller.getCommandSurfaceState().panel &&
        !fixture.controller.getCommandSurfaceState().toast,
      'first real input mutation dismisses panel and toast',
    )
    fixture.input.send('\u0003')
    await readHistory

    fixture.controller.showCommandPanel(PANEL_INPUT)
    const readEscape = fixture.controller.readInput()
    fixture.input.send('\u001b')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert(
      !fixture.controller.getCommandSurfaceState().panel,
      'idle Escape dismisses a panel when no slash menu owns Escape',
    )
    fixture.input.send('\u0003')
    await readEscape

    const readMenuEscape = fixture.controller.readInput()
    fixture.input.send('\u0015')
    fixture.input.send('/')
    fixture.controller.showCommandPanel({
      ...PANEL_INPUT,
      dismissOnInput: false,
    })
    fixture.input.send('\u001b')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert(
      fixture.controller.composer.getState().slashMenu === null &&
        fixture.controller.getCommandSurfaceState().panel,
      'first Escape closes the slash menu before a coexisting panel',
    )
    fixture.input.send('\u001b')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert(
      !fixture.controller.getCommandSurfaceState().panel,
      'second idle Escape dismisses the panel after the slash menu',
    )
    fixture.input.send('\u0003')
    await readMenuEscape

    const oldPanel = fixture.controller.showCommandPanel(PANEL_INPUT)
    const oldPanelTimer = fixture.timers.latestId()
    const newPanel = fixture.controller.showCommandPanel({
      ...PANEL_INPUT,
      content: 'new timer generation',
    })
    const newPanelTimer = fixture.timers.latestId()
    assert(
      newPanel.generation > oldPanel.generation &&
        fixture.timers.cleared.includes(oldPanelTimer),
      'panel replacement cancels the old timer',
    )
    fixture.timers.fire(oldPanelTimer, true)
    assert(
      fixture.controller.getCommandSurfaceState().panel?.generation ===
        newPanel.generation,
      'cancelled timer racing late cannot clear the new panel',
    )
    fixture.timers.fire(newPanelTimer)
    assert(
      !fixture.controller.getCommandSurfaceState().panel,
      'current panel timer clears its own generation',
    )

    const restoredPanel = fixture.controller.showCommandPanel(PANEL_INPUT)
    const restoredPanelTimer = fixture.timers.latestId()
    fixture.controller.restoreMessages([])
    assert(
      !fixture.controller.getCommandSurfaceState().panel &&
        fixture.timers.activeCount() === 0,
      'message restore clears command state and cancels its timer',
    )
    const afterRestore = fixture.controller.showCommandPanel({
      ...PANEL_INPUT,
      content: 'after restore',
    })
    assert(
      afterRestore.generation > restoredPanel.generation,
      'message restore preserves monotonic command generations',
    )
    fixture.timers.fire(restoredPanelTimer, true)
    assert(
      fixture.controller.getCommandSurfaceState().panel?.generation ===
        afterRestore.generation,
      'a pre-restore timer racing late cannot clear post-restore state',
    )
    fixture.controller.resetCommandSurface()

    fixture.controller.showCommandToast({
      key: 'slash:final-toast',
      content: 'final toast',
      tone: 'info',
      ttlMs: 5_000,
    })
    assert(fixture.timers.activeCount() > 0, 'toast owns one active timer')
    fixture.controller.resetCommandSurface()
    assert(
      !fixture.controller.getCommandSurfaceState().toast &&
        fixture.timers.activeCount() === 0,
      'reset clears state and cancels all timers',
    )

    fixture.controller.showCommandToast({
      key: 'slash:stop-toast',
      content: 'stop toast',
      tone: 'warning',
      ttlMs: 5_000,
    })
  } finally {
    await fixture.controller.stop()
  }
  assert(
    fixture.timers.activeCount() === 0,
    'controller stop disposes command surface timers',
  )
}

testSharedReducer()
await testRetainedIntegration()
console.log('PASS: CLI retained command surface')
