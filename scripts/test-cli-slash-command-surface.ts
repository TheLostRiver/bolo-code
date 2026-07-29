/**
 * OI-15C: slash display policy consumption in the retained CLI.
 */
import {
  createSession,
  type SlashDisplayPolicy,
} from '../packages/core/src/index.ts'
import {
  formatTextPagerScreen,
  measureTerminalText,
  projectRetainedSlashDisplay,
  runOnePrompt,
  type CliTuiController,
  type RetainedTextPagerOverlayOptions,
} from '../packages/cli/src/index.ts'
import { attachSessionTuiController } from '../packages/cli/src/resumeCli.ts'
import { RetainedOverlayHost } from '../packages/cli/src/tui/retainedOverlay.ts'
import type {
  CliCommandPanelInput,
  CliCommandPanelState,
  CliCommandSurfaceState,
  RuntimePagerSuccess,
} from '../packages/shared/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const provider: LlmProvider = {
  id: 'slash-surface-test',
  async *completeStream() {
    throw new Error('slash command must not call the provider')
  },
  async completeText() {
    throw new Error('slash command must not call the provider')
  },
}

const overflowPolicy: SlashDisplayPolicy = {
  surface: 'panel',
  key: 'slash:doctor',
  placement: 'below-composer',
  dismissOnInput: true,
  dismissOnEscape: true,
  overflow: 'pager',
}

function testProjection(): void {
  const short = projectRetainedSlashDisplay({
    display: overflowPolicy,
    content: 'node 22 · cwd ready',
    columns: 80,
    rows: 24,
  })
  assert(
    short?.kind === 'panel' &&
      short.panel.key === 'slash:doctor' &&
      short.panel.title === 'Doctor',
    'short overflow-enabled diagnostics stay in the command panel',
  )

  const longContent = Array.from(
    { length: 30 },
    (_, index) => `diagnostic row ${index + 1}`,
  ).join('\n')
  const long = projectRetainedSlashDisplay({
    display: overflowPolicy,
    content: longContent,
    columns: 80,
    rows: 24,
  })
  assert(
    long?.kind === 'pager' &&
      long.pager.key === 'slash:doctor' &&
      long.pager.content === longContent,
    'long overflow-enabled diagnostics promote to the text pager',
  )

  const directPager = projectRetainedSlashDisplay({
    display: {
      surface: 'overlay',
      key: 'slash:context:details',
      view: 'pager',
    },
    content: 'single page details',
    columns: 80,
    rows: 24,
  })
  assert(
    directPager?.kind === 'pager' &&
      directPager.pager.title === 'Context details',
    'explicit pager policy opens even for one page',
  )

  const ignored = projectRetainedSlashDisplay({
    display: {
      surface: 'toast',
      key: 'slash:error',
      tone: 'error',
      ttlMs: 8_000,
    },
    content: 'not part of OI-15C',
    columns: 80,
    rows: 24,
  })
  assert(ignored === undefined, 'OI-15C does not consume toast policy')
}

function testTextPagerFormatter(): void {
  const single = formatTextPagerScreen({
    title: 'Context details',
    content: '一页内容保持可见',
    columns: 24,
    page: 0,
    pageSize: 4,
    color: false,
  })
  assert(single.pageCount === 1, 'short text pager has one page')
  assert(single.text.includes('一页内容'), 'single-page pager renders content')
  assert(single.text.includes('Context details'), 'text pager renders title')

  const multi = formatTextPagerScreen({
    title: 'Doctor',
    content: Array.from(
      { length: 12 },
      (_, index) => `诊断项目 ${index + 1}：状态正常`,
    ).join('\n'),
    columns: 24,
    page: 1,
    pageSize: 3,
    color: false,
  })
  assert(multi.pageCount > 1 && multi.page === 1, 'long text is paginated')
  assert(multi.text.includes(`${multi.page + 1}/${multi.pageCount}`), 'pager shows page position')
  assert(
    multi.lines.every((line) => measureTerminalText(line) <= 24),
    'CJK text pager lines fit terminal cells',
  )
}

async function testTextPagerOverlayLifecycle(): Promise<void> {
  let columns = 24
  let inputEnabled = false
  const hidden: boolean[] = []
  const host = new RetainedOverlayHost({
    color: false,
    setOverlayState: () => {},
    requestRender: () => {},
    setInputEnabled: (active) => {
      inputEnabled = active
    },
    shouldKeepInput: () => false,
    getColumns: () => columns,
    getRows: () => 10,
  })
  host.attach({
    setHidden(value: boolean) {
      hidden.push(value)
    },
  } as never)

  const singlePage = host.runTextPager({
    key: 'slash:context:details',
    title: 'Context details',
    content: '单页内容',
    pageSize: 3,
  })
  assert(host.isActive() && inputEnabled, 'single-page text pager opens')
  assert(
    host.render(columns).join('\n').includes('单页内容'),
    'single-page overlay renders its content',
  )
  host.handleInput('q')
  const singleResult = await singlePage
  assert(
    singleResult.reason === 'quit' &&
      !host.isActive() &&
      inputEnabled === false,
    'q closes text pager and restores input ownership',
  )

  const multiPage = host.runTextPager({
    key: 'slash:doctor',
    title: 'Doctor',
    content: ['page one', 'page two', 'page three'].join('\n'),
    pageSize: 1,
  })
  assert(host.render(columns).join('\n').includes('page one'), 'pager starts at page one')
  host.handleInput('\u001b[B')
  assert(host.render(columns).join('\n').includes('page two'), 'down key advances the pager')
  columns = 18
  assert(
    host.render(columns).every((line) => measureTerminalText(line) <= columns),
    'active text pager reflows after resize',
  )
  host.handleInput('\u001b')
  const multiResult = await multiPage
  assert(
    multiResult.reason === 'quit' &&
      hidden.includes(false) &&
      hidden.at(-1) === true,
    'Escape closes a paged overlay through the shared lifecycle',
  )
}

type ControllerSpies = {
  panels: CliCommandPanelInput[]
  pagers: RetainedTextPagerOverlayOptions[]
  compatibility: string[]
  flushes: number
}

function createControllerSpy(spies: ControllerSpies): CliTuiController {
  let nextGeneration = 1
  let panel: CliCommandPanelState | undefined

  const controller = {
    showCommandPanel(input: CliCommandPanelInput): CliCommandPanelState {
      spies.panels.push(input)
      panel = { ...input, generation: nextGeneration++ }
      return panel
    },
    async runTextPagerOverlay(
      input: RetainedTextPagerOverlayOptions,
    ): Promise<RuntimePagerSuccess> {
      spies.pagers.push(input)
      return {
        ok: true,
        reason: 'quit',
        page: 0,
        pageCount: 1,
      }
    },
    writeOutput(text: string): void {
      spies.compatibility.push(text)
    },
    writeError(text: string): void {
      spies.compatibility.push(text)
    },
    getCommandSurfaceState(): CliCommandSurfaceState {
      return {
        ...(panel ? { panel } : {}),
        nextGeneration,
      }
    },
    async flush(): Promise<void> {
      spies.flushes += 1
    },
  }
  return controller as unknown as CliTuiController
}

async function testRunOnePromptConsumption(): Promise<void> {
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    systemPrompt: false,
    contextWindowTokens: 128_000,
  })
  session.model = 'surface-model'
  session.messages.push(
    { role: 'user', content: '保留的会话消息' },
    { role: 'assistant', content: '不会被 slash 临时结果污染。' },
  )
  const beforeMessages = JSON.stringify(session.messages)
  const fallbackWrites: string[] = []
  const spies: ControllerSpies = {
    panels: [],
    pagers: [],
    compatibility: [],
    flushes: 0,
  }
  attachSessionTuiController(session, createControllerSpy(spies))

  for (let index = 0; index < 20; index += 1) {
    const result = await runOnePrompt(session, '/context', {
      isTty: true,
      columns: 80,
      color: false,
      writeOut: (text) => fallbackWrites.push(text),
      writeErr: (text) => fallbackWrites.push(text),
    })
    assert(result.terminalReason === 'slash', 'context remains a slash result')
  }
  const contextPanel = spies.panels.at(-1)
  assert(
    spies.panels.length === 20 &&
      contextPanel?.key === 'slash:context' &&
      contextPanel.ttlMs === 12_000,
    'repeated context calls replace the same timed panel',
  )
  assert(
    contextPanel.content.includes('█') ||
      contextPanel.content.includes('░'),
    'retained context panel keeps the graphical usage bar',
  )
  assert(
    !/[╭│╰]/u.test(contextPanel.content),
    'retained context content does not nest a second frame',
  )

  await runOnePrompt(session, '/context detail', {
    isTty: true,
    columns: 80,
    color: false,
    writeOut: (text) => fallbackWrites.push(text),
    writeErr: (text) => fallbackWrites.push(text),
  })
  assert(
    spies.pagers.at(-1)?.key === 'slash:context:details' &&
      spies.pagers.at(-1)?.content.includes('prepare order:'),
    'context detail routes diagnostics to the text pager',
  )

  await runOnePrompt(session, '/doctor', {
    isTty: true,
    columns: 38,
    color: false,
    writeOut: (text) => fallbackWrites.push(text),
    writeErr: (text) => fallbackWrites.push(text),
  })
  assert(
    spies.pagers.at(-1)?.key === 'slash:doctor',
    'long doctor diagnostics promote to the text pager',
  )

  await runOnePrompt(session, '/cost', {
    isTty: true,
    columns: 80,
    color: false,
    writeOut: (text) => fallbackWrites.push(text),
    writeErr: (text) => fallbackWrites.push(text),
  })
  assert(
    spies.panels.at(-1)?.key === 'slash:cost',
    'compact read-only status routes to the command panel',
  )

  for (const command of ['/help', '/mcp', '/hooks']) {
    await runOnePrompt(session, command, {
      isTty: true,
      columns: 38,
      color: false,
      writeOut: (text) => fallbackWrites.push(text),
      writeErr: (text) => fallbackWrites.push(text),
    })
  }
  assert(
    spies.pagers.some((pager) => pager.key === 'slash:help') &&
      spies.pagers.some((pager) => pager.key === 'slash:mcp') &&
      spies.pagers.some((pager) => pager.key === 'slash:hooks'),
    'help, mcp, and hooks use retained pagers when requested by policy',
  )

  assert(spies.compatibility.length === 0, 'migrated commands never use compatibility output')
  assert(fallbackWrites.length === 0, 'retained commands never use the plain writer')
  assert(
    JSON.stringify(session.messages) === beforeMessages,
    'transient command results do not enter model/session messages',
  )
  assert(spies.flushes >= 25, 'each retained slash result flushes its surface')
}

testProjection()
testTextPagerFormatter()
await testTextPagerOverlayLifecycle()
await testRunOnePromptConsumption()
console.log('PASS: CLI retained slash command surfaces')
