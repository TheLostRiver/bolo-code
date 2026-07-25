/**
 * 文件 diff 契约单测（无网络）
 * 运行：npx tsx scripts/test-file-diff.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  countHunkLines,
  createApplyPatchTool,
  createEditTool,
  createWriteTool,
  diffHunksFromEdit,
  diffHunksFromFullReplace,
  formatUnifiedDiff,
} from '../packages/tools/src/index.ts'
import {
  appendFileChange,
  formatDiffSlash,
  recordsFromToolMeta,
  summarizeFileDiffLog,
} from '../packages/core/src/fileDiffLog.ts'
import { dispatchSlashCommand, type SlashSession } from '../packages/core/src/slash.ts'

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

// fileDiffLog pure
{
  let log = appendFileChange(undefined, {
    at: 't1',
    tool: 'Edit',
    path: 'a.ts',
    kind: 'file_edit',
    op: 'update',
    added: 1,
    removed: 1,
    turn: 1,
  })
  log = appendFileChange(log, {
    at: 't2',
    tool: 'Write',
    path: 'b.ts',
    kind: 'file_write',
    op: 'add',
    added: 5,
    removed: 0,
    turn: 1,
  })
  log = appendFileChange(log, {
    at: 't3',
    tool: 'Edit',
    path: 'a.ts',
    kind: 'file_edit',
    added: 2,
    removed: 0,
    turn: 2,
  })
  const sum = summarizeFileDiffLog(log)
  assert(sum.filesChanged === 2, 'two files')
  assert(sum.linesAdded === 8, `added 8 got ${sum.linesAdded}`)
  const text = formatDiffSlash(log)
  assert(text.includes('2 file'), 'slash summary files')
  assert(text.includes('a.ts'), 'lists a.ts')
  const last = formatDiffSlash(log, { lastTurn: true })
  assert(last.includes('Turn 2'), 'last turn header')
  assert(last.includes('a.ts'), 'last turn a.ts')
  assert(!last.includes('b.ts'), 'last turn no b')

  const fromMeta = recordsFromToolMeta({
    toolName: 'apply_patch',
    meta: {
      kind: 'apply_patch',
      files: [
        { path: 'c.ts', op: 'add', added: 3, removed: 0 },
        { path: 'd.ts', op: 'update', added: 1, removed: 1 },
      ],
    },
    turn: 3,
  })
  assert(fromMeta.length === 2, 'meta expands files')
}

// ── Edit / Write / apply_patch integration ──
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

    // apply_patch Add + Update
    const ap = createApplyPatchTool()
    const patch = [
      '*** Begin Patch',
      '*** Add File: newp.ts',
      '+export const z = 1',
      '*** Update File: t.ts',
      '@@',
      '-const y = 3',
      '+const y = 4',
      '*** End Patch',
    ].join('\n')
    const pr = await ap.call({ patch }, { cwd: tmp })
    assert(pr.ok, `apply_patch ok: ${pr.output}`)
    assert(pr.meta?.kind === 'apply_patch', 'ap meta kind')
    assert((pr.meta?.added ?? 0) >= 1, 'ap meta added')
    assert((pr.meta?.files?.length ?? 0) >= 2, 'ap meta files')
    assert(pr.output.includes('apply_patch:') || pr.output.includes('+'), 'ap output summary')
    const body = await fs.readFile(path.join(tmp, 't.ts'), 'utf8')
    assert(body.includes('const y = 4'), 'patch applied update')
    assert(
      await fs
        .readFile(path.join(tmp, 'newp.ts'), 'utf8')
        .then((s) => s.includes('z = 1')),
      'patch applied add',
    )

    // failure: no meta
    const bad = await ap.call({ patch: '' }, { cwd: tmp })
    assert(!bad.ok, 'empty patch fails')
    assert(!bad.meta, 'fail no meta')

    // /diff slash
    const session = {
      id: 's',
      cwd: tmp,
      messages: [],
      systemPromptSections: [],
      permissionMode: 'default' as const,
      fileDiffLog: recordsFromToolMeta({
        toolName: 'Edit',
        meta: r.meta!,
        turn: 1,
      }),
    } as SlashSession
    session.fileDiffLog = appendFileChange(
      session.fileDiffLog,
      recordsFromToolMeta({ toolName: 'Write', meta: w.meta!, turn: 1 })[0]!,
    )
    for (const rec of recordsFromToolMeta({
      toolName: 'apply_patch',
      meta: pr.meta!,
      turn: 2,
    })) {
      session.fileDiffLog = appendFileChange(session.fileDiffLog, rec)
    }
    const d = await dispatchSlashCommand(session, 'diff', '')
    assert(d.ok, 'diff slash ok')
    assert(d.message.includes('file'), `diff msg: ${d.message}`)
    const dLast = await dispatchSlashCommand(session, 'diff', 'last')
    assert(dLast.ok && dLast.message.includes('Turn 2'), 'diff last')

    console.log('PASS test-file-diff')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})