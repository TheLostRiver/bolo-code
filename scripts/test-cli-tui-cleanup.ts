/**
 * OI-14G: retained terminal cleanup must attempt every recovery step while
 * preserving the first failure.
 */
import { EventEmitter } from 'node:events'
import {
  createBoloTerminalAdapter,
  createRetainedTuiController,
} from '../packages/cli/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const BRACKETED_PASTE_DISABLE = '\u001b[?2004l'

type InputFault = 'remove-data' | 'raw-restore' | 'pause'
type OutputFault = 'remove-resize'

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
    this.events.on(event, listener)
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
    if (!mode && this.fault === 'raw-restore') throw this.error
    return this
  }

  resume(): this {
    this.attempts.push('resume')
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
    this.events.on(event, listener)
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
  await testControllerCleanupContinues()
  console.log('PASS test-cli-tui-cleanup')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
