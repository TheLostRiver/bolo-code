/**
 * 本地 git diff 辅助 — 对照 HC fetchSingleFileGitDiff 缩小版
 * 无 GitHub repository / 无遥测；失败返回 null。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  countHunkLines,
  diffHunksFromFullReplace,
  formatUnifiedDiff,
} from './textDiff.ts'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 3000

export type GitFileDiff = {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'unknown'
  added: number
  removed: number
  patch: string
}

export type GitStatusEntry = {
  path: string
  /** porcelain XY 简码或简写 */
  code: string
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; code: number } | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
    return { stdout: String(stdout ?? ''), code: 0 }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; killed?: boolean }
    if (typeof err.stdout === 'string' && err.stdout) {
      return { stdout: err.stdout, code: typeof err.code === 'number' ? err.code : 1 }
    }
    return null
  }
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!r || r.code !== 0) return null
  const root = r.stdout.trim()
  return root || null
}

/**
 * 工作区变更短列表（git status --porcelain）。
 */
export async function listGitStatus(cwd: string): Promise<GitStatusEntry[] | null> {
  const root = await findGitRoot(cwd)
  if (!root) return null
  const r = await runGit(root, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-uall',
  ])
  if (!r || r.code !== 0) return null
  const out: GitStatusEntry[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    let p = line.slice(3)
    // rename: "R  a -> b"
    if (p.includes(' -> ')) {
      p = p.split(' -> ').pop()!.trim()
    }
    p = p.replace(/^"|"$/g, '').trim()
    if (!p) continue
    out.push({ path: p, code })
  }
  return out
}

/**
 * 单文件相对 HEAD 的 diff；untracked 合成 full-add。
 */
export async function fetchSingleFileGitDiff(
  cwd: string,
  filePath: string,
): Promise<GitFileDiff | null> {
  const root = await findGitRoot(cwd)
  if (!root) return null
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath)
  let rel = path.relative(root, abs).split(path.sep).join('/')
  if (rel.startsWith('..')) {
    // 也可能是相对 git root 的路径
    rel = filePath.replace(/\\/g, '/')
  }

  const ls = await runGit(root, [
    '--no-optional-locks',
    'ls-files',
    '--error-unmatch',
    rel,
  ])
  const tracked = !!(ls && ls.code === 0)

  if (tracked) {
    const r = await runGit(root, [
      '--no-optional-locks',
      'diff',
      'HEAD',
      '--',
      rel,
    ])
    if (!r) return null
    // 无 diff 输出 = 与 HEAD 相同
    if (!r.stdout.trim()) {
      return {
        path: rel,
        status: 'modified',
        added: 0,
        removed: 0,
        patch: '',
      }
    }
    return parseUnifiedToGitFileDiff(rel, r.stdout, 'modified')
  }

  // untracked
  try {
    const content = await fs.readFile(abs, 'utf8')
    const hunks = diffHunksFromFullReplace('', content)
    const { added, removed } = countHunkLines(hunks)
    const patch = formatUnifiedDiff(rel, hunks, { maxLines: 200, maxChars: 20_000 })
    return {
      path: rel,
      status: 'added',
      added,
      removed,
      patch,
    }
  } catch {
    return null
  }
}

function parseUnifiedToGitFileDiff(
  filename: string,
  rawDiff: string,
  status: GitFileDiff['status'],
): GitFileDiff {
  const lines = rawDiff.split(/\r?\n/)
  const patchLines: string[] = []
  let inHunks = false
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.startsWith('@@')) inHunks = true
    if (inHunks) {
      patchLines.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
  }
  return {
    path: filename,
    status,
    added: additions,
    removed: deletions,
    patch: patchLines.join('\n'),
  }
}

export function formatGitStatusSlash(
  entries: GitStatusEntry[] | null,
): string {
  if (entries == null) {
    return 'Not a git repository (or git unavailable).'
  }
  if (!entries.length) {
    return 'Git working tree clean (no porcelain changes).'
  }
  const lines = [`Git status: ${entries.length} path(s)`]
  for (const e of entries.slice(0, 80)) {
    lines.push(`  ${e.code} ${e.path}`)
  }
  if (entries.length > 80) lines.push(`  …(+${entries.length - 80} more)`)
  lines.push('Tip: /diff git <path>')
  return lines.join('\n')
}

export function formatGitFileDiffSlash(d: GitFileDiff | null, pathHint: string): string {
  if (!d) {
    return `No git diff for ${pathHint} (missing, clean, or not a repo).`
  }
  const head = `${d.status} ${d.path}  +${d.added}/-${d.removed}`
  if (!d.patch) return head
  return `${head}\n${d.patch}`
}