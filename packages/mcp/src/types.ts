/**
 * MCP 配置与注册类型
 * transport：stdio（本地进程）| http（Streamable HTTP）| sse（经典 SSE 长连接）
 */

/** 对照参考实现 transport 枚举的最小子集 */
export type McpTransportKind = 'stdio' | 'http' | 'sse'

export type McpServerConfig = {
  name: string
  /**
   * 传输类型。缺省推断：
   * - 有 `command` → stdio
   * - 有 `url` → http
   */
  type?: McpTransportKind
  /** stdio：可执行命令 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http / sse：远端 endpoint */
  url?: string
  /** http / sse：静态请求头（如 Authorization） */
  headers?: Record<string, string>
  /**
   * 声明式工具列表（仅无真连接 / 失败回退时用；真连接以 listTools 为准）
   * @deprecated 优先 listTools
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

/**
 * 解析配置应使用的 transport。
 * 规则：显式 type 优先；否则 url → http；command → stdio；否则 null。
 */
export function resolveMcpTransport(
  cfg: McpServerConfig,
): McpTransportKind | null {
  if (cfg.type === 'stdio' || cfg.type === 'http' || cfg.type === 'sse') {
    return cfg.type
  }
  if (typeof cfg.url === 'string' && cfg.url.trim()) return 'http'
  if (typeof cfg.command === 'string' && cfg.command.trim()) return 'stdio'
  return null
}