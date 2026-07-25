/**
 * 文件 diff 契约单测（无网络）
 * 运行：npx tsx scripts/test-file-diff.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  countHunkLines,
  createEditTool,
  createWriteTool,
  diffHunksFromEdit,
  diffHunksFromFullReplace,
  formatUnifiedDiff,
} from '../packages/tools/src/index.ts'

function assert(c: unknown, m: string): asserts c {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// ── pure unit ──
const before = 'line1\nfoo\nline3\n'
const hunks = diffHunksFromEdit(before, 'foo', 'bar', false)
assert(hunks.length === 1, 'one hunk')
const c = countHunkLines(hunks)
assert(c.added === 1 && c.removed === 1, `+1/-1 got +${c.added}/-${c.removed}`)
const uni = formatUnifiedDiff('x.ts', hunks)
assert(uni.includes('--- a/x.ts'), 'unified header')
assert(uni.includes('@@'), 'unified hunk header')
assert(uni.includes('-foo') && uni.includes('+bar'), 'unified body')

const multi = diffHunksFromEdit('a a a', 'a', 'b', true)
assert(multi.length === 3, 'replace_all three hunks')
assert(countHunkLines(multi).added === 3, 'three adds')

const created = diffHunksFromFullReplace('', 'hello\nworld\n')
assert(countHunkLines(created).added >= 2, 'new file adds')

// ── Edit tool integration ──
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-diff-'))
  try {
    const f = path.join(tmp, 't.ts')
    await fs.writeFile(f, 'const x = 1\nconst y = 2\n', 'utf8')
    const edit = createEditTool()
    const r = await edit.call(
      {
        path: 't.ts',
        old_string: 'const y = 2',
        new_string: 'const y = 3',
      },
      { cwd: tmp },
    )
    assert(r.ok, `edit ok: ${r.output}`)
    assert(r.output.includes('+1') || r.output.includes('+'), 'output has +')
    assert(r.output.includes('@@') || r.meta?.unified, 'has unified or meta')
    assert(r.meta?.kind === 'file_edit', 'meta kind')
    assert(r.meta?.path === 't.ts', 'meta path')
    assert((r.meta?.added ?? 0) >= 1, 'meta added')
    assert((r.meta?.structuredPatch?.length ?? 0) >= 1, 'meta patch')

    const write = createWriteTool()
    const w = await write.call(
      { path: 'n.ts', content: 'export const n = 1\n' },
      { cwd: tmp },
    )
    assert(w.ok, `write ok: ${w.output}`)
    assert(w.meta?.kind === 'file_write', 'write meta')
    assert((w.meta?.added ?? 0) >= 1, 'write added')
    assert(w.output.includes('new file') || w.output.includes('+'), 'write output')

    console.log('PASS test-file-diff')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})