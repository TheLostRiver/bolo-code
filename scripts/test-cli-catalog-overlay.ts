/**
 * OI-15D: Skills/Plugins stable-key catalog overlays.
 */
import { EventEmitter } from 'node:events'
import {
  createSession,
  dispatchSlashCommand,
  previewSlashCommandDisplay,
} from '../packages/core/src/index.ts'
import {
  createRetainedTuiController,
  runOnePrompt,
  type CliSessionEvent,
  type CliTuiController,
  type RetainedCatalogOverlayHandle,
  type RetainedCatalogOverlayOptions,
} from '../packages/cli/src/index.ts'
import { attachSessionTuiController } from '../packages/cli/src/resumeCli.ts'
import { RetainedOverlayHost } from '../packages/cli/src/tui/retainedOverlay.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const provider: LlmProvider = {
  id: 'catalog-overlay-test',
  async *completeStream() {
    throw new Error('slash command must not call the provider')
  },
  async completeText() {
    throw new Error('slash command must not call the provider')
  },
}

async function createCatalogSession() {
  const session = await createSession({
    cwd: 'E:\\workspace\\catalog',
    provider,
    systemPrompt: false,
    skills: [
      {
        meta: {
          id: 'crystal-review',
          name: 'Crystal Review',
          description: 'Review a change without editing it.',
          path: 'E:\\skills\\crystal-review\\SKILL.md',
        },
        source: 'project',
        body: 'Review the current change.',
        frontmatter: {},
      },
      {
        meta: {
          id: 'release-check',
          name: 'Release Check',
          path: 'E:\\skills\\release-check\\SKILL.md',
        },
        source: 'user',
        body: 'Check release readiness.',
        frontmatter: {},
      },
    ],
  })
  session.plugins = [
    {
      manifest: {
        id: 'workspace-tools',
        name: 'Workspace Tools',
        version: '1.2.3',
      },
      root: 'E:\\plugins\\workspace-tools',
      scope: 'project',
    },
  ]
  return session
}

async function testCoreCatalogContract(): Promise<void> {
  const skillsPreview = previewSlashCommandDisplay('/skills crystal')
  assert(
    skillsPreview?.display.surface === 'overlay' &&
      skillsPreview.display.key === 'slash:skills',
    'skills display can be resolved before executing the command',
  )
  const searchPreview = previewSlashCommandDisplay('/plugins search cache')
  assert(
    searchPreview?.display.surface === 'overlay' &&
      searchPreview.display.key === 'slash:plugins:search',
    'async plugin search exposes a stable pre-dispatch overlay key',
  )
  assert(
    previewSlashCommandDisplay('/plugins install demo@local')?.display
      .surface === 'toast',
    'plugin mutation remains an action surface instead of a picker',
  )

  const session = await createCatalogSession()
  const skills = await dispatchSlashCommand(
    session,
    'skills',
    'crystal',
  )
  assert(
    skills.overlayView?.kind === 'picker' &&
      skills.overlayView.items.length === 1 &&
      skills.overlayView.items[0]?.id === 'crystal-review',
    'skills return renderer-neutral picker items without message parsing',
  )
  const plugins = await dispatchSlashCommand(session, 'plugins', '')
  assert(
    plugins.overlayView?.kind === 'picker' &&
      plugins.overlayView.items[0]?.id === 'workspace-tools',
    'plugins return renderer-neutral picker items',
  )
}

async function testCatalogHostLifecycle(): Promise<void> {
  let inputEnabled = false
  let rows = 18
  const hidden: boolean[] = []
  const host = new RetainedOverlayHost({
    color: false,
    setOverlayState: () => {},
    requestRender: () => {},
    setInputEnabled: (active) => {
      inputEnabled = active
    },
    shouldKeepInput: () => false,
    getColumns: () => 52,
    getRows: () => rows,
  })
  host.attach({
    setHidden(value: boolean) {
      hidden.push(value)
    },
  } as never)

  const first = host.openCatalog({
    key: 'slash:plugins:search',
    sessionId: 'session-a',
    cwd: 'E:\\workspace\\a',
    title: 'Plugin search',
    loadingText: 'Loading plugins...',
  })
  assert(
    host.render(52).join('\n').includes('Loading plugins') &&
      inputEnabled,
    'catalog opens with visible loading state under the existing raw owner',
  )

  const second = host.openCatalog({
    key: 'slash:plugins:search',
    sessionId: 'session-a',
    cwd: 'E:\\workspace\\a',
    title: 'Plugin search',
    loadingText: 'Refreshing plugins...',
  })
  assert(
    second.identity.generation > first.identity.generation,
    'same stable key advances request generation',
  )
  assert(
    !first.replace({
      key: 'slash:plugins:search',
      sessionId: 'session-a',
      cwd: 'E:\\workspace\\a',
      items: [{ id: 'stale', label: 'Stale result' }],
    }),
    'superseded request cannot replace the current overlay',
  )
  assert(
    second.replace({
      key: 'slash:plugins:search',
      sessionId: 'session-a',
      cwd: 'E:\\workspace\\a',
      items: [{ id: 'fresh', label: 'Fresh result' }],
    }) &&
      host.render(52).join('\n').includes('Fresh result') &&
      !host.render(52).join('\n').includes('Refreshing plugins'),
    'matching result replaces loading in the same overlay slot',
  )
  host.handleInput('q')
  const secondResult = await second.result
  assert(
    !secondResult.ok &&
      secondResult.reason === 'cancel' &&
      !host.isActive() &&
      inputEnabled === false &&
      hidden.at(-1) === true,
    'q closes catalog and restores input ownership',
  )
  const firstResult = await first.result
  assert(
    !firstResult.ok && firstResult.reason === 'cancel',
    'replaced request settles instead of leaking a waiter',
  )

  const wrongSession = host.openCatalog({
    key: 'slash:skills',
    sessionId: 'session-a',
    cwd: 'E:\\workspace\\a',
    title: 'Skills',
    loadingText: 'Loading skills...',
  })
  assert(
    !wrongSession.replace({
      key: 'slash:skills',
      sessionId: 'session-b',
      cwd: 'E:\\workspace\\a',
      items: [{ id: 'late', label: 'Late session result' }],
    }) && !host.render(52).join('\n').includes('Late session result'),
    'session change ignores a late result',
  )
  await wrongSession.result

  const wrongCwd = host.openCatalog({
    key: 'slash:skills',
    sessionId: 'session-a',
    cwd: 'E:\\workspace\\a',
    title: 'Skills',
    loadingText: 'Loading skills...',
  })
  assert(
    !wrongCwd.replace({
      key: 'slash:skills',
      sessionId: 'session-a',
      cwd: 'E:\\workspace\\b',
      items: [{ id: 'late', label: 'Late cwd result' }],
    }) && !host.render(52).join('\n').includes('Late cwd result'),
    'cwd change ignores a late result',
  )
  await wrongCwd.result

  const active = host.openCatalog({
    key: 'slash:skills',
    sessionId: 'session-a',
    cwd: 'E:\\workspace\\a',
    title: 'Skills',
    loadingText: 'Loading skills...',
  })
  const abortedController = new AbortController()
  abortedController.abort()
  const aborted = host.openCatalog({
    key: 'slash:skills',
    sessionId: 'session-a',
    cwd: 'E:\\workspace\\a',
    title: 'Skills',
    loadingText: 'Never shown',
    signal: abortedController.signal,
  })
  assert(
    !aborted.replace({
      key: 'slash:skills',
      sessionId: 'session-a',
      cwd: 'E:\\workspace\\a',
      items: [{ id: 'ignored', label: 'Ignored' }],
    }) &&
      active.replace({
        key: 'slash:skills',
        sessionId: 'session-a',
        cwd: 'E:\\workspace\\a',
        items: [{ id: 'active', label: 'Active request' }],
      }),
    'an already-aborted replacement does not displace the active request',
  )
  await aborted.result
  host.handleInput('q')
  await active.result

  const longCatalog = host.openCatalog({
    key: 'slash:plugins',
    sessionId: 'session-a',
    cwd: 'E:\\workspace\\a',
    title: 'Plugins',
    loadingText: 'Loading plugins...',
  })
  assert(
    longCatalog.replace({
      key: 'slash:plugins',
      sessionId: 'session-a',
      cwd: 'E:\\workspace\\a',
      items: Array.from({ length: 40 }, (_, index) => ({
        id: `plugin-${index + 1}`,
        label: `Plugin ${index + 1}`,
      })),
    }),
    'long catalog accepts its matching result',
  )
  const firstPage = host.render(52)
  assert(
    firstPage.length <= rows &&
      firstPage.some((line) => line.includes('Plugin 1')) &&
      !firstPage.some((line) => line.includes('Plugin 40')),
    'long catalog renders a bounded first window',
  )
  host.handleInput('\u001b[F')
  const lastPage = host.render(52)
  assert(
    lastPage.some((line) => /›\s+40\.\s+Plugin 40/u.test(line)),
    'End keeps the final selection visible',
  )
  host.handleInput('\u001b[5~')
  const previousPage = host.render(52)
  assert(
    previousPage.some((line) => line.startsWith('›')) &&
      !previousPage.some((line) => /›\s+40\./u.test(line)),
    'PageUp moves by the visible catalog window',
  )
  rows = 10
  const resizedPage = host.render(52)
  assert(
    resizedPage.length <= rows &&
      resizedPage.some((line) => line.startsWith('›')),
    'resize recomputes a bounded window around the current selection',
  )
  host.handleInput('\u001b[H')
  assert(
    host.render(52).some((line) => /›\s+1\.\s+Plugin 1/u.test(line)),
    'Home returns to the first item without changing overlay ownership',
  )
  host.handleInput('q')
  await longCatalog.result
}

class RawInputHarness extends EventEmitter {
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

class OutputHarness extends EventEmitter {
  columns = 80
  rows = 30
}

async function testComposerRestore(): Promise<void> {
  const input = new RawInputHarness()
  const output = new OutputHarness()
  const controller = createRetainedTuiController({
    writeOut: () => {},
    writeErr: () => {},
    input,
    output,
    color: false,
    env: { NO_COLOR: '1' },
  })
  controller.setWelcomeVisible(false)
  controller.configureComposer({
    history: [],
    slashCandidates: [],
    status: {
      permissionMode: 'default',
      providerId: 'openai',
      model: 'catalog-test',
    },
  })
  await controller.start()
  try {
    const pendingInput = controller.readInput()
    input.send('draft!')
    input.send('\u001b[D')
    const before = controller.composer.getState()
    const request = controller.openCatalogOverlay({
      key: 'slash:skills',
      sessionId: 'session-a',
      cwd: 'E:\\workspace\\a',
      title: 'Skills',
      loadingText: 'Loading skills...',
    })
    assert(
      request.replace({
        key: 'slash:skills',
        sessionId: 'session-a',
        cwd: 'E:\\workspace\\a',
        items: [{ id: 'crystal-review', label: 'Crystal Review' }],
      }),
      'controller applies the matching catalog result',
    )
    input.send('\u001b')
    await request.result
    const after = controller.composer.getState()
    assert(
      after.value === before.value &&
        after.cursor === before.cursor &&
        input.isRaw,
      'closing catalog restores Composer value, cursor, focus, and raw owner',
    )
    input.send('?')
    assert(
      controller.composer.getState().value === 'draft?!',
      'typing resumes at the restored cursor after overlay close',
    )
    input.send('\u0003')
    await pendingInput
  } finally {
    await controller.stop()
  }
}

type CatalogSpy = {
  opened: Array<{
    key: string
    sessionId: string
    cwd: string
    loadingText: string
  }>
  replaced: string[][]
  compatibility: string[]
}

function createControllerSpy(spy: CatalogSpy): CliTuiController {
  let generation = 0
  return {
    openCatalogOverlay(options: RetainedCatalogOverlayOptions) {
      spy.opened.push(options)
      const identity = {
        key: options.key,
        generation: ++generation,
        sessionId: options.sessionId,
        cwd: options.cwd,
      }
      const handle: RetainedCatalogOverlayHandle = {
        identity,
        result: Promise.resolve({
          ok: false,
          reason: 'cancel',
          message: 'cancelled',
        }),
        replace(update) {
          if (
            update.key !== identity.key ||
            update.sessionId !== identity.sessionId ||
            update.cwd !== identity.cwd
          ) {
            return false
          }
          spy.replaced.push(update.items.map((item) => item.id))
          return true
        },
        dismiss() {
          return true
        },
      }
      return handle
    },
    writeOutput(text: string) {
      spy.compatibility.push(text)
    },
    writeError(text: string) {
      spy.compatibility.push(text)
    },
    async flush() {},
  } as unknown as CliTuiController
}

async function testRunOnePromptConsumption(): Promise<void> {
  const session = await createCatalogSession()
  session.messages.push({
    role: 'user',
    content: 'This message must remain unchanged.',
  })
  const beforeMessages = JSON.stringify(session.messages)
  const spy: CatalogSpy = {
    opened: [],
    replaced: [],
    compatibility: [],
  }
  attachSessionTuiController(session, createControllerSpy(spy))

  const fallbackWrites: string[] = []
  for (let index = 0; index < 20; index += 1) {
    await runOnePrompt(session, '/skills crystal', {
      isTty: true,
      writeOut: (text) => fallbackWrites.push(text),
      writeErr: (text) => fallbackWrites.push(text),
    })
  }
  assert(
    spy.opened.length === 20 &&
      spy.opened.every((opened) => opened.key === 'slash:skills') &&
      /loading skills/iu.test(spy.opened[0]?.loadingText ?? ''),
    '20 skill catalogs reuse the same stable loading key',
  )
  assert(
    spy.replaced.length === 20 &&
      spy.replaced.every((items) => items[0] === 'crystal-review'),
    'each loading state is replaced with structured skill items',
  )
  assert(
    spy.compatibility.length === 0 && fallbackWrites.length === 0,
    'migrated catalog commands bypass compatibility and plain writers',
  )
  assert(
    JSON.stringify(session.messages) === beforeMessages,
    'catalog overlays never enter model/session messages',
  )

  const fallbackSession = await createCatalogSession()
  const fallbackCompatibility: string[] = []
  const fallbackHistory: CliSessionEvent[] = []
  attachSessionTuiController(fallbackSession, {
    printer: {
      beginTurn() {},
      onEvent(event: CliSessionEvent) {
        fallbackHistory.push(event)
      },
      endTurn() {},
      didStreamText() {
        return false
      },
    },
    openCatalogOverlay() {
      throw new Error('permission overlay already owns focus')
    },
    writeOutput(text: string) {
      fallbackCompatibility.push(text)
    },
    writeError(text: string) {
      fallbackCompatibility.push(text)
    },
    async flush() {},
  } as unknown as CliTuiController)
  await runOnePrompt(fallbackSession, '/skills crystal', {
    isTty: true,
    writeOut: (text) => fallbackCompatibility.push(text),
    writeErr: (text) => fallbackCompatibility.push(text),
  })
  assert(
    fallbackCompatibility.length === 0 &&
      fallbackHistory.some(
        (event) =>
          event.type === 'text' &&
          typeof event.text === 'string' &&
          event.text.includes('Skills (catalog)'),
      ),
    'catalog falls back to visual history when another overlay owns focus',
  )
}

await testCoreCatalogContract()
await testCatalogHostLifecycle()
await testComposerRestore()
await testRunOnePromptConsumption()
console.log('PASS: CLI retained Skills/Plugins catalog overlays')
