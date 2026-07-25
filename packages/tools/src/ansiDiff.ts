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

export function formatFileChangeEndLine(opts: {
  name: string
  path?: string
  added?: number
  removed?: number
  ok?: boolean
}): string {
  const ok = opts.ok !== false
  const mark = ok ? '✓' : '✗'
  const pathPart = opts.path ? `  ${opts.path}` : ''
  const counts =
    opts.added != null || opts.removed != null
      ? `  +${opts.added ?? 0}/-${opts.removed ?? 0}`
      : ''
  return `${mark} ${opts.name}${pathPart}${counts}`
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
    out.push(`${CYAN}@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${RESET}`)
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

export function shouldShowVerboseDiff(): boolean {
  const v = process.env.BOLO_DIFF_VERBOSE
  return v === '1' || v === 'true' || v === 'yes'
}