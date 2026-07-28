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
  resolveTuiWelcomeWidth,
} from '../packages/cli/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function assertFrame(name: string, output: string, columns: number): void {
  const expected = resolveTuiWelcomeWidth(columns)
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
  const wideLines = wide.split('\n')
  assert(
    wideLines[0]?.startsWith('╭') &&
      wideLines[0]?.includes('BOLO CODE') &&
      wideLines[0]?.includes('v9.8.7'),
    'wide welcome embeds Bolo identity and version in its top border',
  )
  assert(
    wideLines.some((line) => line.split('│').length >= 4),
    'wide welcome composes the crystal and runtime status as a split workbench',
  )
  assert(
    wideLines.at(-1)?.startsWith('╰'),
    'wide welcome closes the workbench with a bottom border',
  )
  assertFrame('wide welcome', wide, 120)

  const medium = renderInkLayout({
    columns: 76,
    cwd: 'E:\\DEV\\中文🚀项目',
    model: 'work/gpt-test',
    sessionId: 'sess_medium',
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  assert(medium.includes('──◆──'), 'medium welcome keeps the Unicode crystal')
  assert(
    !/\u001b\[[0-9;]*m/u.test(medium),
    'NO_COLOR keeps structure without SGR styling',
  )
  assert(
    medium.split('\n')[0]?.startsWith('╭'),
    'medium welcome keeps the framed workbench identity',
  )
  assert(
    !medium.split('\n').some((line) => line.split('│').length >= 4),
    'medium welcome falls back to one responsive column',
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
  assert(
    compact.split('\n')[0]?.includes('╭') &&
      !compact.split('\n').some((line) => line.split('│').length >= 4),
    'compact welcome keeps a framed single-column layout',
  )
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
  assert(
    ascii.split('\n')[0]?.startsWith('+') &&
      ascii.split('\n')[0]?.includes('BOLO CODE'),
    'ASCII mode uses an ASCII-only titled workbench border',
  )
  assertFrame('ASCII welcome', ascii, 76)
  const asciiWide = renderInkLayout({
    columns: 120,
    cwd: 'C:\\workspace',
    model: 'provider/model',
    sessionId: 'sess_ascii',
    session: {
      permissionMode: 'default',
      model: 'model',
      effortLevel: 'high',
      messages: [],
      providerId: 'provider',
    },
    env: {
      BOLO_ASCII: '1',
      NO_COLOR: '1',
    } as NodeJS.ProcessEnv,
  })
  assert(
    /^[\x00-\x7f]*$/u.test(asciiWide),
    'wide ASCII workbench keeps borders, state, and separators ASCII-only',
  )
  assert(
    asciiWide.split('\n').some((line) => line.split('|').length >= 4),
    'wide ASCII workbench keeps the split runtime layout',
  )
  assertFrame('wide ASCII welcome', asciiWide, 120)
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
    columns: 120,
    cwd: 'C:\\workspace',
    model: 'provider/model',
    mascot: false,
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  assert(!noMascot.includes('──◆──'), 'mascot switch still hides the mark')
  assert(noMascot.includes('BOLO CODE'), 'mascot-off keeps the brand')
  assert(
    !noMascot.split('\n').some((line) => line.split('│').length >= 4),
    'mascot-off avoids leaving an empty split column',
  )
  assertFrame('mascot-off welcome', noMascot, 120)

  for (const { columns, split } of [
    { columns: 38, split: false },
    { columns: 56, split: false },
    { columns: 96, split: true },
    { columns: 160, split: true },
    { columns: 220, split: true },
  ]) {
    const boundary = renderInkLayout({
      columns,
      cwd: 'E:\\DEV\\boundary',
      model: 'provider/model',
      sessionId: 'sess_boundary',
      env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
    })
    const hasSplit = boundary
      .split('\n')
      .some((line) => line.split('│').length >= 4)
    assert(
      hasSplit === split,
      `${columns}-column welcome chooses the expected responsive structure`,
    )
    assertFrame(`${columns}-column welcome`, boundary, columns)
  }

  const narrow = renderInkLayout({
    columns: 30,
    cwd: 'E:\\DEV\\中文🚀项目',
    model: 'provider/model',
    sessionId: 'sess_narrow',
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  assert(narrow.startsWith('BOLO v'), 'narrow welcome keeps the plain identity')
  assert(
    !/[╭╮╰╯│]/u.test(narrow),
    'narrow welcome does not render a frame it cannot fit',
  )
  assert(
    narrow.split('\n').every((line) => measureTerminalText(line) <= 30),
    'narrow plain welcome clips CJK and emoji safely',
  )

  console.log('PASS: CLI crystal identity')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
