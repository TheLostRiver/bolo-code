/**
 * OI-15E: retained slash toast/history consumption and error policy.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSession,
  dispatchSlashCommand,
  type SlashDisplayPolicy,
} from '../packages/core/src/index.ts'
import {
  projectRetainedSlashDisplay,
  runOnePrompt,
  type CliSessionEvent,
  type CliTuiController,
  type SessionEventPrinter,
} from '../packages/cli/src/index.ts'
import {
  attachSessionEventPrinter,
  attachSessionTuiController,
} from '../packages/cli/src/resumeCli.ts'
import type {
  CliCommandSurfaceState,
  CliCommandToastInput,
  CliCommandToastState,
} from '../packages/shared/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const provider: LlmProvider = {
  id: 'toast-error-policy-test',
  async *completeStream() {
    throw new Error('slash command must not call the provider')
  },
  async completeText() {
    throw new Error('slash command must not call the provider')
  },
}

type ControllerSpies = {
  toasts: CliCommandToastInput[]
  historyEvents: CliSessionEvent[]
  compatibility: string[]
  flushes: number
}

function createControllerSpy(spies: ControllerSpies): {
  controller: CliTuiController
  printer: SessionEventPrinter
} {
  let nextGeneration = 1
  let toast: CliCommandToastState | undefined
  const printer: SessionEventPrinter = {
    beginTurn() {},
    onEvent(event) {
      spies.historyEvents.push(event)
    },
    endTurn() {},
    didStreamText() {
      return spies.historyEvents.some(
        (event) =>
          event.type === 'text' &&
          typeof event.text === 'string' &&
          event.text.length > 0,
      )
    },
  }
  const controller = {
    printer,
    showCommandToast(input: CliCommandToastInput): CliCommandToastState {
      spies.toasts.push(input)
      toast = { ...input, generation: nextGeneration++ }
      return toast
    },
    writeOutput(text: string): void {
      spies.compatibility.push(text)
    },
    writeError(text: string): void {
      spies.compatibility.push(text)
    },
    getCommandSurfaceState(): CliCommandSurfaceState {
      return {
        ...(toast ? { toast } : {}),
        nextGeneration,
      }
    },
    async flush(): Promise<void> {
      spies.flushes += 1
    },
    setToolPagerContext(): void {},
  }
  return {
    controller: controller as unknown as CliTuiController,
    printer,
  }
}

function testProjection(): void {
  const toastPolicy: SlashDisplayPolicy = {
    surface: 'toast',
    key: 'slash:plan',
    tone: 'success',
    ttlMs: 5_000,
  }
  const toast = projectRetainedSlashDisplay({
    display: toastPolicy,
    content: 'permission mode set to plan',
  })
  assert(
    toast?.kind === 'toast' &&
      toast.toast.key === 'slash:plan' &&
      toast.toast.tone === 'success' &&
      toast.toast.ttlMs === 5_000,
    'toast policy projects to the retained footer slot',
  )

  const durableError = projectRetainedSlashDisplay({
    display: {
      surface: 'history',
      tone: 'error',
      persistence: 'visual-only',
    },
    content: 'plugin rollback failed',
  })
  assert(
    durableError?.kind === 'history' &&
      durableError.history.tone === 'error' &&
      durableError.history.content === 'plugin rollback failed',
    'explicit error history projects to an auditable visual block',
  )
}

async function testRetainedConsumption(): Promise<void> {
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    systemPrompt: false,
    contextWindowTokens: 128_000,
  })
  const beforeMessages = JSON.stringify(session.messages)
  const fallbackWrites: string[] = []
  const spies: ControllerSpies = {
    toasts: [],
    historyEvents: [],
    compatibility: [],
    flushes: 0,
  }
  const fixture = createControllerSpy(spies)
  attachSessionEventPrinter(session, fixture.printer)
  attachSessionTuiController(session, fixture.controller)

  for (let index = 0; index < 20; index += 1) {
    await runOnePrompt(session, '/plan', {
      isTty: true,
      columns: 80,
      rows: 24,
      color: false,
      writeOut: (text) => fallbackWrites.push(text),
      writeErr: (text) => fallbackWrites.push(text),
    })
  }
  assert(
    spies.toasts.length === 20 &&
      spies.toasts.every(
        (toast) =>
          toast.key === 'slash:plan' &&
          toast.tone === 'success' &&
          toast.ttlMs === 5_000,
      ),
    'repeated short actions replace the same success toast',
  )
  assert(
    spies.historyEvents.length === 0,
    'short action feedback does not add retained history blocks',
  )

  await runOnePrompt(session, '/context invalid', {
    isTty: true,
    columns: 80,
    rows: 24,
    color: false,
    writeOut: (text) => fallbackWrites.push(text),
    writeErr: (text) => fallbackWrites.push(text),
  })
  assert(
    spies.toasts.at(-1)?.key === 'slash:context:error' &&
      spies.toasts.at(-1)?.tone === 'error' &&
      spies.toasts.at(-1)?.ttlMs === 8_000,
    'validation failures use the longer error toast policy',
  )
  assert(
    spies.historyEvents.length === 0,
    'ok false does not automatically become durable history',
  )

  const historyBefore = spies.historyEvents.length
  await runOnePrompt(session, '/turn status', {
    isTty: true,
    columns: 80,
    rows: 24,
    color: false,
    writeOut: (text) => fallbackWrites.push(text),
    writeErr: (text) => fallbackWrites.push(text),
  })
  assert(
    spies.historyEvents.length === historyBefore + 1 &&
      spies.historyEvents.at(-1)?.type === 'text',
    'explicit history policy appends one retained visual block',
  )
  assert(
    spies.compatibility.length === 0,
    'migrated toast/history results never use compatibility output',
  )
  assert(
    fallbackWrites.length === 0,
    'retained toast/history results never use the plain writer',
  )
  assert(
    JSON.stringify(session.messages) === beforeMessages,
    'visual feedback does not enter model/session messages',
  )
  assert(spies.flushes === 22, 'every retained result flushes its surface')
}

async function testPlainFallback(): Promise<void> {
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    systemPrompt: false,
  })
  const expected = await dispatchSlashCommand(session, 'plan', '')
  const output: string[] = []
  await runOnePrompt(session, '/plan', {
    isTty: false,
    color: false,
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  })
  assert(
    output.join('') === `${expected.message}\n`,
    'plain/non-TTY action feedback preserves message bytes',
  )
}

async function testPluginErrorClassification(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-toast-policy-'))
  const project = path.join(tmp, 'project')
  const userRoot = path.join(tmp, 'user')
  const blockedUserRoot = path.join(tmp, 'blocked-user-root')
  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  await fs.mkdir(project, { recursive: true })
  await fs.mkdir(userRoot, { recursive: true })

  try {
    process.env.BOLO_CONFIG_DIR = userRoot
    const session = await createSession({
      cwd: project,
      provider,
      systemPrompt: false,
    })

    const usage = await dispatchSlashCommand(session, 'plugins', 'install')
    assert(
      !usage.ok &&
        usage.display.surface === 'toast' &&
        usage.display.tone === 'error',
      'plugin usage errors remain immediately correctable error toasts',
    )

    const failedInstall = await dispatchSlashCommand(
      session,
      'plugins',
      `install path:${path.join(tmp, 'missing-plugin')}`,
    )
    assert(
      !failedInstall.ok &&
        failedInstall.display.surface === 'history' &&
        failedInstall.display.tone === 'error',
      'plugin install execution failures use explicit durable error history',
    )

    await fs.writeFile(blockedUserRoot, 'not a directory', 'utf8')
    process.env.BOLO_CONFIG_DIR = blockedUserRoot
    const failedUninstall = await dispatchSlashCommand(
      session,
      'plugins',
      'uninstall demo-plugin',
    )
    assert(
      !failedUninstall.ok &&
        failedUninstall.display.surface === 'history' &&
        failedUninstall.display.tone === 'error',
      'plugin uninstall execution failures use explicit durable error history',
    )

    process.env.BOLO_CONFIG_DIR = userRoot
    const pluginRoot = path.join(
      project,
      '.bolo',
      'plugins',
      'warning-plugin',
    )
    await fs.mkdir(pluginRoot, { recursive: true })
    await fs.writeFile(
      path.join(pluginRoot, 'bolo.plugin.json'),
      JSON.stringify({
        id: 'warning-plugin',
        version: '1.0.0',
        contributes: { hooks: 'missing-hooks.json' },
      }),
      'utf8',
    )
    const reload = await dispatchSlashCommand(session, 'plugins', 'reload')
    assert(
      reload.ok &&
        reload.message.includes('merge note(s)') &&
        reload.display.surface === 'toast' &&
        reload.display.tone === 'warning',
      'plugin reload merge notes use an explicit warning toast',
    )
    const reloadAlias = await dispatchSlashCommand(
      session,
      'reload-plugins',
      '',
    )
    assert(
      reloadAlias.ok &&
        reloadAlias.display.surface === 'toast' &&
        reloadAlias.display.tone === 'warning',
      'reload alias preserves the warning toast result policy',
    )
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.BOLO_CONFIG_DIR
    } else {
      process.env.BOLO_CONFIG_DIR = previousConfigDir
    }
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

testProjection()
await testRetainedConsumption()
await testPlainFallback()
await testPluginErrorClassification()
console.log('PASS: CLI retained toast/error policy')
