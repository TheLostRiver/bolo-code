/**
 * OI-14G: production turn boundaries flush the final retained frame.
 */
import { EventEmitter } from 'node:events'
import {
  createRetainedTuiController,
  runOnePrompt,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { createSession, type BoloSession } from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'
import {
  attachSessionEventPrinter,
  attachSessionTuiController,
} from '../packages/cli/src/resumeCli.ts'
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
}

type Fixture = {
  controller: CliTuiController
  flushCalls: () => number
  session: BoloSession
  terminal: HeadlessTerminalHarness
  writes: string[]
}

async function createFixture(
  provider: LlmProvider,
  options?: { failFlush?: boolean },
): Promise<Fixture> {
  const terminal = new HeadlessTerminalHarness({
    columns: 80,
    rows: 64,
    scrollback: 1_000,
  })
  const output = new ResizableOutput(80, 64)
  const writes: string[] = []
  const controller = createRetainedTuiController({
    writeOut: (text) => {
      writes.push(text)
      terminal.write(text)
    },
    writeErr: (text) => {
      writes.push(text)
      terminal.write(text)
    },
    output,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  await controller.start()
  await terminal.flush()

  let flushCount = 0
  const originalFlush = controller.flush.bind(controller)
  controller.flush = async () => {
    flushCount += 1
    await originalFlush()
    if (options?.failFlush) {
      throw new Error('injected retained flush failure')
    }
  }

  const session = await createSession({
    cwd: process.cwd(),
    provider,
    systemPrompt: false,
    autoSave: false,
    askPermission: async () => 'deny',
    onEvent: (event) => controller.printer.onEvent(event),
  })
  attachSessionEventPrinter(session, controller.printer)
  attachSessionTuiController(session, controller)
  return {
    controller,
    flushCalls: () => flushCount,
    session,
    terminal,
    writes,
  }
}

async function dispose(fixture: Fixture | undefined): Promise<void> {
  if (!fixture) return
  await fixture.controller.stop()
  fixture.terminal.dispose()
}

async function main(): Promise<void> {
  let success: Fixture | undefined
  let failure: Fixture | undefined
  try {
    const successProvider: LlmProvider = {
      id: 'retained-flush-success',
      async *completeStream() {
        yield { type: 'text_delta', text: 'final flush answer' }
        yield { type: 'done' }
      },
    }
    success = await createFixture(successProvider)
    const completed = await runOnePrompt(
      success.session,
      'flush the completed turn',
      {
        writeOut: success.controller.writeOutput,
        writeErr: success.controller.writeError,
        isTty: true,
        columns: 80,
      },
    )
    await success.terminal.flush()
    assert(completed.terminalReason === 'completed', 'success turn completes')
    assert(
      success.flushCalls() === 1,
      'runOnePrompt flushes the completed retained turn exactly once',
    )
    const successScreen = success.terminal
      .viewport()
      .map((line) => line.text)
      .join('\n')
    assert(
      successScreen.includes('final flush answer') &&
        successScreen.includes('Message'),
      'runOnePrompt returns after the final answer and idle Composer are visible',
    )

    const failureProvider: LlmProvider = {
      id: 'retained-flush-provider-failure',
      async *completeStream() {
        throw new Error('provider original failure')
      },
    }
    failure = await createFixture(failureProvider, { failFlush: true })
    let providerResult:
      | Awaited<ReturnType<typeof runOnePrompt>>
      | undefined
    let thrown: unknown
    try {
      providerResult = await runOnePrompt(
        failure.session,
        'preserve the provider failure',
        {
          writeOut: failure.controller.writeOutput,
          writeErr: failure.controller.writeError,
          isTty: true,
          columns: 80,
        },
      )
    } catch (error) {
      thrown = error
    }
    assert(
      thrown === undefined,
      `flush failure must not replace provider failure: ${String(thrown)}`,
    )
    assert(
      providerResult?.terminalReason !== 'completed',
      'provider failure keeps its non-completed terminal reason',
    )
    assert(
      failure.flushCalls() === 1,
      'failed provider turn still attempts one final retained flush',
    )
    await failure.terminal.flush()
    assert(
      failure.writes.join('').includes('provider original failure'),
      'the retained error frame keeps the original provider diagnosis',
    )

    console.log('PASS: CLI retained production turn flush')
  } finally {
    await dispose(failure)
    await dispose(success)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
