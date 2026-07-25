/**
 * U0–U2 Diff ViewModel + pane + permission 契约单测
 * 运行：npx tsx scripts/test-diff-view.ts
 */
import {
  appendFileChange,
  applyDiffViewKey,
  buildDiffViewModelFromLog,
  buildDiffViewModelFromPreview,
  flattenHunkLines,
  formatDiffViewScreen,
  selectedFile,
  type FileChangeRecord,
} from '../packages/core/src/index.ts'
import {
  runDiffPane,
  runDiffApprovePane,
} from '../packages/cli/src/tui/diffPane.ts'
import {
  createTtyAskPermission,
  parsePermissionAnswer,
} from '../packages/cli/src/tui/askPermissionTty.ts'
import { toPermissionPreviewPayload } from '../packages/tools/src/fileChangePreview.ts'

function assert(c: unknown, m: string): asserts c {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  let log: FileChangeRecord[] = []
  log = appendFileChange(log, {
    at: 't1',
    tool: 'Edit',
    path: 'a.ts',
    kind: 'file_edit',
    op: 'update',
    added: 2,
    removed: 1,
    turn: 1,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-old', '+new'],
      },
    ],
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
    added: 1,
    removed: 0,
    turn: 2,
    structuredPatch: [
      {
        oldStart: 3,
        oldLines: 0,
        newStart: 3,
        newLines: 1,
        lines: ['+x'],
      },
    ],
  })

  const vm = buildDiffViewModelFromLog(log)
  assert(vm.files.length === 2, `2 files got ${vm.files.length}`)
  assert(vm.totals.added === 8, `added 8 got ${vm.totals.added}`)
  assert(vm.selectedIndex === 0, 'sel 0')

  const a = vm.files.find((f) => f.path === 'a.ts')
  assert(a && a.hunks.length >= 1, 'a has hunks from last edit')
  assert(a!.turn === 2, 'a last turn 2')

  const lastVm = buildDiffViewModelFromLog(log, { lastTurn: true })
  assert(
    lastVm.files.length === 1 && lastVm.files[0]!.path === 'a.ts',
    'last turn',
  )
  assert(lastVm.title.includes('Turn 2'), 'title turn 2')

  let cur = vm
  let r = applyDiffViewKey(cur, 'j')
  cur = r.vm
  assert(cur.selectedIndex === 1, 'j moves')
  r = applyDiffViewKey(cur, 'enter')
  cur = r.vm
  assert(cur.detailOpen, 'enter opens detail')
  const body = flattenHunkLines(selectedFile(cur)!)
  assert(body.length >= 1, 'flatten')
  r = applyDiffViewKey(cur, 'h')
  cur = r.vm
  assert(!cur.detailOpen, 'h closes detail')
  r = applyDiffViewKey(cur, 'q')
  assert(r.done === 'quit', 'q quits')

  const screen = formatDiffViewScreen(vm, { rows: 20, cols: 60 })
  assert(screen.includes('a.ts') || screen.includes('file'), 'screen')

  const pvm = buildDiffViewModelFromPreview({
    tool: 'Edit',
    files: [
      {
        path: 'c.ts',
        op: 'update',
        added: 1,
        removed: 1,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-a', '+b'],
          },
        ],
      },
    ],
  })
  assert(pvm.files[0]!.source === 'preview', 'preview source')

  {
    const keys = ['j', 'enter', 'q']
    let i = 0
    const out: string[] = []
    const pane = await runDiffPane({
      model: buildDiffViewModelFromLog(log),
      isTty: false,
      readKey: async () => keys[i++] ?? 'q',
      writeOut: (s) => {
        out.push(s)
      },
      rows: 16,
      cols: 60,
    })
    assert(pane.ok && pane.reason === 'quit', 'pane quit')
    assert(out.length >= 1, 'pane painted')
  }

  {
    const pane = await runDiffPane({
      model: buildDiffViewModelFromLog([]),
      isTty: true,
      readKey: async () => 'q',
    })
    assert(!pane.ok && pane.reason === 'empty', 'empty pane')
  }

  // U2 approve keys
  {
    let avm = buildDiffViewModelFromPreview({
      tool: 'Edit',
      files: [
        {
          path: 'p.ts',
          op: 'update',
          added: 1,
          removed: 1,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-x', '+y'],
            },
          ],
        },
      ],
    })
    let ar = applyDiffViewKey(avm, 'j', { mode: 'approve' })
    avm = ar.vm
    ar = applyDiffViewKey(avm, 'y', { mode: 'approve' })
    assert(ar.done === 'allow', 'y allows')
    ar = applyDiffViewKey(avm, 'a', { mode: 'approve' })
    assert(ar.done === 'allow_always', 'a always')
    ar = applyDiffViewKey(avm, 'n', { mode: 'approve' })
    assert(ar.done === 'deny', 'n deny')
    ar = applyDiffViewKey(avm, 'q', { mode: 'approve' })
    assert(ar.done === 'deny', 'q deny in approve')

    const scr = formatDiffViewScreen(avm, {
      mode: 'approve',
      toolName: 'Edit',
      rows: 16,
    })
    assert(scr.includes('y allow') || scr.includes('[y/a/N]'), 'approve help')
  }

  {
    const keys = ['enter', 'y']
    let i = 0
    const pane = await runDiffApprovePane({
      model: pvm,
      toolName: 'Edit',
      isTty: false,
      readKey: async () => keys[i++] ?? 'n',
      writeOut: () => {},
      rows: 16,
      cols: 60,
    })
    assert(pane.ok && pane.decision === 'allow', 'approve pane allow')
  }

  {
    const payload = toPermissionPreviewPayload({
      tool: 'Write',
      files: [{ path: 'n.ts', op: 'add', added: 2, removed: 0 }],
      added: 2,
      removed: 0,
      paths: ['n.ts'],
      summaryText: 'Write preview',
    })
    assert(payload?.files?.length === 1, 'payload files')
  }

  {
    const keys = ['y']
    let i = 0
    const ask = createTtyAskPermission({
      isTty: true,
      useDiffPanel: true,
      readKey: async () => keys[i++] ?? 'n',
      writeOut: () => {},
      readAnswer: async () => 'n',
    })
    const d = await ask({
      toolName: 'Edit',
      toolInput: {},
      toolUseId: '1',
      preview: {
        tool: 'Edit',
        added: 1,
        removed: 1,
        paths: ['c.ts'],
        summaryText: 'x',
        files: pvm.files.map((f) => ({
          path: f.path,
          op: f.op,
          added: f.added,
          removed: f.removed,
          structuredPatch: f.hunks,
        })),
      },
    })
    assert(d === 'allow', `ask panel allow got ${d}`)
    assert(parsePermissionAnswer('a') === 'allow_always', 'parse a')
  }

  // U3 history cell
  {
    const {
      formatFileChangeHistoryCell,
      fileChangeCellFromMeta,
      shouldExpandFileChangeCell,
    } = await import('../packages/core/src/fileChangeCell.ts')
    const cellIn = fileChangeCellFromMeta({
      toolName: 'Edit',
      ok: true,
      meta: {
        kind: 'file_edit',
        path: 'z.ts',
        added: 2,
        removed: 1,
        unified: '--- a/z.ts\n+++ b/z.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n',
        files: [{ path: 'z.ts', op: 'update', added: 2, removed: 1 }],
      },
    })
    assert(cellIn, 'cell from meta')
    const folded = formatFileChangeHistoryCell(cellIn!, { expanded: false })
    assert(folded.includes('Edit') && folded.includes('▸'), 'folded hint')
    const open = formatFileChangeHistoryCell(cellIn!, {
      expanded: true,
      maxUnifiedLines: 20,
    })
    assert(open.includes('@@') || open.includes('+b'), 'expanded body')
    assert(typeof shouldExpandFileChangeCell() === 'boolean', 'env expand')
  }

  // U3 CLI formatter prefers cellCollapsed
  {
    const { formatToolEventLine } = await import(
      '../packages/cli/src/tui/formatSessionEvent.ts'
    )
    const prev = process.env.BOLO_DIFF_CELL
    delete process.env.BOLO_DIFF_CELL
    delete process.env.BOLO_DIFF_VERBOSE
    const line = formatToolEventLine({
      type: 'tool_end',
      id: '1',
      name: 'Edit',
      ok: true,
      cellCollapsed: '✓ Edit  a.ts  (+1/-1)\n  ▸ folded',
      cellExpanded: '✓ Edit  a.ts\n@@ full',
      summaryLine: '✓ Edit  a.ts\nmore',
    })
    assert(line && line.includes('folded'), `prefer collapsed: ${line}`)
    process.env.BOLO_DIFF_CELL = 'expand'
    const line2 = formatToolEventLine({
      type: 'tool_end',
      id: '1',
      name: 'Edit',
      ok: true,
      cellCollapsed: 'folded',
      cellExpanded: '✓ expanded body',
    })
    assert(line2 && line2.includes('expanded'), `prefer expanded: ${line2}`)
    if (prev === undefined) delete process.env.BOLO_DIFF_CELL
    else process.env.BOLO_DIFF_CELL = prev
  }

  console.log('PASS test-diff-view')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})