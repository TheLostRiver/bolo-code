/**
 * OI-14C/H: retained renderer base, real VT width/resize and product lifecycle.
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createCliOnEvent,
  createRetainedTuiController,
  runNewSessionCli,
  runResumeCli,
} from '../packages/cli/src/index.ts'
import { getSessionTuiController } from '../packages/cli/src/resumeCli.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
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

function assertPhysicalFrame(
  terminal: HeadlessTerminalHarness,
  width: number,
  label: string,
): void {
  const viewport = terminal.viewport()
  for (const line of viewport) {
    assert(
      measureTerminalText(line.text) <= width,
      `${label}: physical row ${line.index} exceeds ${width} cells`,
    )
    assert(
      !line.isWrapped,
      `${label}: logical renderer line triggered terminal auto-wrap at row ${line.index}`,
    )
  }
  const visible = viewport
    .map((line) => line.text)
    .join('\n')
  assert(/BOLO/i.test(visible), `${label}: Bolo welcome remains visible`)
}

function countBufferLinesContaining(
  terminal: HeadlessTerminalHarness,
  marker: string,
): number {
  return terminal
    .snapshot()
    .lines.filter((line) => line.text.includes(marker)).length
}

async function createFixture(columns: number, rows = 36) {
  const terminal = new HeadlessTerminalHarness({
    columns,
    rows,
    scrollback: 500,
  })
  const output = new ResizableOutput(columns, rows)
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
  controller.configureWelcome({
    version: '0.0.1',
    headline: 'Welcome to Bolo Code',
    cwd: 'E:\\workspace\\retained-fixture-with-a-long-directory-name',
    model: 'openai/gpt-retained-fixture',
    sessionId: 'sess_retained_fixture',
    hint: '/help commands · /provider model',
  })
  await controller.start()
  await terminal.flush()
  return { controller, output, terminal, writes }
}

async function main() {
  // Every supported viewport is rendered through xterm's real cell/auto-wrap
  // semantics. No test-side string screen is allowed here.
  for (const columns of [24, 38, 56, 80, 120, 160, 220]) {
    const fixture = await createFixture(columns)
    try {
      assertPhysicalFrame(
        fixture.terminal,
        columns,
        `${columns}-column initial frame`,
      )
      assert(
        !fixture.writes.join('').includes('\u001b[3J'),
        `${columns}-column frame preserves terminal scrollback`,
      )
    } finally {
      await fixture.controller.stop()
      fixture.terminal.dispose()
    }
  }

  // A one-time welcome must not become a live dependency on the mutable
  // session. When a top-of-root message count changes after the transcript
  // has entered scrollback, Pi otherwise forces a full-root redraw and the
  // adapter's scrollback preservation turns that redraw into duplicated
  // welcome/history rows.
  {
    const terminal = new HeadlessTerminalHarness({
      columns: 120,
      rows: 25,
      scrollback: 1_000,
    })
    const output = new ResizableOutput(120, 25)
    const writes: string[] = []
    const welcomeMessages = [
      { role: 'user' as const, content: 'welcome session marker' },
    ]
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
      env: { TERM: 'xterm-256color' },
      color: false,
      activityIntervalMs: 60_000,
    })
    controller.configureWelcome({
      version: '0.0.1',
      headline: 'WELCOME REPLAY MARKER',
      cwd: 'E:\\workspace\\history-replay',
      model: 'openai/replay-fixture',
      sessionId: 'sess_history_replay',
      session: {
        permissionMode: 'default',
        model: 'replay-fixture',
        messages: welcomeMessages,
      },
    })
    try {
      controller.restoreMessages([
        { role: 'user', content: 'HISTORY REPLAY MARKER' },
        {
          role: 'assistant',
          content: Array.from(
            { length: 52 },
            (_, index) => `completed history line ${index}`,
          ).join('\n'),
        },
      ])
      await controller.start()
      await controller.flush()
      await terminal.flush()

      const initialWelcomeCount = countBufferLinesContaining(
        terminal,
        'BOLO CODE',
      )
      const initialHistoryCount = countBufferLinesContaining(
        terminal,
        'HISTORY REPLAY MARKER',
      )
      assert(
        initialWelcomeCount === 1,
        `welcome is committed to native scrollback exactly once initially; ` +
          `count=${initialWelcomeCount} lines=${terminal.snapshot().lines.length} ` +
          `clears=${controller.getTerminalStats().filteredScrollbackClears} ` +
          `head=${JSON.stringify(
            terminal.snapshot().lines.slice(0, 12).map((line) => line.text),
          )}`,
      )
      assert(
        initialHistoryCount === 1,
        `completed history is committed to native scrollback exactly once initially; ` +
          `count=${initialHistoryCount}`,
      )

      const clearsBefore =
        controller.getTerminalStats().filteredScrollbackClears
      welcomeMessages.push({
        role: 'user',
        content: 'new prompt mutates live session length',
      })
      const snapshottedWelcome = controller.root.render(120).join('\n')
      assert(
        snapshottedWelcome.includes('1 message') &&
          !snapshottedWelcome.includes('2 messages'),
        'one-time welcome renders its configured session snapshot',
      )
      controller.printer.beginTurn({
        prompt: 'current prompt marker',
        echoUser: true,
        activity: true,
      })
      await controller.flush()
      await terminal.flush()

      assert(
        controller.getTerminalStats().filteredScrollbackClears === clearsBefore,
        'top-of-root welcome mutation does not trigger a forced full redraw',
      )
      assert(
        countBufferLinesContaining(terminal, 'BOLO CODE') === 1,
        'thinking does not append the one-time welcome to scrollback again',
      )
      assert(
        countBufferLinesContaining(terminal, 'HISTORY REPLAY MARKER') === 1,
        'thinking does not append completed history to scrollback again',
      )

      const resizeClearsBefore =
        controller.getTerminalStats().filteredScrollbackClears
      const resizeEpoch = controller.getRenderEpoch()
      terminal.resize(100, 25)
      output.resize(100, 25)
      await controller.waitForRender(resizeEpoch)
      await terminal.flush()
      assert(
        controller.getTerminalStats().filteredScrollbackClears >
          resizeClearsBefore,
        'resize still performs a clearing full redraw',
      )
      assert(
        countBufferLinesContaining(terminal, 'BOLO CODE') === 1,
        'resize redraw keeps the one-time welcome owned by existing scrollback',
      )
      assert(
        countBufferLinesContaining(terminal, 'HISTORY REPLAY MARKER') === 1,
        'resize redraw does not replay completed history into scrollback',
      )

      const heightResizeEpoch = controller.getRenderEpoch()
      const beforeHeightResize = terminal.snapshot()
      terminal.resize(100, 80)
      output.resize(100, 80)
      await controller.waitForRender(heightResizeEpoch)
      await terminal.flush()
      const afterHeightResize = terminal.snapshot()
      assert(
        countBufferLinesContaining(terminal, 'BOLO CODE') === 1,
        'expanded viewport still contains only one welcome copy',
      )
      assert(
        countBufferLinesContaining(terminal, 'HISTORY REPLAY MARKER') === 1,
        `expanded viewport still contains only one completed history copy; ` +
          `count=${countBufferLinesContaining(terminal, 'HISTORY REPLAY MARKER')} ` +
          `before=${JSON.stringify({
            baseY: beforeHeightResize.baseY,
            viewportY: beforeHeightResize.viewportY,
            lines: beforeHeightResize.lines.length,
          })} after=${JSON.stringify({
            baseY: afterHeightResize.baseY,
            viewportY: afterHeightResize.viewportY,
            lines: afterHeightResize.lines.length,
          })}`,
      )
    } finally {
      await controller.stop()
      terminal.dispose()
    }
  }

  // OI-14B is the only live state source. Streaming events update the same
  // root object; the retained renderer does not create a second event model.
  {
    const fixture = await createFixture(80)
    try {
      const root = fixture.controller.root
      fixture.controller.printer.beginTurn({
        prompt: 'keep stable component identity',
        echoUser: true,
        activity: true,
      })
      fixture.controller.printer.onEvent({
        type: 'reasoning',
        text: 'checking retained state',
      })
      fixture.controller.printer.onEvent({ type: 'reasoning_end' })
      fixture.controller.printer.onEvent({
        type: 'text',
        text: 'retained answer chunk',
      })
      fixture.controller.printer.endTurn({ terminalReason: 'completed' })
      await fixture.controller.flush()
      await fixture.terminal.flush()

      const state = fixture.controller.getState()
      assert(state.turns.length === 1, 'controller consumes OI-14B turn state')
      assert(
        state.turns[0]?.blocks.some(
          (block) =>
            block.kind === 'assistant' &&
            block.text === 'retained answer chunk',
        ),
        'assistant stream is projected by the shared reducer',
      )
      assert(
        fixture.controller.root === root,
        'event updates retain the root component identity',
      )
      assertPhysicalFrame(fixture.terminal, 80, 'stream update frame')
    } finally {
      await fixture.controller.stop()
      fixture.terminal.dispose()
    }
  }

  // Resize uses Pi's full viewport redraw but the Bolo adapter strips CSI 3J,
  // so old-width cells disappear without deleting primary-buffer scrollback.
  {
    const fixture = await createFixture(120)
    try {
      const root = fixture.controller.root
      const epoch = fixture.controller.getRenderEpoch()
      fixture.terminal.resize(38, 36)
      fixture.output.resize(38, 36)
      await fixture.controller.waitForRender(epoch)
      await fixture.terminal.flush()

      assert(
        fixture.controller.root === root,
        'resize retains the root component identity',
      )
      assert(
        fixture.controller.getTerminalStats().filteredScrollbackClears > 0,
        'adapter filtered Pi scrollback clear during resize',
      )
      assert(
        !fixture.writes.join('').includes('\u001b[3J'),
        'resize output never deletes terminal scrollback',
      )
      assertPhysicalFrame(fixture.terminal, 38, '120-to-38 resize frame')
    } finally {
      await fixture.controller.stop()
      fixture.terminal.dispose()
    }
  }

  // Production factory routing is binary: timeline creates exactly one
  // retained controller; plain mode creates no dynamic owner.
  {
    const retainedTerminal = new HeadlessTerminalHarness({
      columns: 80,
      rows: 36,
    })
    const retainedOutput = new ResizableOutput(80, 36)
    const retained = createCliOnEvent({
      writeOut: retainedTerminal.write,
      writeErr: retainedTerminal.write,
      timeline: true,
      terminalOutput: retainedOutput,
      color: false,
      columns: 80,
    })
    assert(retained.controller, 'retained factory returns one controller')
    assert(
      !Reflect.has(retained, 'surface'),
      'retained factory exposes no legacy surface',
    )
    await retained.controller.stop()
    retainedTerminal.dispose()
  }

  // Non-TTY formatter bytes are an independent contract and cannot route
  // through Pi or cursor control.
  {
    const out: string[] = []
    const err: string[] = []
    const plain = createCliOnEvent({
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      timeline: false,
      color: false,
    })
    plain.printer.beginTurn({
      prompt: 'not echoed in plain mode',
      echoUser: true,
    })
    plain.onEvent({ type: 'reasoning', text: 'think' })
    plain.onEvent({ type: 'reasoning_end' })
    plain.onEvent({ type: 'text', text: 'answer' })
    plain.printer.endTurn({ terminalReason: 'completed' })
    assert(!plain.controller, 'plain path never creates retained controller')
    assert(
      !Reflect.has(plain, 'surface'),
      'plain path exposes no dynamic surface',
    )
    assert(
      out.join('') === '\u001b[2mthinking \u001b[0mthink\nanswer\n',
      `plain output bytes changed: ${JSON.stringify(out.join(''))}`,
    )
    assert(err.join('') === '', 'plain fixture keeps stderr empty')
  }

  // The product new/resume lifecycle uses retained, starts the same
  // controller, restores history, and tears down its resize ownership.
  {
    const tempParent = path.resolve('.bolo-tmp')
    await fs.mkdir(tempParent, { recursive: true })
    const tempRoot = await fs.mkdtemp(
      path.join(tempParent, 'oi-14c-retained-'),
    )
    const previous = {
      configDir: process.env.BOLO_CONFIG_DIR,
      noColor: process.env.NO_COLOR,
      provider: process.env.BOLO_PROVIDER,
      term: process.env.TERM,
    }
    const stdinIsTty = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY',
    )
    const stdinSetRawMode = Object.getOwnPropertyDescriptor(
      process.stdin,
      'setRawMode',
    )
    const stdoutIsTty = Object.getOwnPropertyDescriptor(
      process.stdout,
      'isTTY',
    )
    const restoreEnv = (
      name: string,
      value: string | undefined,
    ): void => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }

    try {
      const cwd = path.join(tempRoot, 'workspace')
      await fs.mkdir(cwd, { recursive: true })
      process.env.BOLO_CONFIG_DIR = path.join(tempRoot, 'user')
      process.env.BOLO_PROVIDER = 'mock'
      process.env.NO_COLOR = '1'
      process.env.TERM = 'xterm-256color'
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: true,
      })
      const rawTransitions: boolean[] = []
      Object.defineProperty(process.stdin, 'setRawMode', {
        configurable: true,
        value: (mode: boolean) => {
          rawTransitions.push(mode)
          return process.stdin
        },
      })
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      })

      const newWrites: string[] = []
      const created = await runNewSessionCli({
        cwd,
        prompt: 'retained new-session smoke',
        forceMock: true,
        isTty: true,
        readPermissionAnswer: async () => 'n',
        writeOut: (text) => newWrites.push(text),
        writeErr: (text) => newWrites.push(text),
      })
      const newBytes = newWrites.join('')
      assert(
        created.terminalReason === 'completed',
        'new-session retained smoke completed',
      )
      assert(
        newBytes.includes('\u001b[?2026h') && /BOLO/i.test(newBytes),
        'new-session lifecycle started the retained root',
      )
      assert(
        !newBytes.includes('\u001b[3J'),
        'new-session lifecycle preserved scrollback',
      )

      const resumeWrites: string[] = []
      const resumed = await runResumeCli({
        idOrPath: created.session.id,
        cwd,
        prompt: 'retained resume smoke',
        forceMock: true,
        reassembleSystem: false,
        systemPrompt: false,
        isTty: true,
        readPermissionAnswer: async () => 'n',
        writeOut: (text) => resumeWrites.push(text),
        writeErr: (text) => resumeWrites.push(text),
      })
      const resumeBytes = resumeWrites.join('')
      assert(
        resumed.terminalReason === 'completed',
        'resume retained smoke completed',
      )
      assert(
        resumeBytes.includes('\u001b[?2026h') && /BOLO/i.test(resumeBytes),
        'resume lifecycle restored and started the retained root',
      )
      assert(
        !resumeBytes.includes('\u001b[3J'),
        'resume lifecycle preserved scrollback',
      )

      const runInteractiveExit = async (
        run: (
          write: (text: string) => void,
          signal: AbortSignal,
        ) => Promise<{
          session: Parameters<typeof getSessionTuiController>[0]
        }>,
      ) => {
        const writes: string[] = []
        let inputSent = false
        let timedOut = false
        const abort = new AbortController()
        const write = (text: string): void => {
          writes.push(text)
          if (inputSent || !text.includes('\u001b[?2004h')) return
          inputSent = true
          const keys = [...'/exit', '\r', '\r']
          const sendNext = (): void => {
            const key = keys.shift()
            if (key === undefined) return
            process.stdin.emit('data', Buffer.from(key, 'utf8'))
            if (keys.length) setImmediate(sendNext)
          }
          setImmediate(sendNext)
        }
        const timer = setTimeout(() => {
          timedOut = true
          abort.abort()
        }, 5_000)
        try {
          const result = await run(write, abort.signal)
          return { result, writes, inputSent, timedOut }
        } finally {
          clearTimeout(timer)
        }
      }

      const listenersBeforeInteractive = process.stdin.listenerCount('data')
      const newInteractive = await runInteractiveExit((write, signal) =>
        runNewSessionCli({
          cwd,
          forceMock: true,
          isTty: true,
          signal,
          readPermissionAnswer: async () => 'n',
          writeOut: write,
          writeErr: write,
        }),
      )
      const newController = getSessionTuiController(
        newInteractive.result.session,
      )
      assert(
        newInteractive.inputSent && !newInteractive.timedOut,
        `interactive new session consumed /exit through retained stdin; ` +
          `value=${JSON.stringify(newController?.composer.getState().value)}`,
      )
      assert(
        newController?.composer
          .getState()
          .slashCandidates.some((candidate) => candidate.name === 'doctor'),
        'interactive new session configured the Composer slash catalog',
      )
      assert(
        newController?.composer.getStatus()?.model ===
          newInteractive.result.session.model,
        'interactive new session configured Composer model/status before input',
      )
      assert(
        (newController?.getTerminalStats().inputEvents ?? 0) > 0,
        'interactive new-session input is owned by the retained adapter',
      )

      const resumeInteractive = await runInteractiveExit((write, signal) =>
        runResumeCli({
          idOrPath: created.session.id,
          cwd,
          forceMock: true,
          reassembleSystem: false,
          systemPrompt: false,
          isTty: true,
          signal,
          readPermissionAnswer: async () => 'n',
          writeOut: write,
          writeErr: write,
        }),
      )
      const resumeController = getSessionTuiController(
        resumeInteractive.result.session,
      )
      assert(
        resumeInteractive.inputSent && !resumeInteractive.timedOut,
        `interactive resume consumed /exit through retained stdin; ` +
          `value=${JSON.stringify(resumeController?.composer.getState().value)}`,
      )
      assert(
        (resumeController?.getTerminalStats().inputEvents ?? 0) > 0,
        'interactive resume input is owned by the retained adapter',
      )
      assert(
        rawTransitions.slice(-4).join(',') === 'true,false,true,false',
        'new and resume REPL each acquire and release raw mode exactly once',
      )
      assert(
        process.stdin.listenerCount('data') === listenersBeforeInteractive,
        'new and resume REPL release their production stdin listener',
      )
    } finally {
      restoreEnv('BOLO_CONFIG_DIR', previous.configDir)
      restoreEnv('NO_COLOR', previous.noColor)
      restoreEnv('BOLO_PROVIDER', previous.provider)
      restoreEnv('TERM', previous.term)
      restoreOwnProperty(process.stdin, 'isTTY', stdinIsTty)
      restoreOwnProperty(process.stdin, 'setRawMode', stdinSetRawMode)
      restoreOwnProperty(process.stdout, 'isTTY', stdoutIsTty)
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  }

  // Static ownership guard: only the existing CLI composition layer may bind
  // process streams. Retained components and adapter never import the legacy
  // surface or Pi ProcessTerminal.
  for (const relative of [
    'packages/cli/src/tui/boloTerminalAdapter.ts',
    'packages/cli/src/tui/retainedTui.ts',
  ]) {
    const source = await fs.readFile(path.resolve(relative), 'utf8')
    assert(
      !/process\.(stdout|stdin)|ProcessTerminal|TerminalSurface|contentPrefixer|terminalMarkdown/.test(
        source,
      ),
      `${relative} owns no process stream or legacy renderer dependency`,
    )
  }

  console.log('PASS: CLI TUI retained renderer base')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
