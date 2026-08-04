/**
 * WT-1 · worktree 快照/GC
 *
 * 任务执行期间临时修改崩溃/中断后不污染项目：快照 worktree 变更清单
 * （git status 解析——tracked 修改/deleted + untracked），恢复时以 HEAD
 * 为基线写回/清理；GC 按龄/数上限清理旧快照。
 *
 * 全部本地 git 命令（execFile，无 shell）；存储 `~/.bolo/snapshots/<repoKey>/`。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getBoloHomeDir } from '../../config/src/paths.ts'

export type WorktreeChange = {
  path: string
  status: 'modified' | 'deleted' | 'untracked'
}

export type WorktreeSnapshot = {
  id: string
  ts: number
  changes: WorktreeChange[]
}

/** GC 默认：快照保留 7 天 / 最多 20 个 */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const SNAPSHOT_MAX_COUNT = 20

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(new Error(`git ${args[0]} failed: ${String(err)}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** git show（二进制安全：Buffer 直出） */
function runGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        if (err) {
          reject(new Error(`git ${args[0]} failed: ${String(err)}`))
          return
        }
        resolve(stdout as Buffer)
      },
    )
  })
}

function repoKey(cwd: string): string {
  let h = 0
  const s = path.resolve(cwd)
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `repo${h >>> 0}`
}

export function snapshotsDir(cwd: string): string {
  return path.join(getBoloHomeDir(), 'snapshots', repoKey(cwd))
}

/** 解析 `git status --porcelain -z`（NUL 分隔记录；记录 = `XY<SP>path`） */
export function parsePorcelainZ(output: string): WorktreeChange[] {
  const changes: WorktreeChange[] = []
  for (const rec of output.split('\0').filter(Boolean)) {
    const status = rec.slice(0, 2)
    const p = rec.slice(3)
    if (status === '??') {
      // untracked 目录带尾斜杠（`?? build/`）——归一化去尾斜杠
      changes.push({ path: p.replace(/\/+$/, ''), status: 'untracked' })
    } else if (status[0] === 'A' || status[1] === 'A' || status[0] === 'R' || status[1] === 'R') {
      // staged-add / rename：目标不在 HEAD——恢复时删除（基线无该文件）
      changes.push({ path: p, status: 'untracked' })
    } else if (status.includes('D')) {
      changes.push({ path: p, status: 'deleted' })
    } else {
      changes.push({ path: p, status: 'modified' })
    }
  }
  return changes
}

/** 旧版解析（无 -z 时用；保留兼容）——含 rename 归并 */
export function parsePorcelain(output: string): WorktreeChange[] {
  const changes: WorktreeChange[] = []
  for (const raw of output.split('\n')) {
    if (!raw.trim()) continue
    const status = raw.slice(0, 2)
    let p = raw.slice(3)
    const rename = p.lastIndexOf(' -> ')
    if (rename >= 0) p = p.slice(rename + 4)
    if (p.startsWith('"') && p.endsWith('"')) {
      try {
        p = JSON.parse(p) as string
      } catch {
        /* 保持原样 */
      }
    }
    if (status === '??') {
      changes.push({ path: p, status: 'untracked' })
    } else if (status.includes('D')) {
      changes.push({ path: p, status: 'deleted' })
    } else {
      changes.push({ path: p, status: 'modified' })
    }
  }
  return changes
}

/** 创建快照（记录当前 worktree 变更清单；HEAD 为恢复基线） */
export async function createWorktreeSnapshot(cwd: string): Promise<WorktreeSnapshot> {
  const raw = await runGit(cwd, ['status', '--porcelain', '-z'])
  const changes = parsePorcelainZ(raw)
  const ts = Date.now()
  const id = `${ts}-${Math.random().toString(36).slice(2, 6)}`
  const snapshot: WorktreeSnapshot = {
    id,
    ts,
    changes,
  }
  const dir = snapshotsDir(cwd)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `${id}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8')
  await fs.rename(tmp, path.join(dir, `${id}.json`))
  return snapshot
}

/** 列出快照（按时间降序） */
export async function listSnapshots(cwd: string): Promise<WorktreeSnapshot[]> {
  const dir = snapshotsDir(cwd)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const snaps: WorktreeSnapshot[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      snaps.push(
        JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as WorktreeSnapshot,
      )
    } catch {
      /* 损坏快照跳过 */
    }
  }
  return snaps.sort((a, b) => b.ts - a.ts)
}

/**
 * 恢复快照：tracked 修改/deleted → `git show HEAD:path`（Buffer 二进制安全）
 * 写回；untracked（含 staged-add/rename 目标）→ 递归删除。路径逃逸校验
 * 两分支统一；守卫拒绝与失败记入 failed，不中断其余。
 */
export async function restoreWorktreeSnapshot(
  cwd: string,
  snapshot: WorktreeSnapshot,
): Promise<{ restored: string[]; failed: string[] }> {
  const restored: string[] = []
  const failed: string[] = []
  const repoRoot = path.resolve(cwd)
  const isInside = (p: string): boolean => {
    const target = path.resolve(repoRoot, p)
    return target === repoRoot || target.startsWith(repoRoot + path.sep)
  }
  for (const change of snapshot.changes) {
    try {
      if (!isInside(change.path)) {
        failed.push(change.path)
        continue
      }
      if (change.status === 'untracked') {
        const target = path.join(repoRoot, change.path)
        await fs.rm(target, { recursive: true, force: true })
      } else {
        // 二进制安全：Buffer 直出直写（utf8 解码会损毁二进制 blob）
        const content = await runGitBuffer(cwd, ['show', `HEAD:${change.path}`])
        const target = path.join(repoRoot, change.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content)
      }
      restored.push(change.path)
    } catch {
      failed.push(change.path)
    }
  }
  return { restored, failed }
}

/** GC：按龄/数上限清理（保留最新） */
export async function gcSnapshots(
  cwd: string,
  opts?: { maxAgeMs?: number; maxCount?: number; now?: () => number },
): Promise<number> {
  const maxAgeMs = opts?.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS
  const maxCount = opts?.maxCount ?? SNAPSHOT_MAX_COUNT
  const now = opts?.now ?? (() => Date.now())
  const snaps = await listSnapshots(cwd)
  const dir = snapshotsDir(cwd)
  let removed = 0
  for (const [index, snap] of snaps.entries()) {
    const expired = now() - snap.ts > maxAgeMs
    const overCount = index >= maxCount
    if (expired || overCount) {
      await fs.rm(path.join(dir, `${snap.id}.json`), { force: true })
      removed += 1
    }
  }
  return removed
}
