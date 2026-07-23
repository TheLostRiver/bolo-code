/**
 * MCP 配置与注册类型
 */

export type McpServerConfig = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /**
   * 声明式工具列表（仅无 stdio / 失败回退时用；真连接以 listTools 为准）
   * @deprecated 优先 stdio listTools
   */
  tools?: { name: string; description?: string }[]
}

export type McpToolRegistration = {
  name: string
  server: string
  tool: string
  description: string
  requiresPermission: boolean
  inputSchema?: Record<string, unknown>
}