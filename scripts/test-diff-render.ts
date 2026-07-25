/**
 * U4 diffRender 契约单测
 * 运行：npx tsx scripts/test-diff-render.ts
 */
import {
  expandHunksToBodyLines,
  highlightCodeLine,
  lineNumberWidth,
  renderHunksRich,
  resolveDiffRenderTheme,
  shouldShowLineGutter,
  shouldSyntaxHighlight,
  colorizeUnifiedText,
  formatAnsiUnifiedFromHunks,
} from '../packages/tools/src/index.ts'
import { flattenHunkLines } from '../packages/core/src/diffViewModel.ts'
import { formatFileChangeHistoryCell } from '../packages/core/src/fileChangeCell.ts'

function assert(c: unknown, m: string): asserts c {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const theme = resolveDiffRenderTheme({
  theme: 'default',
  env: {},
  color: true,
})
assert(theme.id === 'default' && theme.add.includes('32'), 'default theme')
assert(
  resolveDiffRenderTheme({ color: false, env: {} }).id === 'plain',
  'plain theme',
)
assert(lineNumberWidth(99) === 2, 'width 99')
assert(lineNumberWidth(100) === 3, 'width 100')

const hunks = [
  {
    oldStart: 10,
    oldLines: 2,
    newStart: 10,
    newLines: 2,
    lines: [' const a = 1', '-const b = 2', '+const b = 3', ' // done'],
  },
]
const body = expandHunksToBodyLines('src/x.ts', hunks)
assert(body.some((l) => l.kind === 'header'), 'headers')
assert(body.some((l) => l.kind === 'add' && l.newNo === 11), 'add line no')
assert(body.some((l) => l.kind === 'del' && l.oldNo === 11), 'del line no')

const rich = renderHunksRich('src/x.ts', hunks, {
  theme: 'default',
  env: {},
  color: true,
})
assert(rich.includes('10'), `gutter line no in: ${rich.slice(0, 200)}`)
assert(rich.includes('+') && rich.includes('-'), 'signs')
assert(rich.includes('\x1b['), 'ansi')

const plain = renderHunksRich('src/x.ts', hunks, {
  color: false,
  gutter: true,
  env: {},
})
assert(plain.includes('10'), 'plain gutter')
assert(!plain.includes('\x1b['), 'no ansi plain')

const hi = highlightCodeLine(
  'const foo = "bar"',
  'a.ts',
  resolveDiffRenderTheme({ theme: 'default', env: {}, color: true }),
)
assert(hi.includes('\x1b['), 'syntax ansi')
assert(hi.includes('const') || hi.includes('foo'), 'keeps text')

// env defaults
{
  assert(
    shouldShowLineGutter({ env: {} }) === true,
    'gutter default on',
  )
  assert(
    shouldSyntaxHighlight({
      env: {},
      theme: resolveDiffRenderTheme({ theme: 'default', env: {}, color: true }),
    }) === true,
    'syntax default on',
  )
  assert(
    shouldShowLineGutter({ env: { BOLO_DIFF_GUTTER: '0' } }) === false,
    'gutter off',
  )
  assert(
    shouldSyntaxHighlight({ env: { BOLO_DIFF_SYNTAX: '0' } }) === false,
    'syntax off',
  )
}

// ansiDiff wrappers
const uni = formatAnsiUnifiedFromHunks('a.ts', hunks)
assert(uni.includes('10') || uni.includes('@@'), 'formatAnsi hunks')
const c = colorizeUnifiedText('--- a\n+++ b\n@@\n-x\n+y\n', {
  filePath: 'a.ts',
})
// may be plain if NO_COLOR in process env — still must preserve content
assert(c.includes('x') || c.includes('y') || c.includes('+'), 'colorize content')

// pane flatten uses rich
const flat = flattenHunkLines({
  path: 'src/x.ts',
  added: 1,
  removed: 1,
  edits: 1,
  source: 'session',
  hunks,
})
assert(flat.some((L) => L.includes('10') || L.includes('const')), 'flatten rich')

// cell expanded uses rich when hunks present
const cell = formatFileChangeHistoryCell(
  {
    toolName: 'Edit',
    path: 'src/x.ts',
    pathForRender: 'src/x.ts',
    added: 1,
    removed: 1,
    hunks,
  },
  { expanded: true, maxUnifiedLines: 40 },
)
assert(cell.includes('Edit'), 'cell header')
assert(cell.includes('10') || cell.includes('const'), 'cell rich body')

console.log('PASS test-diff-render')