/**
 * 终端 ANSI diff 摘要 — 对照 Codex create_diff_summary 级别（无遥测）
 * 仅 UI side-channel；模型 output 保持 plain。
 */

import type { DiffHunk } from './textDiff.ts'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'

export function formatCountsAnsi(added: number, removed: number): string {
  return `(${GREEN}+${added}${RESET} ${RED}-${removed}${RESET})`
}

export function formatCountsPlain(added: number, removed: number): string {
  return `(+${added}/-${removed})`
}

export function formatFileChangeEndLine(opts: {
  name: string
  path?: string
  added?: number
  removed?: number
  ok?: boolean
  /** 多文件时 paths 摘要 */
  paths?: string[]
  color?: boolean
}): string {
  const ok = opts.ok !== false
  const mark = ok ? '✓' : '✗'
  const color = opts.color !== false
  let pathPart = ''
  if (opts.path) pathPart = `  ${opts.path}`
  else if (opts.paths?.length) {
    pathPart =
      opts.paths.length === 1
        ? `  ${opts.paths[0]}`
        : `  ${opts.paths.length} files`
  }
  let counts = ''
  if (opts.added != null || opts.removed != null) {
    const a = opts.added ?? 0
    const r = opts.removed ?? 0
    counts = color
      ? `  ${formatCountsAnsi(a, r)}`
      : `  ${formatCountsPlain(a, r)}`
  }
  const name = color && ok ? `${BOLD}${opts.name}${RESET}` : opts.name
  return `${mark} ${name}${pathPart}${counts}`
}

/**
 * 给 unified 行上色（+ / - / @@ / 上下文）。
 */
export function colorizeUnifiedText(
  unified: string,
  opts?: { maxLines?: number },
): string {
  const max = opts?.maxLines ?? 80
  const lines = unified.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length && i < max; i++) {
    const L = lines[i]!
    if (L.startsWith('+') && !L.startsWith('+++')) {
      out.push(`${GREEN}${L}${RESET}`)
    } else if (L.startsWith('-') && !L.startsWith('---')) {
      out.push(`${RED}${L}${RESET}`)
    } else if (L.startsWith('@@')) {
      out.push(`${CYAN}${L}${RESET}`)
    } else if (L.startsWith('---') || L.startsWith('+++')) {
      out.push(`${DIM}${L}${RESET}`)
    } else {
      out.push(`${DIM}${L}${RESET}`)
    }
  }
  if (lines.length > max) out.push(`${DIM}…(truncated)${RESET}`)
  return out.join('\n')
}

export function formatAnsiUnifiedFromHunks(
  filePath: string,
  hunks: readonly DiffHunk[],
  opts?: { maxLines?: number },
): string {
  if (!hunks.length) return ''
  const max = opts?.maxLines ?? 60
  const out: string[] = [
    `${DIM}--- a/${filePath}${RESET}`,
    `${DIM}+++ b/${filePath}${RESET}`,
  ]
  let n = 2
  for (const h of hunks) {
    if (n >= max) {
      out.push(`${DIM}…(truncated)${RESET}`)
      break
    }
    out.push(
      `${CYAN}@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${RESET}`,
    )
    n++
    for (const L of h.lines) {
      if (n >= max) {
        out.push(`${DIM}…(truncated)${RESET}`)
        return out.join('\n')
      }
      if (L.startsWith('+') && !L.startsWith('+++')) {
        out.push(`${GREEN}${L}${RESET}`)
      } else if (L.startsWith('-') && !L.startsWith('---')) {
        out.push(`${RED}${L}${RESET}`)
      } else {
        out.push(`${DIM}${L}${RESET}`)
      }
      n++
    }
  }
  return out.join('\n')
}

export type DiffSummaryRow = {
  path: string
  op?: 'add' | 'update' | 'delete' | 'move' | string
  added: number
  removed: number
  /** 可选 move 目标 */
  moveTo?: string
  edits?: number
}

/**
 * 对照 Codex create_diff_summary：多文件路径块 + 着色行数。
 * 纯文本/ANSI 字符串，无 ratatui。
 */
export function createDiffSummary(
  rows: readonly DiffSummaryRow[],
  opts?: {
    title?: string
    color?: boolean
    maxFiles?: number
    /** 附带首文件 unified（已着色或 plain） */
    firstUnified?: string
  },
): string {
  const color = opts?.color !== false
  const maxFiles = opts?.maxFiles ?? 40
  const totalA = rows.reduce((s, r) => s + r.added, 0)
  const totalR = rows.reduce((s, r) => s + r.removed, 0)
  const title = opts?.title ?? 'File changes'
  const countPart = color
    ? formatCountsAnsi(totalA, totalR)
    : formatCountsPlain(totalA, totalR)
  const lines: string[] = [
    `${title}: ${rows.length} file(s)  ${countPart}`,
  ]
  const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path))
  for (const r of sorted.slice(0, maxFiles)) {
    const op = opGlyph(r.op)
    const move =
      r.moveTo && r.op === 'move' ? ` → ${r.moveTo}` : ''
    const counts = color
      ? formatCountsAnsi(r.added, r.removed)
      : formatCountsPlain(r.added, r.removed)
    const edits =
      r.edits != null && r.edits > 1 ? `  ×${r.edits}` : ''
    const opS = color ? colorOp(op) : op
    lines.push(`  ${opS} ${r.path}${move}  ${counts}${edits}`)
  }
  if (sorted.length > maxFiles) {
    lines.push(`  …(+${sorted.length - maxFiles} more)`)
  }
  if (opts?.firstUnified?.trim()) {
    lines.push(opts.firstUnified.trim())
  }
  return lines.join('\n')
}

function opGlyph(op?: string): string {
  if (op === 'add' || op === 'A') return 'A'
  if (op === 'delete' || op === 'D') return 'D'
  if (op === 'move' || op === 'R') return 'R'
  if (op === 'file_write' || op === 'W') return 'W'
  return 'M'
}

function colorOp(op: string): string {
  if (op === 'A') return `${GREEN}A${RESET}`
  if (op === 'D') return `${RED}D${RESET}`
  if (op === 'R') return `${CYAN}R${RESET}`
  return `${CYAN}${op}${RESET}`
}

/** BOLO_DIFF_VERBOSE=1 → 较长 unified；默认小片段；COMPACT=1 仅一行 */
export function shouldShowVerboseDiff(): boolean {
  const v = process.env.BOLO_DIFF_VERBOSE
  return v === '1' || v === 'true' || v === 'yes'
}

export function shouldShowCompactDiffOnly(): boolean {
  const v = process.env.BOLO_DIFF_COMPACT
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * 写后默认附带短 unified（除非 COMPACT）。
 * verbose → 40 行；默认 → 16 行。
 */
export function inlineDiffMaxLines(): number {
  if (shouldShowCompactDiffOnly()) return 0
  if (shouldShowVerboseDiff()) return 40
  return 16
}