/**
 * OI-11G: Bolo owns a crystal welcome identity across terminal widths.
 */
import { promises as fs } from 'node:fs'
import {
  BOLO_CRYSTAL_UNICODE_LINES,
  measureTerminalText,
  normalizeTuiArt,
  renderInkLayout,
  renderWelcomeBanner,
  resolveTuiFrameWidth,
} from '../packages/cli/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function assertFrame(name: string, output: string, columns: number): void {
  const expected = resolveTuiFrameWidth(columns)
  const widths = output.split('\n').map(measureTerminalText)
  assert(
    widths.every((width) => width === expected),
    `${name} stays at ${expected} cells, got ${widths.join(',')}`,
  )
}

async function main(): Promise<void> {
  const source = await fs.readFile(
    new URL('../bolo-logo-tui.txt', import.meta.url),
    'utf8',
  )
  assert(
    JSON.stringify(normalizeTuiArt(source)) ===
      JSON.stringify(BOLO_CRYSTAL_UNICODE_LINES),
    'embedded Unicode mark matches the normalized source asset',
  )

  const wide = renderInkLayout({
    columns: 120,
    version: '9.8.7',
    cwd: 'E:\\DEV\\HelsincyAgent',
    model: 'work/gpt-test',
    sessionId: 'sess_crystal',
    session: {
      permissionMode: 'default',
      model: 'gpt-test',
      effortLevel: 'high',
      messages: [],
      providerId: 'work',
    },
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  assert(wide.includes('──◆──'), 'wide welcome renders the source crystal')
  assert(wide.includes('BOLO CODE'), 'wide welcome keeps the product identity')
  assert(wide.includes('WORKSPACE'), 'wide welcome exposes workspace metadata')
  assert(wide.includes('MODEL'), 'wide welcome exposes model metadata')
  assert(wide.includes('SESSION'), 'wide welcome exposes session metadata')
  assert(!wide.includes('Bolot'), 'legacy pixel mascot identity is removed')
  assert(!wide.includes('Start here'), 'legacy Claude-like action card is removed')
  assert(
    !wide.split('\n').some((line) => line.split('│').length >= 4),
    'wide welcome is not a Claude-like two-column card',
  )
  assertFrame('wide welcome', wide, 120)

  const medium = renderInkLayout({
    columns: 76,
    cwd: 'E:\\DEV\\中文项目',
    model: 'work/gpt-test',
    sessionId: 'sess_medium',
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  assert(medium.includes('──◆──'), 'medium welcome keeps the Unicode crystal')
  assert(
    !/\u001b\[[0-9;]*m/u.test(medium),
    'NO_COLOR keeps structure without SGR styling',
  )
  assertFrame('medium welcome', medium, 76)

  const compact = renderInkLayout({
    columns: 46,
    cwd: 'E:\\DEV\\a-very-long-workspace-name',
    model: 'work/a-very-long-model-name',
    sessionId: 'sess_compact',
    env: {} as NodeJS.ProcessEnv,
  })
  assert(compact.includes('╔██╗'), 'compact welcome uses the small crystal mark')
  assertFrame('compact welcome', compact, 46)

  const ascii = renderInkLayout({
    columns: 76,
    cwd: 'C:\\workspace',
    model: 'provider/model',
    env: {
      BOLO_ASCII: '1',
      NO_COLOR: '1',
    } as NodeJS.ProcessEnv,
  })
  assert(/^[\x00-\x7f]*$/u.test(ascii), 'ASCII mode emits only ASCII')
  assert(ascii.includes('/\\'), 'ASCII mode still has a crystal silhouette')
  assertFrame('ASCII welcome', ascii, 76)
  const asciiFallback = renderWelcomeBanner({
    ascii: true,
    plain: false,
    cwd: 'C:\\workspace',
    model: 'provider/model',
    env: { NO_COLOR: '' } as NodeJS.ProcessEnv,
  })
  assert(
    /^[\x00-\x7f]*$/u.test(asciiFallback),
    'fallback banner also honors ASCII-only mode',
  )

  const noMascot = renderInkLayout({
    columns: 76,
    cwd: 'C:\\workspace',
    model: 'provider/model',
    mascot: false,
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  assert(!noMascot.includes('──◆──'), 'mascot switch still hides the mark')
  assert(noMascot.includes('BOLO CODE'), 'mascot-off keeps the brand')
  assertFrame('mascot-off welcome', noMascot, 76)

  console.log('PASS: CLI crystal identity')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
