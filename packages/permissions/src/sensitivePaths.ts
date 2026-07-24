/**
 * 敏感路径检查（Y3）
 * 对照 HC filesystem.checkPathSafetyForAutoEdit 最小子集；无遥测。
 */

import path from 'node:path'

/** 路径段或文件名命中则视为敏感（auto 下 edit 不快路径 allow） */
const SENSITIVE_BASENAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.gitconfig',
  '.gitmodules',
  '.env',
  '.env.local',
  '.env.production',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'authorized_keys',
  'known_hosts',
  'credentials',
  'secrets.json',
  'service-account.json',
])

const SENSITIVE_SEGMENTS = [
  `${path.sep}.ssh${path.sep}`,
  `${path.sep}.gnupg${path.sep}`,
  `${path.sep}.aws${path.sep}`,
  `${path.sep}.kube${path.sep}`,
  `${path.sep}.docker${path.sep}`,
  `${path.sep}.git${path.sep}`,
]

export type SensitivePathResult =
  | { sensitive: false }
  | { sensitive: true; reason: string; /** true = 仍可走分类器；false = 硬 deny */ hardDeny: boolean }

/**
 * 规范化后检查敏感路径。
 * - .ssh 私钥等 → hardDeny（auto 下也不给分类器放行）
 * - .env / .git 配置等 → 不快路径 allow，可交分类器
 */
export function checkSensitivePath(
  filePath: string,
  cwd?: string,
): SensitivePathResult {
  const raw = filePath.trim()
  if (!raw) return { sensitive: false }

  let resolved = raw
  try {
    resolved = path.isAbsolute(raw)
      ? path.normalize(raw)
      : path.normalize(path.join(cwd ?? process.cwd(), raw))
  } catch {
    resolved = raw
  }

  const lower = resolved.replace(/\\/g, '/').toLowerCase()
  const base = path.basename(resolved).toLowerCase()

  // 硬 deny：私钥类
  if (
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    base === 'id_ecdsa' ||
    base.endsWith('.pem') ||
    base === 'authorized_keys'
  ) {
    return {
      sensitive: true,
      reason: `sensitive key/credential path: ${base}`,
      hardDeny: true,
    }
  }
  if (lower.includes('/.ssh/') || lower.endsWith('/.ssh')) {
    return {
      sensitive: true,
      reason: 'path under .ssh',
      hardDeny: true,
    }
  }

  if (SENSITIVE_BASENAMES.has(base)) {
    return {
      sensitive: true,
      reason: `sensitive file: ${base}`,
      hardDeny: false,
    }
  }

  const withSeps = `${path.sep}${resolved}${path.sep}`
  for (const seg of SENSITIVE_SEGMENTS) {
    if (withSeps.includes(seg) || resolved.includes(seg)) {
      return {
        sensitive: true,
        reason: `sensitive directory segment`,
        hardDeny: false,
      }
    }
  }

  // Windows user profile secrets (minimal)
  if (/[\\/]AppData[\\/]Roaming[\\/]/i.test(resolved)) {
    return {
      sensitive: true,
      reason: 'path under AppData/Roaming',
      hardDeny: false,
    }
  }

  return { sensitive: false }
}