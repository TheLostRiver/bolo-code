/**
 * OI-12B: responsive /context dashboard and CLI routing.
 */
import {
  createSession,
  dispatchSlashCommand,
} from '../packages/core/src/index.ts'
import {
  measureTerminalText,
  resolveTuiContentGutter,
  renderContextDashboard,
  resolveTuiFrameWidth,
  runOnePrompt,
} from '../packages/cli/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

const provider: LlmProvider = {
  id: 'context-dashboard-test',
  async *completeStream() {
    throw new Error('context slash must not call the provider')
  },
  async completeText() {
    throw new Error('context slash must not call the provider')
  },
}

async function main(): Promise<void> {
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    systemPrompt: false,
    contextWindowTokens: 128_000,
  })
  session.model = 'gpt-context-test'
  session.systemPromptSections = [
    '# Identity\nStable instructions',
    '# Available Skills\nCatalog',
  ]
  session.messages.push(
    { role: 'user', content: '请检查上下文使用情况' },
    { role: 'assistant', content: '正在检查。' },
  )

  const dispatched = await dispatchSlashCommand(session, 'context', '')
  const view = dispatched.contextView
  assert(view, 'context dispatch exposes a view model')

  for (const columns of [24, 38, 80, 160]) {
    const rendered = renderContextDashboard({
      view,
      columns,
      color: false,
    })
    assert(
      rendered.lines.every(
        (line) => measureTerminalText(line) <= resolveTuiFrameWidth(columns),
      ),
      `dashboard fits ${columns} columns: ${rendered.lines
        .map(measureTerminalText)
        .join(',')}`,
    )
    assert(rendered.text.includes('Context'), `${columns} columns keep title`)
    assert(
      rendered.text.includes('█') || rendered.text.includes('░'),
      `${columns} columns keep a graphical usage bar`,
    )
    assert(
      rendered.text.includes('estimated'),
      `${columns} columns keep the usage source visible`,
    )
  }

  const overview = renderContextDashboard({
    view,
    columns: 80,
    color: false,
  }).text
  assert(overview.includes('Messages'), 'overview shows message tokens')
  assert(overview.includes('System'), 'overview shows system tokens')
  assert(overview.includes('Free'), 'overview shows free tokens')
  assert(overview.includes('estimated'), 'overview labels estimated usage')
  assert(
    overview.includes('/context details'),
    'overview points to the diagnostic view',
  )

  for (const source of ['actual', 'estimated', 'hybrid'] as const) {
    const rendered = renderContextDashboard({
      view: {
        ...view,
        usage: { ...view.usage, source },
      },
      columns: 80,
      color: false,
    })
    assert(
      rendered.text.includes(source),
      `dashboard distinguishes ${source} usage`,
    )
  }

  const noColor = renderContextDashboard({
    view,
    columns: 80,
    color: false,
  }).text
  assert(!/\u001b\[[0-9;]*m/u.test(noColor), 'NO_COLOR emits no SGR styles')
  const colored = renderContextDashboard({
    view,
    columns: 38,
    color: true,
  })
  assert(/\u001b\[[0-9;]*m/u.test(colored.text), 'color mode emits SGR styles')
  assert(
    colored.lines.every(
      (line) => measureTerminalText(line) <= resolveTuiFrameWidth(38),
    ),
    'ANSI styles do not change dashboard width',
  )

  const ttyOut: string[] = []
  const tty = await runOnePrompt(session, '/context', {
    isTty: true,
    columns: 80,
    color: false,
    writeOut: (text) => ttyOut.push(text),
    writeErr: (text) => ttyOut.push(text),
  })
  const ttyText = ttyOut.join('')
  assert(tty.terminalReason === 'slash', 'TTY context remains a slash result')
  assert(ttyText.includes('█') || ttyText.includes('░'), 'TTY uses dashboard')
  assert(!ttyText.includes('prepare order:'), 'TTY hides diagnostics by default')
  const ttyGutter = ' '.repeat(resolveTuiContentGutter(80))
  assert(
    ttyText
      .split('\n')
      .filter((line) => /[╭│╰]/u.test(line))
      .every((line) => line.startsWith(ttyGutter)),
    'TTY dashboard uses the shared content gutter',
  )

  const plainOut: string[] = []
  await runOnePrompt(session, '/context', {
    isTty: false,
    writeOut: (text) => plainOut.push(text),
    writeErr: (text) => plainOut.push(text),
  })
  const plainText = plainOut.join('')
  assert(plainText.includes('Context usage:'), 'non-TTY uses compact plain text')
  assert(!plainText.includes('╭'), 'non-TTY does not emit a frame')
  assert(
    plainText.startsWith('Context usage:'),
    'non-TTY plain text is not padded with TTY layout',
  )

  const detailsOut: string[] = []
  await runOnePrompt(session, '/context details', {
    isTty: true,
    columns: 80,
    color: false,
    writeOut: (text) => detailsOut.push(text),
    writeErr: (text) => detailsOut.push(text),
  })
  const detailsText = detailsOut.join('')
  assert(detailsText.includes('prepare order:'), 'details keeps diagnostics')
  assert(!detailsText.includes('╭─ Context'), 'details bypasses dashboard')
  assert(
    detailsText
      .split('\n')
      .filter(Boolean)
      .every((line) => line.startsWith(ttyGutter)),
    'TTY slash diagnostics use the shared content gutter',
  )

  console.log('PASS: context dashboard')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
