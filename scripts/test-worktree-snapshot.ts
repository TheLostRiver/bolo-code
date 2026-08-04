/**
 * WT-1 · worktree 快照/GC/池化
 *
 * 覆盖：
 * - parsePorcelainZ 解析（modified/deleted/untracked/rename 成对）
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
  parsePorcelainZ,
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

// --- 1. parsePorcelainZ ---
{
  const out =
    ' M src/a.ts\u0000' + 'D  src/b.ts\u0000' + '?? untracked.txt\u0000'
  const changes = parsePorcelainZ(out)
  assert.equal(changes.length, 3, 'three changes parsed')
  assert.deepEqual(
    changes.map((c) => `${c.status}:${c.path}`),
    [
      'modified:src/a.ts',
      'deleted:src/b.ts',
      'untracked:untracked.txt',
    ],
    'status/path parsed',
  )
  // rename：两条 NUL 记录（`R  dest\0source\0`——目标在前）——记录为
  // renamed（含源）；恢复 = HEAD 写回源 + 删目标
  const renamed = parsePorcelainZ('R  new.txt\u0000old.txt\u0000')
  assert.deepEqual(
    renamed.map((c) => `${c.status}:${c.path}<-${c.from ?? ''}`),
    ['renamed:new.txt<-old.txt'],
    'rename recorded with source path',
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

// --- 7. blocking 修复：binary round-trip / 非 ASCII 路径 / untracked 目录 ---
{
  const repo = await makeRepo('blocking')
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  try {
    // binary 文件（含 \0 字节）
    const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x00, 0x42])
    await fs.writeFile(path.join(repo, 'bin.dat'), binary)
    await runGit(repo, ['add', 'bin.dat'])
    await runGit(repo, ['commit', '-m', 'binary'])
    await fs.writeFile(path.join(repo, 'bin.dat'), Buffer.from([0xff, 0x00]))
    // 非 ASCII 路径
    await fs.writeFile(path.join(repo, '中文.txt'), '中文字符内容\n', 'utf8')
    // untracked 目录（非空）
    await fs.mkdir(path.join(repo, 'build'), { recursive: true })
    await fs.writeFile(path.join(repo, 'build', 'out.txt'), 'x', 'utf8')
    const snap = await createWorktreeSnapshot(repo)
    const paths = snap.changes.map((c) => c.path)
    assert(paths.includes('中文.txt'), 'non-ASCII path recorded')
    assert(paths.includes('build'), 'untracked dir recorded')
    const { restored, failed } = await restoreWorktreeSnapshot(repo, snap)
    assert.equal(failed.length, 0, `restore no failures (${failed.join(',')})`)
    assert.equal(restored.length, 3, 'all three changes restored')
    // binary round-trip：恢复后与 HEAD 版本逐字节一致
    const after = await fs.readFile(path.join(repo, 'bin.dat'))
    assert(after.equals(binary), 'binary file restored byte-exact')
    assert(
      !(await fs.stat(path.join(repo, '中文.txt')).catch(() => null)),
      'non-ASCII untracked removed',
    )
    assert(
      !(await fs.stat(path.join(repo, 'build')).catch(() => null)),
      'untracked dir removed recursively',
    )
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

// --- 8. staged-add 恢复（目标不在 HEAD → 删除）---
{
  const repo = await makeRepo('staged')
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  try {
    await fs.writeFile(path.join(repo, 'new.txt'), 'staged content\n', 'utf8')
    await runGit(repo, ['add', 'new.txt'])
    const snap = await createWorktreeSnapshot(repo)
    assert(
      snap.changes.some((c) => c.path === 'new.txt' && c.status === 'untracked'),
      'staged-add treated as untracked (baseline delete)',
    )
    const { failed } = await restoreWorktreeSnapshot(repo, snap)
    assert.equal(failed.length, 0, 'staged restore ok')
    assert(
      !(await fs.stat(path.join(repo, 'new.txt')).catch(() => null)),
      'staged-add file removed on restore',
    )
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

// --- 9. 遍历守卫：恶意快照路径拒绝（modified + renamed from）---
{
  const repo = await makeRepo('guard')
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  try {
    const { failed } = await restoreWorktreeSnapshot(repo, {
      id: 'evil',
      ts: 0,
      changes: [{ path: '../outside.txt', status: 'modified' }],
    })
    assert.deepEqual(failed, ['../outside.txt'], 'traversal path rejected')
    assert(
      !(await fs.stat(path.join(os.tmpdir(), 'outside.txt')).catch(() => null)),
      'no file written outside repo',
    )
    // renamed 的 from（源路径）同样拒绝
    const renamed = await restoreWorktreeSnapshot(repo, {
      id: 'evil2',
      ts: 0,
      changes: [
        { path: 'dest.txt', status: 'renamed', from: '../outside-src.txt' },
      ],
    })
    assert.deepEqual(renamed.failed, ['dest.txt'], 'renamed from rejected')
    assert(
      !(await fs.stat(path.join(os.tmpdir(), 'outside-src.txt')).catch(() => null)),
      'no renamed source written outside repo',
    )
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

// --- 8b. rename（git mv）：目标映射为基线删除，恢复不误删源 ---
{
  const repo = await makeRepo('rename')
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(os.tmpdir(), `bolo-wt-home-${Date.now()}`)
  try {
    await fs.writeFile(path.join(repo, 'old.txt'), 'rename me\n', 'utf8')
    await runGit(repo, ['add', 'old.txt'])
    await runGit(repo, ['commit', '-m', 'old'])
    await runGit(repo, ['mv', 'old.txt', 'new.txt'])
    const snap = await createWorktreeSnapshot(repo)
    assert.deepEqual(
      snap.changes.map((c) => `${c.status}:${c.path}`),
      ['renamed:new.txt'],
      'rename dest recorded (source in from field)',
    )
    const { failed } = await restoreWorktreeSnapshot(repo, snap)
    assert.equal(failed.length, 0, 'rename restore ok')
    assert(
      !(await fs.stat(path.join(repo, 'new.txt')).catch(() => null)),
      'rename dest removed on restore',
    )
    assert(
      await fs.stat(path.join(repo, 'old.txt')).catch(() => null),
      'rename source preserved (HEAD file untouched)',
    )
    const oldContent = await fs.readFile(path.join(repo, 'old.txt'), 'utf8')
    assert.equal(oldContent, 'rename me\n', 'rename source restored from HEAD')
    void prevHome
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  }
}

console.log('PASS: WT-1 worktree snapshot / restore / gc')
