/**
 * WT-1 · worktree 快照/GC/池化
 *
 * 覆盖：
 * - parsePorcelain 解析（modified/deleted/untracked）
 * - 快照创建（tracked 修改 + untracked 记录 + 落盘）
 * - 恢复（tracked 回 HEAD 内容 + untracked 删除）
 * - GC（maxCount/maxAge 清理）
 * - /worktree 命令（snapshot/restore/list/gc）
 * - 崩溃残留检测（createSession warning）
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parsePorcelain,
  createWorktreeSnapshot,
  listSnapshots,
  restoreWorktreeSnapshot,
  gcSnapshots,
} from '../packages/core/src/worktreeSnapshot.ts'
import {
  createSession,
  dispatchSlashCommand,
} from '../packages/core/src/index.ts'

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

async function makeRepo(name: string): Promise<string> {
  const repo = path.join(os.tmpdir(), `bolo-wt-${name}-${Date.now()}`)
  await fs.mkdir(repo, { recursive: true })
  await runGit(repo, ['init'])
  await runGit(repo, ['config', 'user.email', 't@t.t'])
  await runGit(repo, ['config', 'user.name', 't'])
  await fs.writeFile(path.join(repo, 'base.txt'), 'base content\n', 'utf8')
  await runGit(repo, ['add', '.'])
  await runGit(repo, ['commit', '-m', 'init'])
  return repo
}

// --- 1. parsePorcelain ---
{
  const out = [
    ' M src/a.ts',
    'D  src/b.ts',
    '?? untracked.txt',
    'R  old.txt -> new.txt',
  ].join('\n')
  const changes = parsePorcelain(out)
  assert.equal(changes.length, 4, 'four changes parsed')
  assert.deepEqual(
    changes.map((c) => `${c.status}:${c.path}`),
    [
      'modified:src/a.ts',
      'deleted:src/b.ts',
      'untracked:untracked.txt',
      'modified:new.txt',
    ],
    'status/path parsed',
  )
}

// --- 2. 快照创建 + 3. 恢复 ---
{
  const repo = await makeRepo('snap')
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  try {
    // 修改 tracked + 新增 untracked
    await fs.writeFile(path.join(repo, 'base.txt'), 'modified content\n', 'utf8')
    await fs.writeFile(path.join(repo, 'extra.txt'), 'untracked data\n', 'utf8')
    const snap = await createWorktreeSnapshot(repo)
    assert.equal(snap.changes.length, 2, 'snapshot records modified + untracked')
    const listed = await listSnapshots(repo)
    assert.equal(listed.length, 1, 'snapshot persisted')
    // 恢复：tracked 回 HEAD、untracked 删除
    const { restored, failed } = await restoreWorktreeSnapshot(repo, snap)
    assert.equal(failed.length, 0, 'restore no failures')
    assert.equal(restored.length, 2, 'both files restored')
    const baseContent = await fs.readFile(path.join(repo, 'base.txt'), 'utf8')
    assert.equal(baseContent, 'base content\n', 'tracked file reverted to HEAD')
    assert(
      !(await fs.stat(path.join(repo, 'extra.txt')).catch(() => null)),
      'untracked file removed',
    )
    await fs.rm(path.join(os.tmpdir(), `bolo-wt-home-${Date.now() - 1}`), { recursive: true, force: true }).catch(() => {})
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

// --- 4. GC：maxCount / maxAge ---
{
  const repo = await makeRepo('gc')
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  try {
    for (let i = 0; i < 3; i += 1) {
      await createWorktreeSnapshot(repo)
      await new Promise((r) => setTimeout(r, 10))
    }
    const removed = await gcSnapshots(repo, { maxCount: 2 })
    assert.equal(removed, 1, 'gc removes over-count snapshot')
    const snaps = await listSnapshots(repo)
    assert.equal(snaps.length, 2, 'two snapshots retained')
    // maxAge
    const snapsDir = path.join(
      process.env.BOLO_CONFIG_DIR!,
      'snapshots',
      (await fs.readdir(path.join(process.env.BOLO_CONFIG_DIR!, 'snapshots')))[0]!,
    )
    const snapFiles = await fs.readdir(snapsDir)
    const old = snaps[0]!
    await fs.writeFile(
      path.join(snapsDir, snapFiles[0]!),
      JSON.stringify({ ...old, ts: Date.now() - 10 * 24 * 60 * 60 * 1_000 }),
      'utf8',
    )
    const removedAge = await gcSnapshots(repo, { maxAgeMs: 7 * 24 * 60 * 60 * 1_000 })
    assert.equal(removedAge, 1, 'gc removes expired snapshot')
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

// --- 5. /worktree 命令 ---
{
  const repo = await makeRepo('slash')
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  try {
    await fs.writeFile(path.join(repo, 'base.txt'), 'changed\n', 'utf8')
    const session = await createSession({
      cwd: repo,
      systemPrompt: false,
      provider: {
        id: 'mock',
        async *completeStream() {
          yield { type: 'text_delta', text: 'ok' }
          yield { type: 'done' }
        },
      },
    })
    const snap = await dispatchSlashCommand(session, 'worktree', 'snapshot')
    assert(snap.ok === true && snap.message.includes('1 change'), 'snapshot command')
    const list = await dispatchSlashCommand(session, 'worktree', 'list')
    assert(list.ok === true && list.message.includes('snapshot'), 'list command')
    const restore = await dispatchSlashCommand(session, 'worktree', 'restore')
    assert(restore.ok === true && restore.message.includes('restored 1'), 'restore command')
    const baseContent = await fs.readFile(path.join(repo, 'base.txt'), 'utf8')
    assert.equal(baseContent, 'base content\n', 'slash restore reverts file')
    const gc = await dispatchSlashCommand(session, 'worktree', 'gc')
    assert(gc.ok === true, 'gc command')
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

// --- 6. 崩溃残留检测（createSession warning）---
{
  const repo = await makeRepo('crash')
  const prevHome = process.env.BOLO_CONFIG_DIR
  const home = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  process.env.BOLO_CONFIG_DIR = home
  try {
    await fs.writeFile(path.join(repo, 'base.txt'), 'dirty\n', 'utf8')
    await createWorktreeSnapshot(repo)
    const warnings: string[] = []
    const session = await createSession({
      cwd: repo,
      systemPrompt: false,
      provider: {
        id: 'mock',
        async *completeStream() {
          yield { type: 'text_delta', text: 'ok' }
          yield { type: 'done' }
        },
      },
      onEvent: (e) => {
        if (e.type === 'warning') warnings.push(e.message)
      },
    })
    assert(
      warnings.some((w) => w.includes('unrecovered snapshot')),
      'crash residue warning emitted',
    )
    void session
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

console.log('PASS: WT-1 worktree snapshot / restore / gc')
