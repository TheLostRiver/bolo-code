/**
 * Diff 交互 ViewModel — U0
 * 对照 HC useTurnDiffs / DiffDialog 数据面；Codex create_diff_summary 列表面。
 * 纯函数：只消费 fileDiffLog / preview，不读盘、不调 git。
 */

import type {
  FileChangeOp,
  FileChangeRecord,
  FileDiffHunk,
} from './fileDiffLog.ts'
import { summarizeFileDiffLog } from './fileDiffLog.ts'

export type DiffViewSource = 'session' | 'preview' | 'git'

export type DiffViewFile = {
  path: string
  op?: FileChangeOp | string
  added: number
  removed: number
  edits: number
  tool?: string
  turn?: number
  source: DiffViewSource
  /** 可能为空（resume 仅摘要） */
  hunks: FileDiffHunk[]
}

export type DiffViewModel = {
  title: string
  totals: { files: number; added: number; removed: number }
  files: DiffViewFile[]
  /** 列表选中下标 */
  selectedIndex: number
  /** 是否处于文件详情（看 hunks） */
  detailOpen: boolean
  /** 详情内行滚动偏移 */
  detailScroll: number
}

export type DiffViewKeyResult = {
  vm: DiffViewModel
  done?: 'quit' | 'allow' | 'deny' | 'allow_always'
  /** 提示一行（如无 hunk） */
  toast?: string
}

function opFromRecord(r: FileChangeRecord): string {
  if (r.op) return r.op
  if (r.kind === 'file_write') return 'add'
  return 'update'
}

/**
 * 从会话 fileDiffLog 构建 VM（按 path 聚合，保留最近一条的 hunks）。
 */
export function buildDiffViewModelFromLog(
  log: readonly FileChangeRecord[] | undefined,
  opts?: {
    turn?: number
    lastTurn?: boolean
    title?: string
    pathFilter?: string
  },
): DiffViewModel {
  let turn = opts?.turn
  if (opts?.lastTurn && log?.length) {
    const turns = log.map((r) => r.turn ?? 0).filter((t) => t > 0)
    turn = turns.length ? Math.max(...turns) : undefined
  }

  const summary = summarizeFileDiffLog(log, {
    turn,
    pathFilter: opts?.pathFilter,
  })

  // 每 path：聚合行数；hunks 取该 path 最后一条带 patch 的
  const lastHunks = new Map<string, FileDiffHunk[]>()
  const lastTool = new Map<string, string>()
  const lastTurn = new Map<string, number>()
  if (log?.length) {
    for (const r of log) {
      if (turn !== undefined && r.turn !== turn) continue
      if (opts?.pathFilter) {
        const pf = opts.pathFilter.replace(/\\/g, '/')
        const p = r.path.replace(/\\/g, '/')
        if (p !== pf && !p.endsWith('/' + pf) && !p.includes(pf)) continue
      }
      lastTool.set(r.path, r.tool)
      if (r.turn != null) lastTurn.set(r.path, r.turn)
      if (r.structuredPatch?.length) {
        lastHunks.set(r.path, r.structuredPatch)
      }
    }
  }

  const files: DiffViewFile[] = summary.byPath.map((f) => ({
    path: f.path,
    op: f.op ?? 'update',
    added: f.added,
    removed: f.removed,
    edits: f.edits,
    source: 'session' as const,
    hunks: lastHunks.get(f.path) ?? [],
    ...(lastTool.get(f.path) ? { tool: lastTool.get(f.path) } : {}),
    ...(lastTurn.get(f.path) != null
      ? { turn: lastTurn.get(f.path) }
      : {}),
  }))

  const title =
    opts?.title ??
    (turn !== undefined
      ? `Turn ${turn} file changes`
      : 'Session file changes')

  return {
    title,
    totals: {
      files: summary.filesChanged,
      added: summary.linesAdded,
      removed: summary.linesRemoved,
    },
    files,
    selectedIndex: 0,
    detailOpen: false,
    detailScroll: 0,
  }
}

/**
 * 从写前 preview 构建 VM（权限面板 U2 可复用）。
 */
export function buildDiffViewModelFromPreview(preview: {
  tool?: string
  files: Array<{
    path: string
    op?: string
    added?: number
    removed?: number
    structuredPatch?: FileDiffHunk[]
  }>
  added?: number
  removed?: number
}): DiffViewModel {
  const files: DiffViewFile[] = preview.files.map((f) => ({
    path: f.path,
    op: f.op,
    added: f.added ?? 0,
    removed: f.removed ?? 0,
    edits: 1,
    source: 'preview' as const,
    hunks: f.structuredPatch ?? [],
    tool: preview.tool,
  }))
  const added =
    preview.added ?? files.reduce((s, f) => s + f.added, 0)
  const removed =
    preview.removed ?? files.reduce((s, f) => s + f.removed, 0)
  return {
    title: `${preview.tool ?? 'change'} preview`,
    totals: { files: files.length, added, removed },
    files,
    selectedIndex: 0,
    detailOpen: false,
    detailScroll: 0,
  }
}

export function selectedFile(vm: DiffViewModel): DiffViewFile | undefined {
  if (!vm.files.length) return undefined
  const i = Math.max(0, Math.min(vm.selectedIndex, vm.files.length - 1))
  return vm.files[i]
}

/** 详情区：把 hunks 展成可滚行 */
export function flattenHunkLines(file: DiffViewFile): string[] {
  if (!file.hunks.length) {
    return [
      `(no structuredPatch retained for ${file.path})`,
      `tip: /diff git ${file.path}`,
    ]
  }
  const lines: string[] = [
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
  ]
  for (const h of file.hunks) {
    lines.push(
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    )
    for (const L of h.lines) lines.push(L)
  }
  return lines
}

/**
 * 纯函数键处理（对照 arrowPicker）。
 * list: j/k 选文件 · Enter/l 开详情 · q 退出
 * detail: j/k 滚 hunk · h/Backspace 回列表 · q 退出
 * approve 模式额外：y allow · a always · n/q/esc deny
 */
export function applyDiffViewKey(
  vm: DiffViewModel,
  key: string,
  opts?: { mode?: 'browse' | 'approve' },
): DiffViewKeyResult {
  const k = key.toLowerCase()
  const mode = opts?.mode ?? 'browse'

  if (mode === 'approve') {
    if (k === 'y') return { vm, done: 'allow' }
    if (k === 'a') return { vm, done: 'allow_always' }
    if (k === 'n') return { vm, done: 'deny' }
    // esc/q/ctrl-c = deny（fail-closed）
    if (k === 'q' || k === 'esc' || k === 'ctrl-c') {
      return { vm, done: 'deny' }
    }
  } else {
    if (k === 'q' || k === 'esc' || k === 'ctrl-c') {
      return { vm, done: 'quit' }
    }
  }

  if (!vm.files.length) {
    if (mode === 'approve') {
      if (k === 'y') return { vm, done: 'allow' }
      if (k === 'a') return { vm, done: 'allow_always' }
      return { vm, done: 'deny' }
    }
    if (k === 'enter' || k === 'q') return { vm, done: 'quit' }
    return { vm }
  }

  const n = vm.files.length
  const idx = Math.max(0, Math.min(vm.selectedIndex, n - 1))

  if (vm.detailOpen) {
    const file = vm.files[idx]!
    const body = flattenHunkLines(file)
    const maxScroll = Math.max(0, body.length - 1)
    if (k === 'h' || k === 'left' || k === 'backspace') {
      return {
        vm: { ...vm, detailOpen: false, detailScroll: 0, selectedIndex: idx },
      }
    }
    if (k === 'up' || k === 'k') {
      return {
        vm: {
          ...vm,
          selectedIndex: idx,
          detailScroll: Math.max(0, vm.detailScroll - 1),
        },
      }
    }
    if (k === 'down' || k === 'j') {
      return {
        vm: {
          ...vm,
          selectedIndex: idx,
          detailScroll: Math.min(maxScroll, vm.detailScroll + 1),
        },
      }
    }
    if (k === 'enter' || k === 'l' || k === 'right') {
      return { vm: { ...vm, selectedIndex: idx } }
    }
    return { vm: { ...vm, selectedIndex: idx } }
  }

  // list mode
  if (k === 'up' || k === 'k') {
    return {
      vm: {
        ...vm,
        selectedIndex: (idx - 1 + n) % n,
        detailOpen: false,
        detailScroll: 0,
      },
    }
  }
  if (k === 'down' || k === 'j') {
    return {
      vm: {
        ...vm,
        selectedIndex: (idx + 1) % n,
        detailOpen: false,
        detailScroll: 0,
      },
    }
  }
  if (k === 'enter' || k === 'l' || k === 'right' || k === ' ') {
    const file = vm.files[idx]!
    const toast = !file.hunks.length
      ? mode === 'approve'
        ? `no hunks for ${file.path}`
        : `no hunks · try /diff git ${file.path}`
      : undefined
    return {
      vm: {
        ...vm,
        selectedIndex: idx,
        detailOpen: true,
        detailScroll: 0,
      },
      ...(toast ? { toast } : {}),
    }
  }
  // 数字快选
  if (/^[1-9]$/.test(k)) {
    const ni = Number(k) - 1
    if (ni >= 0 && ni < n) {
      return {
        vm: {
          ...vm,
          selectedIndex: ni,
          detailOpen: true,
          detailScroll: 0,
        },
      }
    }
  }
  return { vm: { ...vm, selectedIndex: idx } }
}

function opGlyph(op?: string): string {
  if (op === 'add' || op === 'A') return 'A'
  if (op === 'delete' || op === 'D') return 'D'
  if (op === 'move' || op === 'R') return 'R'
  return 'M'
}

/**
 * 渲染整屏文本（供 diffPane paint）。
 */
export function formatDiffViewScreen(
  vm: DiffViewModel,
  opts?: {
    rows?: number
    cols?: number
    toast?: string
    mode?: 'browse' | 'approve'
    toolName?: string
  },
): string {
  const rows = Math.max(8, opts?.rows ?? 24)
  const cols = Math.max(40, opts?.cols ?? 80)
  const mode = opts?.mode ?? 'browse'
  const lines: string[] = []

  const head = `${vm.title}  ${vm.totals.files} file(s)  (+${vm.totals.added}/-${vm.totals.removed})`
  lines.push(head.slice(0, cols))
  lines.push('─'.repeat(Math.min(cols, 72)))

  if (!vm.files.length) {
    lines.push('(no file changes)')
    lines.push('')
    if (mode === 'approve') {
      lines.push(
        `Allow ${opts?.toolName ?? 'tool'}?  y allow · a always · n/q deny`,
      )
    } else {
      lines.push('q quit')
    }
    return lines.join('\n')
  }

  if (!vm.detailOpen) {
    if (mode === 'approve') {
      lines.push(
        `↑↓/jk · Enter detail · y allow · a always · n/q deny`,
      )
    } else {
      lines.push('↑↓/jk select · Enter open · q quit')
    }
    lines.push('')
    const listBudget = Math.max(4, rows - 7)
    const start = Math.max(
      0,
      Math.min(
        vm.selectedIndex - Math.floor(listBudget / 2),
        vm.files.length - listBudget,
      ),
    )
    const slice = vm.files.slice(start, start + listBudget)
    slice.forEach((f, i) => {
      const real = start + i
      const mark = real === vm.selectedIndex ? '›' : ' '
      const lab = `${opGlyph(f.op)} ${f.path}  +${f.added}/-${f.removed}${f.edits > 1 ? ` ×${f.edits}` : ''}`
      const trunc = lab.length > cols - 4 ? lab.slice(0, cols - 5) + '…' : lab
      lines.push(`${mark} ${real + 1}. ${trunc}`)
    })
  } else {
    const file = selectedFile(vm)!
    const backHint =
      mode === 'approve'
        ? 'h back · y/a/n decide'
        : 'h back · q quit'
    lines.push(
      `detail: ${opGlyph(file.op)} ${file.path}  +${file.added}/-${file.removed}  (${backHint})`,
    )
    lines.push('')
    const body = flattenHunkLines(file)
    const budget = Math.max(4, rows - 7)
    const scroll = Math.max(
      0,
      Math.min(vm.detailScroll, Math.max(0, body.length - 1)),
    )
    const view = body.slice(scroll, scroll + budget)
    for (const L of view) {
      lines.push(L.length > cols ? L.slice(0, cols - 1) + '…' : L)
    }
    if (scroll + budget < body.length) {
      lines.push(`… +${body.length - scroll - budget} lines`)
    }
  }

  if (opts?.toast) {
    lines.push('')
    lines.push(`! ${opts.toast}`)
  }
  if (mode === 'approve' && !vm.detailOpen) {
    lines.push('')
    lines.push(
      `Allow ${opts?.toolName ?? 'tool'}? [y/a/N]  (browse with jk first)`,
    )
  }
  return lines.join('\n')
}

// re-export op helper for tests
export function _opFromRecordForTest(r: FileChangeRecord): string {
  return opFromRecord(r)
}