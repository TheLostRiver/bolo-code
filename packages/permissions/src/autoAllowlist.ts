/**
 * Auto 模式安全工具白名单（Y1）
 * 对照 HC classifierDecision 安全工具集语义；无遥测。
 */

/** 不需要分类器、auto 下直接 allow 的工具名 */
export const AUTO_ALLOWLIST_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Skill',
])

export function isAutoAllowlistedTool(toolName: string): boolean {
  if (!toolName) return false
  if (AUTO_ALLOWLIST_TOOLS.has(toolName)) return true
  // 只读类 MCP 不白名单（需分类或规则）
  return false
}