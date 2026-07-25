/**
 * OS 级 Bash 包装（对照 HC sandbox 语义的最小自研实现）
 * - Linux: bubblewrap (bwrap) 若可用
 * - macOS: sandbox-exec + 临时 seatbelt profile
 * - Windows / 无工具: 不可用（prefer 降级，require 可 fail-closed）
 * 无遥测、无 @anthropic-ai/sandbox-runtime 依赖。
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export type OsSandboxKind = 'none' | 'bwrap' | 'sandbox-exec'

export type OsSandboxPlan = {
  kind: OsSandboxKind
  /** 实际 execFile 的可执行文件 */
  file: string
  /** 参数（含用户命令） */
  args: string[]
  /** 是否真正隔离 */
  isolated: boolean
  warning?: string
  /** sandbox-exec 临时 profile 路径，调用后应删除 */
  cleanupPath?: string
}

function hasBin(name: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [name], { stdio: 'ignore' })
    } else {
      execFileSync('which', [name], { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

export function detectOsSandboxKind(
  platform: NodeJS.Platform = process.platform,
): OsSandboxKind {
  if (platform === 'linux' && hasBin('bwrap')) return 'bwrap'
  if (platform === 'darwin' && hasBin('sandbox-exec')) return 'sandbox-exec'
  return 'none'
}

/**
 * 规划沙箱命令。mode=off 时直接 shell -c。
 */
export async function planSandboxedShell(opts: {
  command: string
  cwd: string
  mode: 'off' | 'prefer' | 'require'
  platform?: NodeJS.Platform
}): Promise<OsSandboxPlan> {
  const platform = opts.platform ?? process.platform
  const cwd = path.resolve(opts.cwd)
  const shell = platform === 'win32' ? 'cmd.exe' : 'sh'
  const shellArgs =
    platform === 'win32' ? ['/c', opts.command] : ['-c', opts.command]

  if (opts.mode === 'off') {
    return {
      kind: 'none',
      file: shell,
      args: shellArgs,
      isolated: false,
    }
  }

  const kind = detectOsSandboxKind(platform)

  if (kind === 'bwrap') {
    // 最小 bwrap：只读系统 + 可写 cwd/tmp/home 临时
    const args = [
      '--ro-bind',
      '/',
      '/',
      '--bind',
      cwd,
      cwd,
      '--bind',
      '/tmp',
      '/tmp',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--chdir',
      cwd,
      '--die-with-parent',
      '--',
      'sh',
      '-c',
      opts.command,
    ]
    return {
      kind: 'bwrap',
      file: 'bwrap',
      args,
      isolated: true,
    }
  }

  if (kind === 'sandbox-exec') {
    const profile = `
(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow file-read*)
(allow file-write* (subpath "${cwd.replace(/\\/g, '\\\\')}"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "${os.homedir().replace(/\\/g, '\\\\')}/.bolo"))
(allow network* )
(allow mach-lookup)
`.trim()
    const profilePath = path.join(
      os.tmpdir(),
      `bolo-sb-${randomBytes(6).toString('hex')}.sb`,
    )
    await fs.writeFile(profilePath, profile, 'utf8')
    return {
      kind: 'sandbox-exec',
      file: 'sandbox-exec',
      args: ['-f', profilePath, 'sh', '-c', opts.command],
      isolated: true,
      cleanupPath: profilePath,
    }
  }

  // 不可用
  const warning =
    platform === 'win32'
      ? 'OS sandbox not available on Windows in this build (marker-only)'
      : platform === 'linux'
        ? 'bwrap not found; install bubblewrap for OS sandbox'
        : 'sandbox-exec not found; OS sandbox unavailable'

  if (opts.mode === 'require') {
    return {
      kind: 'none',
      file: shell,
      args: shellArgs,
      isolated: false,
      warning,
    }
  }

  // prefer: 降级无包装
  return {
    kind: 'none',
    file: shell,
    args: shellArgs,
    isolated: false,
    warning: `${warning}; running unsandboxed (prefer)`,
  }
}

export async function cleanupOsSandboxPlan(
  plan: OsSandboxPlan,
): Promise<void> {
  if (plan.cleanupPath) {
    await fs.unlink(plan.cleanupPath).catch(() => {})
  }
}