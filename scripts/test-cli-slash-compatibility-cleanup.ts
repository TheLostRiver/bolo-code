/**
 * OI-15F: normal retained slash results never use compatibility output.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createSession,
  dispatchSlashCommand,
  productionDeps,
} from '../packages/core/src/index.ts'
import {
  runOnePrompt,
  type CliSessionEvent,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import { attachSessionTuiController } from '../packages/cli/src/resumeCli.ts'
import { normalizeProviderRegistry } from '../packages/config/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'
import type {
  CliCommandPanelInput,
  CliCommandPanelState,
  CliCommandToastInput,
  CliCommandToastState,
  RuntimePagerSuccess,
} from '../packages/shared/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const provider: LlmProvider = {
  id: 'mock',
  async *completeStream() {
    throw new Error('slash command must not call the provider')
  },
  async completeText() {
    throw new Error('slash command must not call the provider')
  },
}

const registry = normalizeProviderRegistry({
  defaultProvider: 'work',
  providers: {
    work: { kind: 'mock', model: 'work-model', label: 'Work' },
    review: { kind: 'mock', model: 'review-model', label: 'Review' },
  },
})

async function createFixtureSession() {
  return await createSession({
    cwd: process.cwd(),
    provider,
    deps: productionDeps(provider),
    systemPrompt: false,
    model: 'work-model',
    providerRegistry: registry,
    providerId: 'work',
    providerProfile: registry.profiles.work,
    effortDialect: 'openai-responses',
  })
}

async function testStructuredCorePayloads(): Promise<void> {
  const session = await createFixtureSession()
  const diff = await dispatchSlashCommand(session, 'diff', '')
  const providerPick = await dispatchSlashCommand(session, 'provider', '')
  const effortPick = await dispatchSlashCommand(session, 'effort', '')
  const providerList = await dispatchSlashCommand(session, 'provider', 'list')
  const diffGit = await dispatchSlashCommand(session, 'diff', 'git')

  assert(
    diff.overlayView?.kind === 'diff' &&
      !('interactiveDiff' in diff),
    'diff uses the renderer-neutral overlay payload only',
  )
  assert(
    providerPick.overlayView?.kind === 'action-picker' &&
      providerPick.overlayView.action === 'provider' &&
      providerPick.overlayView.items.length === 2 &&
      !('interactiveProvider' in providerPick),
    'provider picker items and initial state come from structured core data',
  )
  assert(
    effortPick.overlayView?.kind === 'action-picker' &&
      effortPick.overlayView.action === 'effort' &&
      effortPick.overlayView.items.some((item) => item.id === 'high') &&
      !('interactiveEffort' in effortPick),
    'effort picker uses the same structured action-picker contract',
  )
  assert(
    providerList.display.surface === 'panel',
    'provider list is a read-only panel rather than an empty picker intent',
  )
  assert(
    diffGit.display.surface === 'panel',
    'git diff text is a read-only panel rather than an empty diff overlay',
  )
}

type SurfaceSpies = {
  panels: CliCommandPanelInput[]
  toasts: CliCommandToastInput[]
  history: CliSessionEvent[]
  pickers: Array<{ mode: string; ids: string[] }>
  diffOverlays: number
  compatibility: string[]
  fallback: string[]
}

function createController(spies: SurfaceSpies): CliTuiController {
  let nextGeneration = 1
  let panel: CliCommandPanelState | undefined
  let toast: CliCommandToastState | undefined
  const controller = {
    printer: {
      beginTurn() {},
      onEvent(event: CliSessionEvent) {
        spies.history.push(event)
      },
      endTurn() {},
      didStreamText() {
        return false
      },
    },
    showCommandPanel(input: CliCommandPanelInput) {
      spies.panels.push(input)
      panel = { ...input, generation: nextGeneration++ }
      return panel
    },
    showCommandToast(input: CliCommandToastInput) {
      spies.toasts.push(input)
      toast = { ...input, generation: nextGeneration++ }
      return toast
    },
    async runTextPagerOverlay(): Promise<RuntimePagerSuccess> {
      return { ok: true, reason: 'quit', page: 0, pageCount: 1 }
    },
    async runPickerOverlay(options: {
      mode: 'provider' | 'effort'
      items: Array<{ id: string; label: string }>
    }) {
      spies.pickers.push({
        mode: options.mode,
        ids: options.items.map((item) => item.id),
      })
      const id = options.mode === 'provider' ? 'review' : 'high'
      const index = options.items.findIndex((item) => item.id === id)
      return { ok: true as const, id, index }
    },
    async runDiffOverlay() {
      spies.diffOverlays += 1
      return { ok: true as const, action: 'close' as const }
    },
    getCommandSurfaceState() {
      return {
        ...(panel ? { panel } : {}),
        ...(toast ? { toast } : {}),
        nextGeneration,
      }
    },
    writeOutput(text: string) {
      spies.compatibility.push(text)
    },
    writeError(text: string) {
      spies.compatibility.push(text)
    },
    async flush() {},
  }
  return controller as unknown as CliTuiController
}

async function testRetainedCompletenessFallback(): Promise<void> {
  const session = await createFixtureSession()
  const beforeMessages = JSON.stringify(session.messages)
  const spies: SurfaceSpies = {
    panels: [],
    toasts: [],
    history: [],
    pickers: [],
    diffOverlays: 0,
    compatibility: [],
    fallback: [],
  }
  attachSessionTuiController(session, createController(spies))

  for (const command of ['/provider list', '/diff']) {
    await runOnePrompt(session, command, {
      isTty: true,
      columns: 80,
      rows: 24,
      color: false,
      writeOut: (text) => spies.fallback.push(text),
      writeErr: (text) => spies.fallback.push(text),
    })
  }

  const pickersBeforeDisabled = spies.pickers.length
  const previousProviderPanel = process.env.BOLO_PROVIDER_PANEL
  process.env.BOLO_PROVIDER_PANEL = '0'
  try {
    await runOnePrompt(session, '/provider', {
      isTty: true,
      columns: 80,
      rows: 24,
      color: false,
      writeOut: (text) => spies.fallback.push(text),
      writeErr: (text) => spies.fallback.push(text),
    })
  } finally {
    if (previousProviderPanel === undefined) {
      delete process.env.BOLO_PROVIDER_PANEL
    } else {
      process.env.BOLO_PROVIDER_PANEL = previousProviderPanel
    }
  }
  assert(
    spies.pickers.length === pickersBeforeDisabled &&
      spies.history.some(
        (event) =>
          event.type === 'text' &&
          typeof event.text === 'string' &&
          event.text.toLowerCase().includes('provider'),
      ),
    'disabled retained picker falls back to visual history',
  )

  for (const command of ['/provider', '/effort', '/definitely-missing']) {
    await runOnePrompt(session, command, {
      isTty: true,
      columns: 80,
      rows: 24,
      color: false,
      writeOut: (text) => spies.fallback.push(text),
      writeErr: (text) => spies.fallback.push(text),
    })
  }

  assert(
    spies.panels.some((panel) => panel.key === 'slash:provider'),
    'provider list uses retained panel projection',
  )
  assert(
    spies.history.some(
      (event) =>
        event.type === 'text' &&
        typeof event.text === 'string' &&
        event.text.includes('file changes'),
    ),
    'empty diff overlay falls back to visual history, not compatibility',
  )
  assert(
    spies.pickers.some(
      (picker) =>
        picker.mode === 'provider' && picker.ids.includes('review'),
    ) &&
      spies.pickers.some(
        (picker) =>
          picker.mode === 'effort' && picker.ids.includes('high'),
      ),
    'provider and effort action pickers share the retained OverlayHost',
  )
  assert(
    session.providerId === 'review' && session.effortLevel === 'high',
    'structured picker selections still mutate the intended session state',
  )
  assert(
    spies.toasts.some(
      (toast) =>
        toast.key === 'slash:provider:update' &&
        toast.tone === 'success',
    ) &&
      spies.toasts.some(
        (toast) =>
          toast.key === 'slash:effort:update' &&
          toast.tone === 'success',
      ) &&
      spies.toasts.some(
        (toast) =>
          toast.key === 'slash:unknown' && toast.tone === 'error',
      ),
    'picker results and unknown commands use explicit toast feedback',
  )
  assert(
    spies.diffOverlays === 0,
    'empty diff data does not open a blank overlay',
  )
  assert(
    spies.compatibility.length === 0 && spies.fallback.length === 0,
    'normal retained slash results never use compatibility or plain writers',
  )
  assert(
    JSON.stringify(session.messages) === beforeMessages,
    'transient slash surfaces do not enter session messages',
  )
}

async function testPlainFallbackBytes(): Promise<void> {
  const session = await createFixtureSession()
  const expected = await dispatchSlashCommand(session, 'provider', 'list')
  const output: string[] = []
  await runOnePrompt(session, '/provider list', {
    isTty: false,
    color: false,
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  })
  assert(
    output.join('') === `${expected.message}\n`,
    'plain/non-TTY slash output preserves message bytes',
  )
}

async function testPlainTtyPickerFallback(): Promise<void> {
  const session = await createFixtureSession()
  const preview = await dispatchSlashCommand(session, 'provider', '')
  assert(
    preview.overlayView?.kind === 'action-picker',
    'plain picker fixture exposes structured provider items',
  )
  const reviewIndex = preview.overlayView.items.findIndex(
    (item) => item.id === 'review',
  )
  assert(reviewIndex >= 0, 'plain picker fixture includes review provider')
  const output: string[] = []
  await runOnePrompt(session, '/provider', {
    isTty: true,
    color: false,
    readLine: async () => String(reviewIndex + 1),
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  })
  assert(
    session.providerId === 'review' &&
      output.join('').includes('review'),
    'plain TTY numbered picker consumes the structured provider payload',
  )
}

async function testStaticInteractiveCleanup(): Promise<void> {
  const coreSource = await fs.readFile(
    path.join(process.cwd(), 'packages/core/src/slash.ts'),
    'utf8',
  )
  const cliSource = await fs.readFile(
    path.join(process.cwd(), 'packages/cli/src/resumeCli.ts'),
    'utf8',
  )
  for (const name of [
    'interactiveDiff',
    'interactiveProvider',
    'interactiveEffort',
  ]) {
    assert(!coreSource.includes(name), `core no longer defines ${name}`)
    assert(
      !cliSource.includes(`result.${name}`),
      `retained CLI no longer consumes ${name}`,
    )
  }
}

await testStructuredCorePayloads()
await testRetainedCompletenessFallback()
await testPlainFallbackBytes()
await testPlainTtyPickerFallback()
await testStaticInteractiveCleanup()
console.log('PASS: CLI slash compatibility cleanup')
