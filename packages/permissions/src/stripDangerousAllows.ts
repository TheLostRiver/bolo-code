/**
 * 进入 auto 时剥离危险 always-allow（Y3 最小先做可测部分；Y1 进模也可调用）
 * 对照 HC permissionSetup 清洗语义；无遥测。
 */

import type { SessionPermissionRules } from './index.ts'

/** 视为「过宽」的工具名：auto 下若在 always-allow 则移除 */
const DANGEROUS_ALLOW_TOOL_NAMES = new Set(['Bash', 'Agent'])

/**
 * 就地清洗 rules：去掉 Bash/Agent 全工具 allow 与过宽 bash 模式。
 * @returns 被移除的说明列表
 */
export function stripDangerousAllowsForAuto(
  rules: SessionPermissionRules | null | undefined,
): string[] {
  if (!rules) return []
  const removed: string[] = []

  if (rules.alwaysAllowToolNames?.length) {
    const next = rules.alwaysAllowToolNames.filter((n) => {
      if (DANGEROUS_ALLOW_TOOL_NAMES.has(n)) {
        removed.push(`tool:${n}`)
        return false
      }
      return true
    })
    rules.alwaysAllowToolNames = next
  }

  if (rules.alwaysAllowBashPrefixes?.length) {
    const next = rules.alwaysAllowBashPrefixes.filter((p) => {
      const t = p.trim()
      // 空、*、仅 * 后缀过宽
      if (!t || t === '*' || t === ':*') {
        removed.push(`bash:${p}`)
        return false
      }
      return true
    })
    rules.alwaysAllowBashPrefixes = next
  }

  return removed
}