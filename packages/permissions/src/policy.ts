/**
 * F-Y5-SANDBOX / POLICY 最小：命令前缀策略 + 可选「假沙箱」环境标记
 * 无遥测、无远程 GrowthBook。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export type BoloPolicyFile = {
  version?: number
  /** 额外 always-deny bash 前缀 */
  denyBashPrefixes?: string[]
  /** 额外 always-allow bash 前缀 */
  allowBashPrefixes?: string[]
  /** 禁止的工具名 */
  denyTools?: string[]
  /** sandbox 偏好：仅标记，真正隔离平台相关 */
  sandbox?: 'off' | 'prefer' | 'require'
}

export async function loadBoloPolicyFile(
  filePath: string,
): Promise<BoloPolicyFile | null> {
  try {
    const raw = await fs.readFile(path.resolve(filePath), 'utf8')
    const o = JSON.parse(raw) as BoloPolicyFile
    if (!o || typeof o !== 'object') return null
    return o
  } catch {
    return null
  }
}

/**
 * 解析策略路径：BOLO_POLICY_FILE 或 <cwd>/.bolo/policy.json
 */
export async function resolveBoloPolicy(opts?: {
  cwd?: string
  env?: NodeJS.ProcessEnv
}): Promise<{ policy: BoloPolicyFile | null; path?: string }> {
  const env = opts?.env ?? process.env
  const explicit = env.BOLO_POLICY_FILE?.trim()
  if (explicit) {
    const policy = await loadBoloPolicyFile(explicit)
    return { policy, path: explicit }
  }
  const cwd = opts?.cwd ?? process.cwd()
  const p = path.join(cwd, '.bolo', 'policy.json')
  const policy = await loadBoloPolicyFile(p)
  return { policy, path: policy ? p : undefined }
}

export type SandboxMode = 'off' | 'prefer' | 'require'

export function resolveSandboxMode(
  env: NodeJS.ProcessEnv = process.env,
  policy?: BoloPolicyFile | null,
): SandboxMode {
  const e = env.BOLO_SANDBOX?.trim().toLowerCase()
  if (e === '1' || e === 'true' || e === 'prefer') return 'prefer'
  if (e === 'require' || e === 'strict') return 'require'
  if (e === '0' || e === 'false' || e === 'off') return 'off'
  if (policy?.sandbox) return policy.sandbox
  return 'off'
}

/**
 * 为 Bash 环境注入沙箱标记（最小：变量提示，非 OS container）。
 * require 且无法隔离时由调用方决定是否拒绝。
 */
export function applySandboxEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  mode: SandboxMode,
): { env: NodeJS.ProcessEnv; isolated: boolean; warning?: string } {
  const env = { ...(baseEnv ?? process.env) }
  if (mode === 'off') {
    return { env, isolated: false }
  }
  env.BOLO_SANDBOX_ACTIVE = '1'
  env.BOLO_SANDBOX_MODE = mode
  // 最小：无真正 namespace；标记 isolated=false 但 prefer 仍放行
  if (mode === 'require') {
    return {
      env,
      isolated: false,
      warning:
        'sandbox require requested but OS isolation not implemented; commands run unsandboxed with BOLO_SANDBOX_ACTIVE=1',
    }
  }
  return {
    env,
    isolated: false,
    warning: 'sandbox prefer: marker only (no OS isolation in this build)',
  }
}

export function mergePolicyDenyPrefixes(
  existing: string[] | undefined,
  policy: BoloPolicyFile | null | undefined,
): string[] {
  const out = [...(existing ?? [])]
  for (const p of policy?.denyBashPrefixes ?? []) {
    const t = p.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}