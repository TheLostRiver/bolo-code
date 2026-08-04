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

/** 解析 `git status --porcelain`（第一列状态 + 第二列暂存，路径按 ` -> ` 分离） */
export function parsePorcelain(output: string): WorktreeChange[] {
  const changes: WorktreeChange[] = []
  for (const raw of output.split('\n')) {
    if (!raw.trim()) continue
    const status = raw.slice(0, 2)
    let p = raw.slice(3)
    const rename = p.indexOf(' -> ')
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
  const raw = await runGit(cwd, ['status', '--porcelain'])
  const changes = parsePorcelain(raw)
  const ts = Date.now()
  const snapshot: WorktreeSnapshot = {
    id: `${ts}`,
    ts,
    changes,
  }
  const dir = snapshotsDir(cwd)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `${ts}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8')
  await fs.rename(tmp, path.join(dir, `${ts}.json`))
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
 * 恢复快照：tracked 修改/deleted → `git show HEAD:path` 写回；untracked →
 * 删除。失败的文件跳过（返回失败清单，不中断其余）。
 */
export async function restoreWorktreeSnapshot(
  cwd: string,
  snapshot: WorktreeSnapshot,
): Promise<{ restored: string[]; failed: string[] }> {
  const restored: string[] = []
  const failed: string[] = []
  for (const change of snapshot.changes) {
    try {
      if (change.status === 'untracked') {
        const target = path.resolve(cwd, change.path)
        if (target.startsWith(path.resolve(cwd) + path.sep)) {
          await fs.rm(target, { force: true })
        }
      } else {
        const content = await runGit(cwd, ['show', `HEAD:${change.path}`])
        const target = path.join(path.resolve(cwd), change.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, 'utf8')
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
