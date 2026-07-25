/**
 * F-SA-WORKTREE：git worktree 隔离（可关；失败 fail-closed；dirty 成果保留）
 * 无遥测。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'

export type WorktreeResult =
  | { ok: true; cwd: string; path: string; created: boolean }
  | { ok: false; cwd: string; reason: string }

export type WorktreeCleanupResult =
  | {
      status: 'removed'
      path: string
      dirty: false
    }
  | {
      status: 'retained'
      path: string
      dirty?: boolean
      reason: string
    }

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

function gitReportedPath(cwd: string, value: string): string {
  return path.resolve(cwd, value.trim())
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
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

  const topLevel = await run('git', ['rev-parse', '--show-toplevel'], parentCwd)
  const commonDir = await run(
    'git',
    ['rev-parse', '--git-common-dir'],
    parentCwd,
  )
  if (
    topLevel.code !== 0 ||
    !topLevel.stdout.trim() ||
    commonDir.code !== 0 ||
    !commonDir.stdout.trim()
  ) {
    return { ok: false, cwd: parentCwd, reason: 'not a git work tree' }
  }
  const repoRoot = gitReportedPath(parentCwd, topLevel.stdout)
  const parentCommonDir = gitReportedPath(parentCwd, commonDir.stdout)

  const safeAgentId =
    opts.agentId.replace(/[^\w.-]+/g, '_').slice(0, 48) || 'agent'
  const base = path.resolve(
    repoRoot,
    '..',
    '.bolo-worktrees',
    safeAgentId,
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
      const existingTop = await run(
        'git',
        ['rev-parse', '--show-toplevel'],
        base,
      )
      const existingCommon = await run(
        'git',
        ['rev-parse', '--git-common-dir'],
        base,
      )
      if (
        existingTop.code === 0 &&
        existingTop.stdout.trim() &&
        existingCommon.code === 0 &&
        existingCommon.stdout.trim() &&
        samePath(gitReportedPath(base, existingTop.stdout), base) &&
        samePath(
          gitReportedPath(base, existingCommon.stdout),
          parentCommonDir,
        )
      ) {
        return { ok: true, cwd: base, path: base, created: false }
      }
      return {
        ok: false,
        cwd: parentCwd,
        reason: `worktree target exists but is not an isolated worktree for this repository: ${base}`,
      }
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
}): Promise<WorktreeCleanupResult> {
  const parentCwd = path.resolve(opts.parentCwd)
  const worktreePath = path.resolve(opts.worktreePath)
  if (worktreePath === parentCwd) {
    return {
      status: 'retained',
      path: worktreePath,
      reason: 'refused to remove parent working directory',
    }
  }

  const status = await run(
    'git',
    [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
    ],
    worktreePath,
  )
  if (status.code !== 0) {
    return {
      status: 'retained',
      path: worktreePath,
      reason: `cannot verify worktree status: ${status.stderr.trim() || status.code}`,
    }
  }
  if (status.stdout.trim()) {
    return {
      status: 'retained',
      path: worktreePath,
      dirty: true,
      reason: 'worktree has modified, untracked, or ignored files',
    }
  }

  const removed = await run(
    'git',
    ['worktree', 'remove', worktreePath],
    parentCwd,
  )
  if (removed.code !== 0) {
    return {
      status: 'retained',
      path: worktreePath,
      dirty: false,
      reason: `git worktree remove failed: ${removed.stderr.trim() || removed.code}`,
    }
  }

  try {
    await fs.stat(worktreePath)
    return {
      status: 'retained',
      path: worktreePath,
      dirty: false,
      reason: 'git removed the worktree registration but the directory remains',
    }
  } catch {
    return {
      status: 'removed',
      path: worktreePath,
      dirty: false,
    }
  }
}

/** 测试用：临时目录伪装 worktree 根 */
export async function mkdtempWorktreeLabel(id: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `bolo-wt-${id}-`))
}
