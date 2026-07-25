/**
 * 文件 diff 契约单测 D0–D6（无网络）
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
  previewFileToolChange,
  colorizeUnifiedText,
  formatFileChangeEndLine,
  createDiffSummary,
  formatGitStatusSlash,
  listGitStatus,
} from '../packages/tools/src/index.ts'
import {
  appendFileChange,
  formatDiffSlash,
  recordsFromToolMeta,
  summarizeFileDiffLog,
} from '../packages/core/src/fileDiffLog.ts'
import {
  appendFileDiffEntry,
  fileDiffsFromTranscriptEntries,
  loadTranscriptFile,
} from '../packages/core/src/sessionTranscript.ts'
import { dispatchSlashCommand, type SlashSession } from '../packages/core/src/slash.ts'
import { formatPermissionPrompt } from '../packages/cli/src/tui/askPermissionTty.ts'
import { formatToolEventLine } from '../packages/cli/src/tui/formatSessionEvent.ts'

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

// ANSI + Codex-style summary
const ansi = colorizeUnifiedText(uni)
assert(ansi.includes('\x1b['), 'ansi has escape')
assert(
  formatFileChangeEndLine({ name: 'Edit', path: 'a.ts', added: 1, removed: 1 }).includes(
    '+1',
  ),
  'end line',
)
{
  const block = createDiffSummary(
    [
      { path: 'a.ts', op: 'update', added: 1, removed: 1 },
      { path: 'b.ts', op: 'add', added: 5, removed: 0 },
    ],
    { title: 'Session file changes', color: true },
  )
  assert(block.includes('2 file'), 'summary files')
  assert(block.includes('a.ts') && block.includes('b.ts'), 'summary paths')
  assert(block.includes('\x1b['), 'summary colored')
}

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
  assert(text.includes('2 file') || text.includes('file'), 'slash summary files')
  assert(text.includes('a.ts'), 'lists a.ts')
  assert(text.includes('Tip:'), 'has tip')
  // color or plain both ok
  const last = formatDiffSlash(log, { lastTurn: true })
  assert(last.includes('Turn 2'), 'last turn header')
  assert(last.includes('a.ts'), 'last turn a.ts')
  assert(!last.includes('b.ts') || last.includes('Turn 2'), 'last turn scoped')

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

// CLI formatters
{
  const line = formatToolEventLine({
    type: 'tool_end',
    id: '1',
    name: 'Edit',
    ok: true,
    path: 'z.ts',
    added: 2,
    removed: 1,
  })
  assert(
    line && line.includes('z.ts') && line.includes('+2') && line.includes('-1'),
    `tool end line: ${line}`,
  )
  const prompt = formatPermissionPrompt('Edit', {
    summaryText: 'Edit preview: 1 file(s)  +1/-1\n  M a.ts  +1/-1',
  })
  assert(prompt.includes('Edit preview'), 'perm prompt has preview')
  assert(prompt.includes('[y/a/N]'), 'perm prompt has choices')
}

// ── integration ──
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-diff-'))
  try {
    const f = path.join(tmp, 't.ts')
    await fs.writeFile(f, 'const x = 1\nconst y = 2\n', 'utf8')

    // D3 preview does not write
    const prev = await previewFileToolChange(
      'Edit',
      {
        path: 't.ts',
        old_string: 'const y = 2',
        new_string: 'const y = 9',
      },
      tmp,
    )
    assert(prev, 'preview exists')
    assert(prev!.added >= 1, 'preview added')
    assert(prev!.summaryText.includes('t.ts'), 'preview summary path')
    const still = await fs.readFile(f, 'utf8')
    assert(still.includes('const y = 2'), 'preview did not write')

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
    assert(r.meta?.kind === 'file_edit', 'meta kind')
    assert((r.meta?.structuredPatch?.length ?? 0) >= 1, 'meta patch')
    assert(!r.output.includes('\x1b['), 'model output plain no ansi')

    const write = createWriteTool()
    const w = await write.call(
      { path: 'n.ts', content: 'export const n = 1\n' },
      { cwd: tmp },
    )
    assert(w.ok && w.meta?.kind === 'file_write', 'write meta')

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
    assert((pr.meta?.files?.length ?? 0) >= 2, 'ap meta files')

    // apply_patch preview
    const apPrev = await previewFileToolChange(
      'apply_patch',
      {
        patch: [
          '*** Begin Patch',
          '*** Add File: preview-only.ts',
          '+hello',
          '*** End Patch',
        ].join('\n'),
      },
      tmp,
    )
    assert(apPrev && apPrev.files.some((x) => x.path.includes('preview-only')), 'ap preview')
    try {
      await fs.access(path.join(tmp, 'preview-only.ts'))
      assert(false, 'preview should not create file')
    } catch {
      /* expected */
    }

    const bad = await ap.call({ patch: '' }, { cwd: tmp })
    assert(!bad.ok && !bad.meta, 'fail no meta')

    // D6 transcript file_diff roundtrip
    const jl = path.join(tmp, 'sess.jsonl')
    await fs.writeFile(jl, '', 'utf8')
    await appendFileDiffEntry(jl, {
      sessionId: 's1',
      path: 't.ts',
      tool: 'Edit',
      kind: 'file_edit',
      op: 'update',
      added: 1,
      removed: 1,
      turn: 2,
    })
    const { entries } = await loadTranscriptFile(jl)
    const diffs = fileDiffsFromTranscriptEntries(entries)
    assert(diffs.length === 1 && diffs[0]!.path === 't.ts', 'file_diff load')
    assert(diffs[0]!.turn === 2, 'file_diff turn')

    // /diff slash + git (may be null outside repo — still ok)
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
    assert(d.ok && d.message.includes('file'), `diff msg: ${d.message}`)
    const dLast = await dispatchSlashCommand(session, 'diff', 'last')
    assert(dLast.ok && dLast.message.includes('Turn 2'), 'diff last')
    const dGit = await dispatchSlashCommand(session, 'diff', 'git')
    assert(dGit.ok, `diff git ok: ${dGit.message}`)
    // pure git helper on tmp (likely not a repo)
    const st = await listGitStatus(tmp)
    assert(formatGitStatusSlash(st).length > 0, 'git status format')

    console.log('PASS test-file-diff')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})