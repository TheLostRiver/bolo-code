/**
 * OI-14G: retained terminal cleanup must attempt every recovery step while
 * preserving the first failure.
 */
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createBoloTerminalAdapter,
  createRetainedTuiController,
  runRepl,
} from '../packages/cli/src/index.ts'
import {
  attachSessionTuiController,
} from '../packages/cli/src/resumeCli.ts'
import {
  createSession,
  endSession,
} from '../packages/core/src/index.ts'
import {
  runWithAsyncCleanup,
} from '../packages/cli/src/cleanup.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const BRACKETED_PASTE_DISABLE = '\u001b[?2004l'
const BRACKETED_PASTE_ENABLE = '\u001b[?2004h'

type InputFault =
  | 'add-data'
  | 'remove-data'
  | 'raw-enable'
  | 'raw-restore'
  | 'resume'
  | 'pause'
type OutputFault = 'add-resize' | 'remove-resize'

class FaultInput {
  readonly isTTY = true
  isRaw = false
  readonly attempts: string[] = []
  private readonly events = new EventEmitter()

  constructor(
    private readonly fault: InputFault | undefined,
    private readonly error: Error,
  ) {}

  on(
    event: 'data',
    listener: (data: string | Buffer) => void,
  ): this {
    this.attempts.push('add-data')
    this.events.on(event, listener)
    if (this.fault === 'add-data') throw this.error
    return this
  }

  removeListener(
    event: 'data',
    listener: (data: string | Buffer) => void,
  ): this {
    this.attempts.push('remove-data')
    this.events.removeListener(event, listener)
    if (this.fault === 'remove-data') throw this.error
    return this
  }

  setRawMode(mode: boolean): this {
    this.attempts.push(`raw:${String(mode)}`)
    this.isRaw = mode
    if (mode && this.fault === 'raw-enable') throw this.error
    if (!mode && this.fault === 'raw-restore') throw this.error
    return this
  }

  resume(): this {
    this.attempts.push('resume')
    if (this.fault === 'resume') throw this.error
    return this
  }

  pause(): this {
    this.attempts.push('pause')
    if (this.fault === 'pause') throw this.error
    return this
  }

  listenerCount(): number {
    return this.events.listenerCount('data')
  }

  send(data: string): void {
    this.events.emit('data', Buffer.from(data, 'utf8'))
  }
}

class FaultOutput {
  readonly columns = 80
  readonly rows = 32
  readonly attempts: string[] = []
  private readonly events = new EventEmitter()

  constructor(
    private readonly fault: OutputFault | undefined,
    private readonly error: Error,
  ) {}

  on(event: 'resize', listener: () => void): this {
    this.attempts.push('add-resize')
    this.events.on(event, listener)
    if (this.fault === 'add-resize') throw this.error
    return this
  }

  removeListener(event: 'resize', listener: () => void): this {
    this.attempts.push('remove-resize')
    this.events.removeListener(event, listener)
    if (this.fault === 'remove-resize') throw this.error
    return this
  }

  listenerCount(): number {
    return this.events.listenerCount('resize')
  }
}

async function captureError(
  action: () => void | Promise<void>,
): Promise<unknown> {
  try {
    await action()
    return undefined
  } catch (error) {
    return error
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function restoreOwnProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor)
    return
  }
  Reflect.deleteProperty(target, key)
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function testAdapterCleanupFault(
  fault: InputFault | OutputFault | 'paste-disable',
): Promise<void> {
  const expected = new Error(`${fault} cleanup failure`)
  const input = new FaultInput(
    fault === 'remove-data' ||
      fault === 'raw-restore' ||
      fault === 'pause'
      ? fault
      : undefined,
    expected,
  )
  const output = new FaultOutput(
    fault === 'remove-resize' ? fault : undefined,
    expected,
  )
  const writes: string[] = []
  let pasteDisableAttempts = 0
  const adapter = createBoloTerminalAdapter({
    input,
    output,
    writeOut: (text) => {
      if (text.includes(BRACKETED_PASTE_DISABLE)) {
        pasteDisableAttempts += 1
        if (fault === 'paste-disable') throw expected
      }
      writes.push(text)
    },
  })

  adapter.start(() => {}, () => {})
  adapter.setInputEnabled(true)
  assert(input.isRaw, `${fault}: fixture acquired raw mode`)
  assert(input.listenerCount() === 1, `${fault}: fixture owns stdin once`)
  assert(output.listenerCount() === 1, `${fault}: fixture owns resize once`)

  const waiter = adapter
    .waitForRender(adapter.renderEpoch, 100)
    .then(() => 'resolved' as const, (error: unknown) => error)
  const stoppedWith = await captureError(() => adapter.stop())
  const waiterResult = await waiter

  assert(stoppedWith === expected, `${fault}: stop preserves the first error`)
  assert(
    input.attempts.includes('remove-data'),
    `${fault}: stdin listener removal was attempted`,
  )
  assert(
    pasteDisableAttempts === 1,
    `${fault}: bracketed paste disable was attempted`,
  )
  assert(
    input.attempts.includes('raw:false'),
    `${fault}: raw-mode restoration was attempted`,
  )
  assert(
    input.attempts.includes('pause'),
    `${fault}: stdin pause was attempted`,
  )
  assert(
    output.attempts.includes('remove-resize'),
    `${fault}: resize listener removal was attempted`,
  )
  assert(input.listenerCount() === 0, `${fault}: stdin listener is released`)
  assert(output.listenerCount() === 0, `${fault}: resize listener is released`)
  assert(!input.isRaw, `${fault}: raw mode is restored`)
  assert(
    waiterResult instanceof Error &&
      /stopped before render completed/iu.test(waiterResult.message),
    `${fault}: pending render waiter is rejected by stop`,
  )
  assert(
    writes.filter((text) => text.includes(BRACKETED_PASTE_DISABLE)).length <= 1,
    `${fault}: paste disable is not duplicated`,
  )
}

async function testAdapterAcquisitionFault(
  fault: 'add-data' | 'raw-enable' | 'paste-enable' | 'resume',
): Promise<void> {
  const expected = new Error(`${fault} acquisition failure`)
  const input = new FaultInput(
    fault === 'add-data' || fault === 'raw-enable' || fault === 'resume'
      ? fault
      : undefined,
    expected,
  )
  const output = new FaultOutput(undefined, expected)
  let pasteDisableAttempts = 0
  const adapter = createBoloTerminalAdapter({
    input,
    output,
    writeOut: (text) => {
      if (text.includes(BRACKETED_PASTE_ENABLE) && fault === 'paste-enable') {
        throw expected
      }
      if (text.includes(BRACKETED_PASTE_DISABLE)) pasteDisableAttempts += 1
    },
  })
  adapter.start(() => {}, () => {})

  const acquiredWith = await captureError(() =>
    adapter.setInputEnabled(true),
  )
  const snapshot = {
    inputListeners: input.listenerCount(),
    isRaw: input.isRaw,
    paused: input.attempts.includes('pause'),
    pasteDisableAttempts,
  }
  await captureError(() => adapter.stop())

  assert(
    acquiredWith === expected,
    `${fault}: input acquisition preserves its first error`,
  )
  assert(
    snapshot.inputListeners === 0,
    `${fault}: partial stdin listener is rolled back`,
  )
  assert(!snapshot.isRaw, `${fault}: partial raw mode is rolled back`)
  assert(snapshot.paused, `${fault}: failed acquisition pauses stdin`)
  assert(
    snapshot.pasteDisableAttempts ===
      (fault === 'paste-enable' || fault === 'resume' ? 1 : 0),
    `${fault}: paste mode rollback matches the acquisition boundary`,
  )
}

async function testAsyncBodyCleanupPrecedence(): Promise<void> {
  const primaryError = new Error('async body failure')
  const firstCleanupError = new Error('first async cleanup failure')
  const laterCleanupError = new Error('later async cleanup failure')
  const attempts: string[] = []
  const failedWith = await captureError(() =>
    runWithAsyncCleanup(
      async () => {
        throw primaryError
      },
      [
        async () => {
          attempts.push('first')
          throw firstCleanupError
        },
        () => {
          attempts.push('second')
          throw laterCleanupError
        },
        () => {
          attempts.push('third')
        },
      ],
    ),
  )
  assert(failedWith === primaryError, 'async cleanup preserves the body error')
  assert(
    attempts.join(',') === 'first,second,third',
    'async cleanup attempts every step after a body error',
  )

  const cleanupOnly = await captureError(() =>
    runWithAsyncCleanup(async () => undefined, [
      () => {
        throw firstCleanupError
      },
      () => {
        throw laterCleanupError
      },
    ]),
  )
  assert(
    cleanupOnly === firstCleanupError,
    'successful async body reports the first cleanup error',
  )
}

async function testControllerCleanupContinues(): Promise<void> {
  const firstError = new Error('composer cleanup failure')
  const laterError = new Error('root cleanup failure')
  const input = new FaultInput(undefined, firstError)
  const output = new FaultOutput(undefined, firstError)
  const writes: string[] = []
  const controller = createRetainedTuiController({
    input,
    output,
    writeOut: (text) => writes.push(text),
    env: { NO_COLOR: '1' },
  })
  await controller.start()
  const pendingInput = controller.readInput()
  assert(input.isRaw, 'controller fixture acquired raw mode')

  type ClosableRoot = {
    waitForRevision(revision: number, timeoutMs?: number): Promise<void>
    close(): void
  }
  const root = controller.root as unknown as ClosableRoot
  const rootWaiter = root
    .waitForRevision(Number.MAX_SAFE_INTEGER, 100)
    .then(() => 'resolved' as const, (error: unknown) => error)
  const originalCancel = controller.composer.cancelInput.bind(
    controller.composer,
  )
  const originalClose = root.close.bind(root)
  let rootCloseAttempts = 0
  controller.composer.cancelInput = () => {
    throw firstError
  }
  root.close = () => {
    rootCloseAttempts += 1
    originalClose()
    throw laterError
  }

  const stoppedWith = await captureError(() => controller.stop())
  const rootWaiterResult = await rootWaiter
  const cleanupSnapshot = {
    inputListeners: input.listenerCount(),
    outputListeners: output.listenerCount(),
    isRaw: input.isRaw,
    rootCloseAttempts,
    pasteDisabled: writes.some((text) =>
      text.includes(BRACKETED_PASTE_DISABLE),
    ),
  }

  controller.composer.cancelInput = originalCancel
  root.close = originalClose
  originalCancel()
  originalClose()
  await pendingInput

  assert(stoppedWith === firstError, 'controller stop preserves its first error')
  assert(
    cleanupSnapshot.inputListeners === 0,
    'controller continues through terminal stdin cleanup',
  )
  assert(
    cleanupSnapshot.outputListeners === 0,
    'controller continues through terminal resize cleanup',
  )
  assert(!cleanupSnapshot.isRaw, 'controller continues through raw restoration')
  assert(
    cleanupSnapshot.pasteDisabled,
    'controller continues through bracketed paste cleanup',
  )
  assert(
    cleanupSnapshot.rootCloseAttempts === 1,
    'controller continues through root cleanup',
  )
  assert(
    rootWaiterResult instanceof Error &&
      /stopped before render completed/iu.test(rootWaiterResult.message),
    'controller rejects pending root render waiters',
  )
}

async function testControllerStartFailureCleansUp(): Promise<void> {
  const expected = new Error('resize listener acquisition failure')
  const output = new FaultOutput('add-resize', expected)
  const controller = createRetainedTuiController({
    writeOut: () => {},
    output,
    env: { NO_COLOR: '1' },
  })

  const startedWith = await captureError(() => controller.start())
  const listenerCountAfterFailure = output.listenerCount()
  await captureError(() => controller.stop())

  assert(startedWith === expected, 'controller start preserves renderer failure')
  assert(
    listenerCountAfterFailure === 0,
    'controller start failure releases its partial resize owner',
  )
}

async function testReplCleanupPreservesFailures(): Promise<void> {
  const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdinSetRawMode = Object.getOwnPropertyDescriptor(
    process.stdin,
    'setRawMode',
  )
  const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const previousEnv = {
    term: process.env.TERM,
    layout: process.env.BOLO_TUI_LAYOUT,
    input: process.env.BOLO_TUI_INPUT,
  }
  const sigintListeners = process.listenerCount('SIGINT')

  try {
    process.env.TERM = 'xterm-256color'
    delete process.env.BOLO_TUI_LAYOUT
    delete process.env.BOLO_TUI_INPUT
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(process.stdin, 'setRawMode', {
      configurable: true,
      value: () => process.stdin,
    })
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    })

    for (const bodyFails of [false, true]) {
      const primaryError = new Error('repl body failure')
      const cleanupError = new Error('repl controller cleanup failure')
      const session = await createSession({
        cwd: process.cwd(),
        systemPrompt: false,
        autoSave: false,
      })
      const controller = createRetainedTuiController({
        writeOut: () => {},
        output: { columns: 80, rows: 32 },
        env: { NO_COLOR: '1' },
      })
      controller.readInput = async () => {
        if (bodyFails) throw primaryError
        return { type: 'aborted' }
      }
      let stopAttempts = 0
      controller.stop = async () => {
        stopAttempts += 1
        throw cleanupError
      }
      attachSessionTuiController(session, controller)

      const stoppedWith = await captureError(() =>
        runRepl(session, { isTty: true }),
      )
      const phaseAfterRun = session.phase
      if (session.phase !== 'ended') {
        await endSession(session, { reason: 'other' })
      }

      assert(stopAttempts === 1, 'REPL attempts controller cleanup once')
      assert(
        phaseAfterRun === 'ended',
        `REPL ends the session after controller failure (${String(phaseAfterRun)})`,
      )
      assert(
        stoppedWith === (bodyFails ? primaryError : cleanupError),
        bodyFails
          ? 'REPL preserves the body error over a later cleanup error'
          : 'REPL reports cleanup error when its body succeeded',
      )
      assert(
        process.listenerCount('SIGINT') === sigintListeners,
        'REPL removes its SIGINT listener after cleanup failure',
      )
    }

    {
      const session = await createSession({
        cwd: process.cwd(),
        systemPrompt: false,
        autoSave: false,
      })
      const controller = createRetainedTuiController({
        writeOut: () => {},
        output: { columns: 80, rows: 32 },
        env: { NO_COLOR: '1' },
      })
      let stopAttempts = 0
      controller.readInput = ({ signal } = {}) =>
        new Promise((resolve) => {
          const finish = () => resolve({ type: 'aborted' })
          signal?.addEventListener('abort', finish, { once: true })
          if (signal?.aborted) finish()
        })
      controller.stop = async () => {
        stopAttempts += 1
      }
      attachSessionTuiController(session, controller)
      const abort = new AbortController()
      const pending = runRepl(session, {
        isTty: true,
        signal: abort.signal,
      })
      abort.abort()
      await pending

      assert(session.phase === 'ended', 'external abort ends the REPL session')
      assert(stopAttempts === 1, 'external abort stops the controller once')
      assert(
        process.listenerCount('SIGINT') === sigintListeners,
        'external abort leaves no REPL SIGINT listener',
      )
    }

    {
      const session = await createSession({
        cwd: process.cwd(),
        systemPrompt: false,
        autoSave: false,
      })
      const controller = createRetainedTuiController({
        writeOut: () => {},
        output: { columns: 80, rows: 32 },
        env: { NO_COLOR: '1' },
      })
      let releaseInput: ((result: { type: 'aborted' }) => void) | undefined
      let markReadStarted: (() => void) | undefined
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve
      })
      let stopAttempts = 0
      controller.readInput = () =>
        new Promise((resolve) => {
          releaseInput = resolve
          markReadStarted?.()
        })
      controller.stop = async () => {
        stopAttempts += 1
      }
      attachSessionTuiController(session, controller)

      const pending = runRepl(session, { isTty: true })
      await readStarted
      process.emit('SIGINT')
      releaseInput?.({ type: 'aborted' })
      await pending

      assert(session.phase === 'ended', 'SIGINT ends the REPL session')
      assert(stopAttempts === 1, 'SIGINT stops the controller once')
      assert(
        process.listenerCount('SIGINT') === sigintListeners,
        'SIGINT path removes its process listener',
      )
    }
  } finally {
    restoreEnv('TERM', previousEnv.term)
    restoreEnv('BOLO_TUI_LAYOUT', previousEnv.layout)
    restoreEnv('BOLO_TUI_INPUT', previousEnv.input)
    restoreOwnProperty(process.stdin, 'isTTY', stdinIsTty)
    restoreOwnProperty(process.stdin, 'setRawMode', stdinSetRawMode)
    restoreOwnProperty(process.stdout, 'isTTY', stdoutIsTty)
  }
}

async function runCleanupChild(): Promise<void> {
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true,
  })
  Object.defineProperty(process.stdin, 'setRawMode', {
    configurable: true,
    value: () => process.stdin,
  })
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: true,
  })
  process.env.TERM = 'xterm-256color'
  delete process.env.BOLO_TUI_LAYOUT
  delete process.env.BOLO_TUI_INPUT

  const sigintListeners = process.listenerCount('SIGINT')
  const input = new FaultInput(undefined, new Error('unused input fault'))
  const output = new FaultOutput(undefined, new Error('unused output fault'))
  const writes: string[] = []
  const controller = createRetainedTuiController({
    input,
    output,
    writeOut: (text) => writes.push(text),
    env: { NO_COLOR: '1' },
  })
  await controller.start()
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoSave: false,
  })
  attachSessionTuiController(session, controller)

  const repl = runRepl(session, { isTty: true })
  await waitFor(() => input.listenerCount() === 1, 'child raw stdin owner')
  input.send('\u0003')
  await repl

  console.log(
    JSON.stringify({
      phase: session.phase,
      raw: input.isRaw,
      inputListeners: input.listenerCount(),
      resizeListeners: output.listenerCount(),
      pasteDisabled: writes.some((text) =>
        text.includes(BRACKETED_PASTE_DISABLE),
      ),
      sigintListeners: process.listenerCount('SIGINT') - sigintListeners,
    }),
  )
}

function testCleanupSubprocess(): void {
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url)],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOLO_TUI_CLEANUP_CHILD: '1',
      },
      timeout: 15_000,
      windowsHide: true,
    },
  )
  assert(!child.error, `cleanup child launched (${child.error?.message ?? ''})`)
  assert(
    child.status === 0,
    `cleanup child exits 0 (status=${String(child.status)}, stderr=${child.stderr.trim()})`,
  )
  const reportLine = child.stdout.trim().split(/\r?\n/gu).at(-1)
  assert(reportLine, 'cleanup child emitted a JSON report')
  const report = JSON.parse(reportLine) as {
    phase?: string
    raw?: boolean
    inputListeners?: number
    resizeListeners?: number
    pasteDisabled?: boolean
    sigintListeners?: number
  }
  assert(report.phase === 'ended', 'cleanup child ends its session')
  assert(report.raw === false, 'cleanup child restores cooked mode')
  assert(report.inputListeners === 0, 'cleanup child releases stdin')
  assert(report.resizeListeners === 0, 'cleanup child releases resize')
  assert(report.pasteDisabled === true, 'cleanup child disables paste mode')
  assert(report.sigintListeners === 0, 'cleanup child releases SIGINT')
}

async function main(): Promise<void> {
  for (const fault of [
    'remove-data',
    'paste-disable',
    'raw-restore',
    'pause',
    'remove-resize',
  ] as const) {
    await testAdapterCleanupFault(fault)
  }
  for (const fault of [
    'add-data',
    'raw-enable',
    'paste-enable',
    'resume',
  ] as const) {
    await testAdapterAcquisitionFault(fault)
  }
  await testAsyncBodyCleanupPrecedence()
  await testControllerCleanupContinues()
  await testControllerStartFailureCleansUp()
  await testReplCleanupPreservesFailures()
  testCleanupSubprocess()
  console.log('PASS test-cli-tui-cleanup')
}

const run = process.env.BOLO_TUI_CLEANUP_CHILD === '1'
  ? runCleanupChild
  : main
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
