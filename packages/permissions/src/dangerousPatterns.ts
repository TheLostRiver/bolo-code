/**
 * 危险 shell 模式（Y3）
 * 对照 HC dangerousPatterns：过宽解释器 allow 与破坏性命令。
 * 用于 auto 门控硬 deny（不调用分类器）；无遥测。
 */

/** 命令中匹配则在 auto 下直接 deny 的正则（case-insensitive） */
export const DANGEROUS_BASH_COMMAND_PATTERNS: readonly RegExp[] = [
  // 磁盘 / 系统毁灭
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\s*$/i,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(\s|$)/i,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(\s|$)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(format|diskpart)\b/i,
  // 管道远程执行
  /\bcurl\b[^|\n]*\|\s*(ba)?sh\b/i,
  /\bwget\b[^|\n]*\|\s*(ba)?sh\b/i,
  /\bcurl\b[^|\n]*\|\s*python/i,
  // fork bomb
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  // 写 ssh authorized_keys 常见投毒
  />>\s*~\/\.ssh\/authorized_keys/i,
  />\s*~\/\.ssh\/authorized_keys/i,
  // 禁用防火墙等
  /\biptables\s+-F\b/i,
  /\bufw\s+disable\b/i,
]

/**
 * 若 always-allow 前缀会放行任意解释器代码，视为危险（strip 用，已在 stripDangerousAllows）
 */
export const DANGEROUS_BASH_ALLOW_PREFIXES: readonly string[] = [
  'python',
  'python3',
  'node',
  'deno',
  'npx',
  'bash',
  'sh',
  'zsh',
  'sudo',
  'eval',
  'exec',
  'curl',
  'wget',
  'ssh',
]

export function matchDangerousBashCommand(
  command: string,
): { matched: true; pattern: string } | { matched: false } {
  const cmd = command.trim()
  if (!cmd) return { matched: false }
  for (const re of DANGEROUS_BASH_COMMAND_PATTERNS) {
    if (re.test(cmd)) {
      return { matched: true, pattern: re.source }
    }
  }
  return { matched: false }
}

/**
 * always-allow bash 前缀是否过宽（解释器:）
 */
export function isDangerousBashAllowPrefix(prefix: string): boolean {
  const p = prefix.trim().toLowerCase().replace(/:\*$/, '').replace(/\*$/, '')
  if (!p || p === '*') return true
  return DANGEROUS_BASH_ALLOW_PREFIXES.some(
    (d) => p === d || p.startsWith(d + ' ') || p.startsWith(d + ':'),
  )
}