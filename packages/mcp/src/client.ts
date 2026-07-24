/**
 * MCP client 抽象：stdio / http / sse 共用 host 路径
 * 无遥测；listTools/call · resources · prompts · list_changed 通知
 */

export type JsonRpcId = string | number

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type McpToolDef = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type McpCallResult = {
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>
  isError?: boolean
  [k: string]: unknown
}

/** server capabilities（initialize result） */
export type McpServerCapabilities = {
  tools?: Record<string, unknown>
  resources?: Record<string, unknown>
  prompts?: Record<string, unknown>
  [k: string]: unknown
}

export type McpResourceDef = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
  [k: string]: unknown
}

export type McpResourceContents = {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  [k: string]: unknown
}

export type McpPromptDef = {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
  [k: string]: unknown
}

export type McpPromptMessage = {
  role?: string
  content?:
    | { type?: string; text?: string; [k: string]: unknown }
    | Array<{ type?: string; text?: string; [k: string]: unknown }>
  [k: string]: unknown
}

export type McpGetPromptResult = {
  description?: string
  messages?: McpPromptMessage[]
  [k: string]: unknown
}

/** 服务端 → 客户端 JSON-RPC 通知（无 id） */
export type McpNotificationHandler = (
  method: string,
  params: unknown,
) => void | Promise<void>

/** MCP list_changed 通知 method（spec 名） */
export const MCP_TOOLS_LIST_CHANGED = 'notifications/tools/list_changed'
export const MCP_RESOURCES_LIST_CHANGED = 'notifications/resources/list_changed'
export const MCP_PROMPTS_LIST_CHANGED = 'notifications/prompts/list_changed'

export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const MCP_DEFAULT_TIMEOUT_MS = 15_000

/** host / meta 工具依赖的 client 面 */
export type McpClient = {
  readonly serverName: string
  /** 连接所用 transport（/mcp 展示） */
  readonly transport: 'stdio' | 'http' | 'sse'
  readonly isConnected: boolean
  readonly capabilities: McpServerCapabilities
  readonly supportsTools: boolean
  readonly supportsResources: boolean
  readonly supportsPrompts: boolean
  connect(): Promise<void>
  close(): Promise<void>
  onNotification(method: string, handler: McpNotificationHandler): () => void
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult>
  listResources(): Promise<McpResourceDef[]>
  readResource(uri: string): Promise<McpResourceContents[]>
  listPrompts(): Promise<McpPromptDef[]>
  getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<McpGetPromptResult>
}

export function formatMcpCallOutput(result: McpCallResult): string {
  if (Array.isArray(result.content)) {
    const parts = result.content
      .map((c) => {
        if (c && typeof c === 'object' && typeof c.text === 'string') return c.text
        return JSON.stringify(c)
      })
      .filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  return JSON.stringify(result)
}

/** resources/read 内容 → 模型可读文本（blob 只记 mime/长度，不灌 base64） */
export function formatMcpResourceContents(
  contents: McpResourceContents[],
): string {
  if (!contents.length) return '(empty resource)'
  const parts = contents.map((c) => {
    if (typeof c.text === 'string') {
      const head = c.mimeType ? `[${c.uri} ${c.mimeType}]\n` : `[${c.uri}]\n`
      return head + c.text
    }
    if (typeof c.blob === 'string') {
      return `[${c.uri}] binary blob (${c.mimeType ?? 'application/octet-stream'}, base64 len=${c.blob.length}) — not inlined`
    }
    return JSON.stringify(c)
  })
  return parts.join('\n\n')
}

/** prompts/get messages → 可读文本 */
export function formatMcpPromptResult(result: McpGetPromptResult): string {
  const lines: string[] = []
  if (result.description) lines.push(result.description)
  const messages = Array.isArray(result.messages) ? result.messages : []
  for (const m of messages) {
    const role = m.role ?? 'message'
    const content = m.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .map((c) =>
          c && typeof c === 'object' && typeof c.text === 'string'
            ? c.text
            : JSON.stringify(c),
        )
        .join('\n')
    } else if (content && typeof content === 'object') {
      text =
        typeof (content as { text?: string }).text === 'string'
          ? String((content as { text: string }).text)
          : JSON.stringify(content)
    }
    lines.push(`[${role}] ${text}`)
  }
  if (!lines.length) return JSON.stringify(result)
  return lines.join('\n')
}