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
   * sse：流意外断开后自动重连次数（默认 0 = 不重连）。
   * 上限 10；仅经典 SSE GET 流。
   */
  reconnectAttempts?: number
  /**
   * sse：重连基础延迟 ms（默认 1000；指数退避 × attempt）。
   */
  reconnectDelayMs?: number
  /**
   * 声明式工具列表（仅无真连接 / 失败回退时用；真连接以 listTools 为准）
   * @deprecated 优先 listTools
   */
  tools?: { name: string; description?: string }[]
  /**
   * 只注册这些工具（白名单）。缺省 = server 列出什么就要什么。
   *
   * 存在的理由是实测出来的：一个 server 往往一次带进来好几个工具，
   * 其中可能有用户并没打算启用的能力。典型例子——启用「搜索」时
   * 搭着进来一个**远程抓取**工具，模型转头就用它替代了本地抓取，
   * 于是用户的抓取请求也一并出了机器。用户得有办法只要其中一部分。
   */
  allowTools?: string[]
  /** 排除这些工具。与 allowTools 同时配时**更严的一方胜出**（先 allow 再 exclude）。 */
  excludeTools?: string[]
  /**
   * M-GEN-8：配置来源（诊断 / 合并）。
   * user | project | plugin — 不参与协议 wire。
   */
  scope?: 'user' | 'project' | 'plugin'
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