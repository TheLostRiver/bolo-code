/**
 * F-SA-WORKTREE：git worktree 隔离最小（可关；失败回落同 cwd）
 * 无遥测。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'

export type WorktreeResult =
  | { ok: true; cwd: string; path: string; created: boolean }
  | { ok: false; cwd: string; reason: string }

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    child.on('error', (e) => {
      resolve({ code: 1, stdout, stderr: e.message })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

export function isWorktreeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.BOLO_SUBAGENT_WORKTREE?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * 尝试在 repo 下创建 `../.bolo-worktrees/<id>` worktree。
 * 未启用 / 非 git / 失败 → ok:false，cwd 仍为 parentCwd。
 */
export async function tryCreateSubagentWorktree(opts: {
  parentCwd: string
  agentId: string
  env?: NodeJS.ProcessEnv
  /** 测试注入 */
  force?: boolean
}): Promise<WorktreeResult> {
  const env = opts.env ?? process.env
  const parentCwd = path.resolve(opts.parentCwd)
  if (!opts.force && !isWorktreeEnabled(env)) {
    return {
      ok: false,
      cwd: parentCwd,
      reason: 'worktree disabled (set BOLO_SUBAGENT_WORKTREE=1)',
    }
  }

  const check = await run('git', ['rev-parse', '--is-inside-work-tree'], parentCwd)
  if (check.code !== 0 || !check.stdout.trim().includes('true')) {
    return { ok: false, cwd: parentCwd, reason: 'not a git work tree' }
  }

  const base = path.resolve(
    parentCwd,
    '..',
    '.bolo-worktrees',
    opts.agentId.replace(/[^\w.-]+/g, '_').slice(0, 48),
  )
  try {
    await fs.mkdir(path.dirname(base), { recursive: true })
  } catch {
    /* continue */
  }

  // 已存在则复用
  try {
    const st = await fs.stat(base)
    if (st.isDirectory()) {
      return { ok: true, cwd: base, path: base, created: false }
    }
  } catch {
    /* create */
  }

  const add = await run(
    'git',
    ['worktree', 'add', '--detach', base, 'HEAD'],
    parentCwd,
  )
  if (add.code !== 0) {
    return {
      ok: false,
      cwd: parentCwd,
      reason: `git worktree add failed: ${add.stderr.trim() || add.code}`,
    }
  }
  return { ok: true, cwd: base, path: base, created: true }
}

export async function removeSubagentWorktree(opts: {
  parentCwd: string
  worktreePath: string
}): Promise<void> {
  await run(
    'git',
    ['worktree', 'remove', '--force', opts.worktreePath],
    opts.parentCwd,
  ).catch(() => {})
  await fs.rm(opts.worktreePath, { recursive: true, force: true }).catch(() => {})
}

/** 测试用：临时目录伪装 worktree 根 */
export async function mkdtempWorktreeLabel(id: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `bolo-wt-${id}-`))
}