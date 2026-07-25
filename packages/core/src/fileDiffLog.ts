/**
 * 会话级文件改动 log — 对照 HC useTurnDiffs + Codex create_diff_summary 最小子集
 * 纯函数；session 侧 side-channel，不污染 ChatMessage.content。
 */

import { createDiffSummary } from '../../tools/src/ansiDiff.ts'

export type FileDiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type FileChangeOp = 'add' | 'update' | 'delete' | 'move'

export type FileChangeRecord = {
  at: string
  /** 产生改动的工具名 */
  tool: string
  path: string
  kind: 'file_edit' | 'file_write' | 'apply_patch'
  op?: FileChangeOp
  added: number
  removed: number
  /** 用户 turn 序号（submitPrompt 递增）；0 = 未知 */
  turn?: number
  /** 可选；内存预算内保留，供 /diff <path> */
  structuredPatch?: FileDiffHunk[]
}

export type FileDiffSummary = {
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  byPath: Array<{
    path: string
    op?: FileChangeOp
    added: number
    removed: number
    edits: number
  }>
}

/** 内存保留最近 N 条（含 structuredPatch 时偏大） */
export const DEFAULT_FILE_DIFF_LOG_MAX = 80

export function createEmptyFileDiffLog(): FileChangeRecord[] {
  return []
}

export function appendFileChange(
  log: FileChangeRecord[] | undefined,
  record: FileChangeRecord,
  opts?: { max?: number },
): FileChangeRecord[] {
  const max = opts?.max ?? DEFAULT_FILE_DIFF_LOG_MAX
  const next = [...(log ?? []), record]
  if (next.length <= max) return next
  return next.slice(next.length - max)
}

/**
 * 从 tool meta 展开为 1..N 条 record（apply_patch 多文件）。
 */
export function recordsFromToolMeta(opts: {
  toolName: string
  meta: {
    kind?: string
    path?: string
    paths?: string[]
    op?: FileChangeOp
    added?: number
    removed?: number
    structuredPatch?: FileDiffHunk[]
    files?: Array<{
      path: string
      op?: FileChangeOp
      added?: number
      removed?: number
      structuredPatch?: FileDiffHunk[]
    }>
  }
  at?: string
  turn?: number
}): FileChangeRecord[] {
  const kind = opts.meta.kind
  if (kind !== 'file_edit' && kind !== 'file_write' && kind !== 'apply_patch') {
    return []
  }
  const at = opts.at ?? new Date().toISOString()
  const turn = opts.turn
  const tool = opts.toolName

  if (opts.meta.files?.length) {
    return opts.meta.files.map((f) => ({
      at,
      tool,
      path: f.path,
      kind: kind as FileChangeRecord['kind'],
      ...(f.op ? { op: f.op } : opts.meta.op ? { op: opts.meta.op } : {}),
      added: f.added ?? 0,
      removed: f.removed ?? 0,
      ...(turn !== undefined ? { turn } : {}),
      ...(f.structuredPatch?.length
        ? { structuredPatch: f.structuredPatch }
        : {}),
    }))
  }

  const path =
    opts.meta.path ??
    (opts.meta.paths?.length ? opts.meta.paths[0] : undefined)
  if (!path) return []

  return [
    {
      at,
      tool,
      path,
      kind: kind as FileChangeRecord['kind'],
      ...(opts.meta.op ? { op: opts.meta.op } : {}),
      added: opts.meta.added ?? 0,
      removed: opts.meta.removed ?? 0,
      ...(turn !== undefined ? { turn } : {}),
      ...(opts.meta.structuredPatch?.length
        ? { structuredPatch: opts.meta.structuredPatch }
        : {}),
    },
  ]
}

export function summarizeFileDiffLog(
  log: readonly FileChangeRecord[] | undefined,
  opts?: { turn?: number; pathFilter?: string },
): FileDiffSummary {
  const filtered = filterLog(log, opts)
  const map = new Map<
    string,
    { path: string; op?: FileChangeOp; added: number; removed: number; edits: number }
  >()
  for (const r of filtered) {
    const cur = map.get(r.path) ?? {
      path: r.path,
      op: r.op,
      added: 0,
      removed: 0,
      edits: 0,
    }
    cur.added += r.added
    cur.removed += r.removed
    cur.edits += 1
    if (r.op) cur.op = r.op
    map.set(r.path, cur)
  }
  const byPath = [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
  return {
    filesChanged: byPath.length,
    linesAdded: byPath.reduce((s, x) => s + x.added, 0),
    linesRemoved: byPath.reduce((s, x) => s + x.removed, 0),
    byPath,
  }
}

function filterLog(
  log: readonly FileChangeRecord[] | undefined,
  opts?: { turn?: number; pathFilter?: string; lastN?: number },
): FileChangeRecord[] {
  let list = [...(log ?? [])]
  if (opts?.turn !== undefined) {
    list = list.filter((r) => r.turn === opts.turn)
  }
  if (opts?.pathFilter) {
    const pf = opts.pathFilter.replace(/\\/g, '/')
    list = list.filter((r) => {
      const p = r.path.replace(/\\/g, '/')
      return p === pf || p.endsWith('/' + pf) || p.includes(pf)
    })
  }
  if (opts?.lastN !== undefined && opts.lastN >= 0) {
    list = list.slice(Math.max(0, list.length - opts.lastN))
  }
  return list
}

function opLabel(op?: FileChangeOp, kind?: FileChangeRecord['kind']): string {
  if (op === 'add') return 'A'
  if (op === 'delete') return 'D'
  if (op === 'move') return 'R'
  if (op === 'update') return 'M'
  if (kind === 'file_write') return 'W'
  if (kind === 'file_edit') return 'M'
  return 'M'
}

function formatHunkBody(
  hunks: readonly FileDiffHunk[],
  maxLines: number,
): string[] {
  const lines: string[] = []
  let n = 0
  for (const h of hunks) {
    lines.push(
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    )
    n++
    for (const L of h.lines) {
      if (n >= maxLines) {
        lines.push('…(truncated)')
        return lines
      }
      lines.push(L)
      n++
    }
  }
  return lines
}

function colorizeLines(text: string): string {
  const RESET = '\x1b[0m'
  const DIM = '\x1b[2m'
  const GREEN = '\x1b[32m'
  const RED = '\x1b[31m'
  const CYAN = '\x1b[36m'
  return text
    .split('\n')
    .map((L) => {
      if (L.startsWith('+') && !L.startsWith('+++')) return `${GREEN}${L}${RESET}`
      if (L.startsWith('-') && !L.startsWith('---')) return `${RED}${L}${RESET}`
      if (L.startsWith('@@')) return `${CYAN}${L}${RESET}`
      if (L.startsWith('#')) return `${DIM}${L}${RESET}`
      return L
    })
    .join('\n')
}

function formatListFallback(
  scope: string,
  summary: FileDiffSummary,
): string {
  const lines: string[] = [
    `${scope}: ${summary.filesChanged} file(s)  +${summary.linesAdded}/-${summary.linesRemoved}`,
  ]
  for (const f of summary.byPath) {
    lines.push(
      `  ${opLabel(f.op)} ${f.path}  +${f.added}/-${f.removed}${f.edits > 1 ? `  (${f.edits} edits)` : ''}`,
    )
  }
  if (!summary.byPath.length) lines.push('  (none)')
  return lines.join('\n')
}

/**
 * `/diff` 文本输出。
 * - 无参：会话累计（Codex 风格多文件摘要）
 * - last：最近 turn
 * - path：该路径最近一次 structured
 * - color：ANSI 行数着色（默认 true）
 */
export function formatDiffSlash(
  log: readonly FileChangeRecord[] | undefined,
  opts?: {
    turn?: number
    lastTurn?: boolean
    pathFilter?: string
    maxHunkLines?: number
    color?: boolean
    /** 列表模式也附带最近一条的短 hunk */
    showSnippet?: boolean
  },
): string {
  if (!log?.length) {
    return 'No file changes recorded this session (resume restores path/+N/−M summaries only).'
  }

  let turn = opts?.turn
  if (opts?.lastTurn) {
    const turns = log.map((r) => r.turn ?? 0).filter((t) => t > 0)
    turn = turns.length ? Math.max(...turns) : undefined
  }

  const summary = summarizeFileDiffLog(log, {
    turn,
    pathFilter: opts?.pathFilter,
  })
  const color = opts?.color !== false

  if (opts?.pathFilter) {
    const filtered = filterLog(log, {
      turn,
      pathFilter: opts.pathFilter,
    })
    if (!filtered.length) {
      return `No file changes matching ${opts.pathFilter}`
    }
    const last = filtered[filtered.length - 1]!
    const head = `${opLabel(last.op, last.kind)} ${last.path}  +${last.added}/-${last.removed}  (${last.tool}${last.turn != null ? ` · turn ${last.turn}` : ''})`
    if (!last.structuredPatch?.length) {
      return `${head}\n(no structuredPatch retained for this entry — try /diff git ${opts.pathFilter})`
    }
    const body = formatHunkBody(
      last.structuredPatch,
      opts.maxHunkLines ?? 80,
    )
    let text = [head, ...body].join('\n')
    if (color) text = colorizeLines(text)
    return text
  }

  const scope =
    turn !== undefined ? `Turn ${turn} file changes` : 'Session file changes'

  let block = formatListFallback(scope, summary)
  try {
    block = createDiffSummary(
      summary.byPath.map((f) => ({
        path: f.path,
        op: f.op ?? 'update',
        added: f.added,
        removed: f.removed,
        edits: f.edits,
      })),
      { title: scope, color, maxFiles: 50 },
    )
  } catch {
    /* plain fallback already set */
  }

  if (opts?.showSnippet !== false) {
    const filtered = filterLog(log, { turn })
    const lastWithPatch = [...filtered]
      .reverse()
      .find((r) => r.structuredPatch && r.structuredPatch.length > 0)
    if (lastWithPatch?.structuredPatch) {
      const snip = formatHunkBody(lastWithPatch.structuredPatch, 12)
      const raw = [`# latest: ${lastWithPatch.path}`, ...snip].join('\n')
      block = `${block}\n${color ? colorizeLines(raw) : raw}`
    }
  }

  return `${block}\nTip: /diff last · /diff <path> · /diff git [path]`
}