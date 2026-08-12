/**
 * Retained TUI theme updates must repaint every visible surface without
 * rebuilding editor or transcript state. Compact terminals also keep the
 * welcome identity from consuming the working viewport.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { createRetainedTuiController } from '../packages/cli/src/tui/retainedTui.ts'
import { renderInkLayout } from '../packages/cli/src/tui/inkLayout.ts'
import {
  buildPaletteAnsi,
  getTuiPalette,
} from '../packages/cli/src/tui/theme.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'

class TerminalOutput extends EventEmitter {
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
}

function findLine(lines: string[], marker: string): string {
  const line = lines.find((candidate) => candidate.includes(marker))
  assert.ok(line, `expected rendered line containing ${JSON.stringify(marker)}`)
  return line
}

function assertSurfaceColor(
  lines: string[],
  marker: string,
  ansi: string,
  label: string,
): void {
  assert.ok(
    findLine(lines, marker).includes(ansi),
    `${label} consumes the active semantic palette`,
  )
}

async function main(): Promise<void> {
  const env = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  } as NodeJS.ProcessEnv
  const output = new TerminalOutput(80, 24)
  const controller = createRetainedTuiController({
    writeOut: () => {},
    output,
    env,
    color: true,
    theme: 'default',
  })
  controller.configureWelcome({
    version: '9.8.7',
    headline: 'Ready to build',
    cwd: 'E:\\DEV\\HelsincyAgent',
    model: 'openai/gpt-test',
    sessionId: 'sess_theme_runtime',
    session: {
      permissionMode: 'default',
      model: 'gpt-test',
      effortLevel: 'high',
      messages: [],
      providerId: 'openai',
    },
    hint: '/help · /provider',
  })
  controller.configureComposer({
    status: {
      permissionMode: 'default',
      model: 'gpt-test',
      effortLevel: 'high',
    },
  })
  controller.printer.beginTurn({
    prompt: 'theme the whole surface',
    echoUser: true,
    activity: false,
  })
  controller.printer.onEvent({
    type: 'text',
    text: 'semantic transcript marker',
  })
  controller.printer.endTurn({ terminalReason: 'completed' })
  controller.showCommandToast({
    key: 'theme:error',
    content: 'semantic error marker',
    tone: 'error',
    ttlMs: 60_000,
  })

  const aurora = buildPaletteAnsi(getTuiPalette('default'), true, true)
  const amber = buildPaletteAnsi(getTuiPalette('amber'), true, true)
  const render = () => controller.root.render(80)

  let lines = render()
  assertSurfaceColor(lines, 'BOLO CODE', aurora.accent, 'welcome')
  assertSurfaceColor(lines, '● Bolo', aurora.accent, 'transcript')
  assertSurfaceColor(lines, 'Enter', aurora.chipBg, 'composer footer')
  assertSurfaceColor(lines, 'semantic error marker', aurora.error, 'toast')

  controller.previewTheme('amber')
  lines = render()
  assertSurfaceColor(lines, 'BOLO CODE', amber.accent, 'amber welcome')
  assertSurfaceColor(lines, '● Bolo', amber.accent, 'amber transcript')
  assertSurfaceColor(lines, 'Enter', amber.chipBg, 'amber composer footer')
  assertSurfaceColor(lines, 'semantic error marker', amber.error, 'amber toast')
  assert.ok(
    !lines.join('\n').includes(aurora.accent),
    'preview does not retain the previous theme in cached components',
  )

  controller.resetThemePreview()
  lines = render()
  assertSurfaceColor(lines, 'BOLO CODE', aurora.accent, 'reset welcome')
  assertSurfaceColor(lines, '● Bolo', aurora.accent, 'reset transcript')
  assertSurfaceColor(lines, 'Enter', aurora.chipBg, 'reset composer footer')

  controller.previewTheme('plain')
  const plainAnsiLines = render().filter((line) => line.includes('\u001b['))
  assert.deepEqual(
    plainAnsiLines,
    [],
    `plain preview emits no ANSI bytes across the retained root: ${JSON.stringify(
      plainAnsiLines,
    )}`,
  )

  for (const rows of [24, 30]) {
    const welcome = renderInkLayout({
      columns: 80,
      viewportRows: rows,
      version: '9.8.7',
      headline: 'Ready to build',
      cwd: 'E:\\DEV\\a-very-long-workspace-name',
      model: 'openai/gpt-test',
      sessionId: 'sess_compact_should_not_render',
      session: {
        permissionMode: 'default',
        model: 'gpt-test',
        effortLevel: 'high',
        messages: [],
        providerId: 'openai',
      },
      env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
    })
    const compactLines = welcome.split('\n')
    assert.ok(
      compactLines.length <= 6,
      `80x${rows} welcome stays within 6 lines, got ${compactLines.length}`,
    )
    assert.ok(
      !welcome.includes('sess_compact_should_not_render'),
      `80x${rows} compact welcome omits duplicate session metadata`,
    )
    assert.ok(
      compactLines.every((line) => measureTerminalText(line) <= 80),
      `80x${rows} compact welcome respects terminal width`,
    )
  }

  await controller.stop()

  const initiallyPlain = createRetainedTuiController({
    writeOut: () => {},
    output: new TerminalOutput(80, 24),
    env,
    color: true,
    theme: 'plain',
  })
  initiallyPlain.configureWelcome({ headline: 'Plain startup preview' })
  initiallyPlain.previewTheme('amber')
  assert.ok(
    initiallyPlain.root.render(80).join('\n').includes(amber.accent),
    'color preview re-resolves truecolor after a plain startup theme',
  )
  await initiallyPlain.stop()
  console.log('PASS: retained TUI runtime theme + compact welcome')
}

await main()
