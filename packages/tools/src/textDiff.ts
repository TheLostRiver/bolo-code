/**
 * 文件文本 diff — 对照 HC structuredPatch / countLinesChanged（无遥测）
 * Edit：old→new 局部；Write：全文件前后对比（简化）
 */

export type DiffHunk = {
  /** 1-based line in old file */
  oldStart: number
  oldLines: number
  /** 1-based line in new file */
  newStart: number
  newLines: number
  /** lines with leading ' ' | '+' | '-' */
  lines: string[]
}

export type LineCounts = {
  added: number
  removed: number
}

export function countHunkLines(hunks: readonly DiffHunk[]): LineCounts {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      else if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
  }
  return { added, removed }
}

/**
 * 将 before 文本中 oldStr→newStr 的替换结果，生成局部 hunks。
 * 与 Edit 工具语义一致（非重叠 indexOf 步进）。
 */
export function diffHunksFromEdit(
  before: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): DiffHunk[] {
  if (!oldStr || oldStr === newStr) return []

  const hunks: DiffHunk[] = []
  let searchFrom = 0
  let lineOffsetDelta = 0 // 前面替换导致的行号偏移（new - old 净增行）

  while (searchFrom <= before.length) {
    const idx = before.indexOf(oldStr, searchFrom)
    if (idx < 0) break

    const oldLines = splitLinesKeepEmpty(oldStr)
    const newLines = splitLinesKeepEmpty(newStr)
    // 在 before 中 idx 对应的 1-based 行号
    const prefix = before.slice(0, idx)
    const oldStart = countNewlines(prefix) + 1
    const newStart = oldStart + lineOffsetDelta

    const lines: string[] = []
    for (const L of oldLines) lines.push(`-${L}`)
    for (const L of newLines) lines.push(`+${L}`)

    hunks.push({
      oldStart,
      oldLines: Math.max(1, oldLines.length),
      newStart,
      newLines: Math.max(1, newLines.length),
      lines,
    })

    lineOffsetDelta += newLines.length - oldLines.length
    searchFrom = idx + oldStr.length
    if (!replaceAll) break
  }

  return hunks
}

/**
 * 全文件 before→after 的简化 unified 风格 hunk（整文件一块，带上下文预算）。
 * 不实现完整 Myers；足够 Write 展示。
 */
export function diffHunksFromFullReplace(
  before: string,
  after: string,
  opts?: { context?: number; maxHunkLines?: number },
): DiffHunk[] {
  if (before === after) return []
  const a = splitLinesKeepEmpty(before)
  const b = splitLinesKeepEmpty(after)
  // 空 before = 新建：整文件 +
  if (a.length === 1 && a[0] === '' && before === '') {
    return [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: b.length,
        lines: b.map((L) => `+${L}`),
      },
    ]
  }

  // 找公共前缀/后缀，中间当一块替换
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let asuf = a.length - 1
  let bsuf = b.length - 1
  while (asuf >= pre && bsuf >= pre && a[asuf] === b[bsuf]) {
    asuf--
    bsuf--
  }

  const ctx = Math.max(0, opts?.context ?? 3)
  const oldStart = Math.max(1, pre + 1 - ctx)
  const newStart = Math.max(1, pre + 1 - ctx)
  const lines: string[] = []

  // context before
  for (let i = oldStart - 1; i < pre; i++) {
    if (i >= 0 && i < a.length) lines.push(` ${a[i]}`)
  }
  // removed
  for (let i = pre; i <= asuf; i++) {
    if (i >= 0 && i < a.length) lines.push(`-${a[i]}`)
  }
  // added
  for (let i = pre; i <= bsuf; i++) {
    if (i >= 0 && i < b.length) lines.push(`+${b[i]}`)
  }
  // context after
  const afterStart = asuf + 1
  const afterEnd = Math.min(a.length, afterStart + ctx)
  for (let i = afterStart; i < afterEnd; i++) {
    lines.push(` ${a[i]}`)
  }

  const max = opts?.maxHunkLines ?? 400
  const truncated = lines.length > max
  const body = truncated ? lines.slice(0, max) : lines
  if (truncated) body.push(' …(diff truncated)')

  const oldChunk = Math.max(0, asuf - pre + 1)
  const newChunk = Math.max(0, bsuf - pre + 1)

  return [
    {
      oldStart,
      oldLines: oldChunk + Math.min(ctx, pre) + Math.min(ctx, a.length - afterStart),
      newStart,
      newLines: newChunk + Math.min(ctx, pre) + Math.min(ctx, a.length - afterStart),
      lines: body,
    },
  ]
}

export function formatUnifiedDiff(
  filePath: string,
  hunks: readonly DiffHunk[],
  opts?: { maxLines?: number; maxChars?: number },
): string {
  if (!hunks.length) return ''
  const maxLines = opts?.maxLines ?? 80
  const maxChars = opts?.maxChars ?? 4000
  const out: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ]
  let lineCount = 0
  let charCount = out.join('\n').length

  for (const h of hunks) {
    const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
    if (lineCount + 1 > maxLines || charCount + header.length > maxChars) {
      out.push('…(unified truncated)')
      break
    }
    out.push(header)
    lineCount++
    charCount += header.length + 1
    for (const L of h.lines) {
      if (lineCount >= maxLines || charCount + L.length > maxChars) {
        out.push('…(unified truncated)')
        return out.join('\n')
      }
      out.push(L)
      lineCount++
      charCount += L.length + 1
    }
  }
  return out.join('\n')
}

export function formatEditToolOutput(opts: {
  path: string
  replacements: number
  hunks: readonly DiffHunk[]
  /** 是否在 output 附 unified */
  includeUnified?: boolean
}): string {
  const { added, removed } = countHunkLines(opts.hunks)
  const n = opts.replacements
  const head = `edited ${opts.path} (${n} replacement${n === 1 ? '' : 's'}; +${added}/-${removed})`
  if (opts.includeUnified === false || !opts.hunks.length) return head
  const uni = formatUnifiedDiff(opts.path, opts.hunks)
  if (!uni) return head
  return `${head}\n${uni}`
}

export function formatWriteToolOutput(opts: {
  path: string
  created: boolean
  hunks: readonly DiffHunk[]
  includeUnified?: boolean
}): string {
  const { added, removed } = countHunkLines(opts.hunks)
  const head = opts.created
    ? `wrote ${opts.path} (new file; +${added})`
    : `wrote ${opts.path} (+${added}/-${removed})`
  if (opts.includeUnified === false || !opts.hunks.length) return head
  const uni = formatUnifiedDiff(opts.path, opts.hunks)
  if (!uni) return head
  return `${head}\n${uni}`
}

function splitLinesKeepEmpty(s: string): string[] {
  if (s === '') return ['']
  // 保留末行空：split 后若以 \n 结尾会多一个 ''
  return s.split(/\r?\n/)
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') n++
  }
  return n
}