/**
 * 最小可用 apply_patch — Codex / *** Begin Patch 风格
 *
 * 支持：
 * - *** Begin Patch / *** End Patch
 * - *** Add File: path
 * - *** Update File: path  (+ 可选 @@ 与 -/+ 行)
 * - *** Delete File: path
 * - 简易 unified diff（--- a/path / +++ b/path / @@ ... @@）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export function resolveSafe(cwd: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
  const resolved = path.resolve(abs)
  const root = path.resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes cwd: ${filePath}`)
  }
  return resolved
}

export type PatchOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'update'; path: string; hunks: PatchHunk[] }
  | { kind: 'delete'; path: string }

export type PatchHunk = {
  /** 旧文件中按顺序匹配的行（不含前缀） */
  oldLines: string[]
  /** 替换后的行（不含前缀） */
  newLines: string[]
}

export type ApplyPatchResult = {
  ok: true
  output: string
  changed: string[]
}

function stripPatchWrapper(raw: string): string {
  let text = raw.replace(/^\uFEFF/, '').trim()
  const begin = text.match(/^\*\*\*\s*Begin Patch\s*$/im)
  if (begin && begin.index !== undefined) {
    text = text.slice(begin.index + begin[0].length)
  }
  const end = text.match(/^\*\*\*\s*End Patch\s*$/im)
  if (end && end.index !== undefined) {
    text = text.slice(0, end.index)
  }
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}

function cleanFilePath(p: string): string {
  let s = p.trim()
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2)
  s = s.replace(/^["']|["']$/g, '')
  return s
}

/**
 * 解析 patch 文本为操作列表。失败抛错（消息可直接给模型）。
 */
export function parseApplyPatch(raw: string): PatchOp[] {
  if (!raw?.trim()) {
    throw new Error('apply_patch: empty patch')
  }
  const body = stripPatchWrapper(raw)
  const lines = body.split(/\r?\n/)
  const ops: PatchOp[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }

    // Codex style headers
    let m = line.match(/^\*\*\*\s*Add File:\s*(.+)$/i)
    if (m) {
      const filePath = cleanFilePath(m[1]!)
      i++
      const contentLines: string[] = []
      while (i < lines.length) {
        const L = lines[i]!
        if (L.startsWith('*** ')) break
        if (L.startsWith('--- ') || L.startsWith('+++ ')) break
        if (L.startsWith('+')) contentLines.push(L.slice(1))
        else if (L.startsWith('\\')) {
          /* no newline marker — ignore */
        } else if (L === '') contentLines.push('')
        else {
          // bare content lines allowed for Add File
          contentLines.push(L.startsWith(' ') ? L.slice(1) : L)
        }
        i++
      }
      ops.push({ kind: 'add', path: filePath, lines: contentLines })
      continue
    }

    m = line.match(/^\*\*\*\s*Delete File:\s*(.+)$/i)
    if (m) {
      ops.push({ kind: 'delete', path: cleanFilePath(m[1]!) })
      i++
      continue
    }

    m = line.match(/^\*\*\*\s*Update File:\s*(.+)$/i)
    if (m) {
      const filePath = cleanFilePath(m[1]!)
      i++
      const hunks: PatchHunk[] = []
      // skip optional @@ headers and collect -/+ / space lines into hunks
      while (i < lines.length) {
        const L = lines[i]!
        if (L.startsWith('*** ')) break
        if (L.startsWith('--- ') || L.startsWith('+++ ')) break
        if (L.startsWith('@@')) {
          i++
          const hunk = readHunkLines(lines, i)
          i = hunk.next
          if (hunk.oldLines.length || hunk.newLines.length) {
            hunks.push({ oldLines: hunk.oldLines, newLines: hunk.newLines })
          }
          continue
        }
        // hunk without @@ — treat remaining until next header as one hunk
        if (L.startsWith('+') || L.startsWith('-') || L.startsWith(' ')) {
          const hunk = readHunkLines(lines, i)
          i = hunk.next
          if (hunk.oldLines.length || hunk.newLines.length) {
            hunks.push({ oldLines: hunk.oldLines, newLines: hunk.newLines })
          }
          continue
        }
        if (!L.trim()) {
          i++
          continue
        }
        throw new Error(
          `apply_patch: unexpected line in Update File ${filePath}: ${L.slice(0, 80)}`,
        )
      }
      if (!hunks.length) {
        throw new Error(`apply_patch: Update File ${filePath} has no hunks`)
      }
      ops.push({ kind: 'update', path: filePath, hunks })
      continue
    }

    // unified diff: --- a/path then +++ b/path
    m = line.match(/^---\s+(.+)$/)
    if (m) {
      const fromPath = cleanFilePath(m[1]!)
      i++
      const plus = lines[i]
      const plusM = plus?.match(/^\+\+\+\s+(.+)$/)
      if (!plusM) {
        throw new Error('apply_patch: unified diff missing +++ line after ---')
      }
      const toPath = cleanFilePath(plusM[1]!)
      i++
      const filePath =
        toPath === '/dev/null' ? fromPath : fromPath === '/dev/null' ? toPath : toPath || fromPath

      if (toPath === '/dev/null') {
        ops.push({ kind: 'delete', path: filePath })
        // skip hunks
        while (i < lines.length && !lines[i]!.startsWith('--- ') && !lines[i]!.startsWith('*** ')) {
          i++
        }
        continue
      }
      if (fromPath === '/dev/null') {
        const contentLines: string[] = []
        while (i < lines.length) {
          const L = lines[i]!
          if (L.startsWith('--- ') || L.startsWith('*** ')) break
          if (L.startsWith('@@')) {
            i++
            continue
          }
          if (L.startsWith('+')) contentLines.push(L.slice(1))
          else if (L.startsWith('\\') || L.startsWith(' ')) {
            /* ignore */
          } else if (!L.trim()) {
            /* skip */
          }
          i++
        }
        ops.push({ kind: 'add', path: filePath, lines: contentLines })
        continue
      }

      const hunks: PatchHunk[] = []
      while (i < lines.length) {
        const L = lines[i]!
        if (L.startsWith('--- ') || L.startsWith('*** ')) break
        if (L.startsWith('@@')) {
          i++
          const hunk = readHunkLines(lines, i)
          i = hunk.next
          if (hunk.oldLines.length || hunk.newLines.length) {
            hunks.push({ oldLines: hunk.oldLines, newLines: hunk.newLines })
          }
          continue
        }
        if (!L.trim()) {
          i++
          continue
        }
        // stray content — stop
        break
      }
      if (!hunks.length) {
        throw new Error(`apply_patch: unified diff for ${filePath} has no hunks`)
      }
      ops.push({ kind: 'update', path: filePath, hunks })
      continue
    }

    throw new Error(`apply_patch: unrecognized line: ${line.slice(0, 100)}`)
  }

  if (!ops.length) {
    throw new Error('apply_patch: no file operations found')
  }
  return ops
}

function readHunkLines(
  lines: string[],
  start: number,
): { oldLines: string[]; newLines: string[]; next: number } {
  const oldLines: string[] = []
  const newLines: string[] = []
  let i = start
  while (i < lines.length) {
    const L = lines[i]!
    if (L.startsWith('@@')) break
    if (L.startsWith('*** ')) break
    if (L.startsWith('--- ') || L.startsWith('+++ ')) break
    if (L.startsWith('\\')) {
      i++
      continue
    }
    if (L.startsWith('-')) {
      oldLines.push(L.slice(1))
      i++
      continue
    }
    if (L.startsWith('+')) {
      newLines.push(L.slice(1))
      i++
      continue
    }
    if (L.startsWith(' ')) {
      const body = L.slice(1)
      oldLines.push(body)
      newLines.push(body)
      i++
      continue
    }
    // empty context line
    if (L === '') {
      oldLines.push('')
      newLines.push('')
      i++
      continue
    }
    break
  }
  return { oldLines, newLines, next: i }
}

function applyHunksToText(original: string, hunks: PatchHunk[], fileLabel: string): string {
  // Normalize to \n for matching; preserve final newline preference
  const hadTrailingNl = original.endsWith('\n')
  let text = original.replace(/\r\n/g, '\n')
  if (hadTrailingNl && text.endsWith('\n')) {
    text = text.slice(0, -1)
  }
  let lines = text.length ? text.split('\n') : []

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h]!
    const old = hunk.oldLines
    const neu = hunk.newLines
    if (!old.length) {
      // pure insert at end if empty file, else append
      if (!lines.length) {
        lines = [...neu]
      } else {
        lines = [...lines, ...neu]
      }
      continue
    }
    const idx = findSubsequence(lines, old)
    if (idx < 0) {
      throw new Error(
        `apply_patch: hunk ${h + 1} context not found in ${fileLabel}:\n${old.slice(0, 5).join('\n')}`,
      )
    }
    lines = [...lines.slice(0, idx), ...neu, ...lines.slice(idx + old.length)]
  }

  let out = lines.join('\n')
  if (hadTrailingNl || out.length) {
    if (!out.endsWith('\n')) out += '\n'
  }
  return out
}

function findSubsequence(hay: string[], needle: string[]): number {
  if (!needle.length) return 0
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * 将 patch 应用到 cwd 内文件。失败抛错。
 */
export async function applyPatchToCwd(
  cwd: string,
  raw: string,
): Promise<ApplyPatchResult> {
  const ops = parseApplyPatch(raw)
  const changed: string[] = []
  const notes: string[] = []

  for (const op of ops) {
    const abs = resolveSafe(cwd, op.path)
    const rel = path.relative(path.resolve(cwd), abs) || op.path

    if (op.kind === 'add') {
      let exists = false
      try {
        await fs.access(abs)
        exists = true
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') throw e
      }
      if (exists) {
        throw new Error(`apply_patch: Add File but already exists: ${rel}`)
      }
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const body = op.lines.join('\n') + (op.lines.length ? '\n' : '')
      await fs.writeFile(abs, body, 'utf8')
      changed.push(rel)
      notes.push(`A ${rel}`)
      continue
    }

    if (op.kind === 'delete') {
      try {
        await fs.unlink(abs)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') {
          throw new Error(`apply_patch: Delete File not found: ${rel}`)
        }
        throw e
      }
      changed.push(rel)
      notes.push(`D ${rel}`)
      continue
    }

    // update
    let original: string
    try {
      original = await fs.readFile(abs, 'utf8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        throw new Error(`apply_patch: Update File not found: ${rel}`)
      }
      throw e
    }
    const next = applyHunksToText(original, op.hunks, rel)
    await fs.writeFile(abs, next, 'utf8')
    changed.push(rel)
    notes.push(`M ${rel}`)
  }

  return {
    ok: true,
    output: notes.join('\n') || 'applied',
    changed,
  }
}