/**
 * MCP Streamable HTTP client（最小可用）
 * 语义对照参考实现 type:http + StreamableHTTP：POST JSON-RPC，可选 Mcp-Session-Id，
 * 响应可为 application/json 或 text/event-stream（SSE 帧内嵌 JSON-RPC）。
 * 无 OAuth / 无遥测；静态 headers 足够鉴权。
 */

import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallResult,
  type McpClient,
  type McpGetPromptResult,
  type McpNotificationHandler,
  type McpPromptDef,
  type McpResourceContents,
  type McpResourceDef,
  type McpServerCapabilities,
  type McpToolDef,
} from './client.ts'
import type { McpServerConfig } from './types.ts'

export type HttpClientOptions = {
  server: McpServerConfig
  timeoutMs?: number
  /** 覆盖/追加 headers（合并进 server.headers） */
  headers?: Record<string, string>
}

const ACCEPT =
  'application/json, text/event-stream'

/**
 * 解析 text/event-stream 正文：收集 data: 行，按空行分事件，JSON 解析。
 */
export function parseSseDataPayloads(body: string): object[] {
  const out: object[] = []
  const events = body.replace(/\r\n/g, '\n').split(/\n\n+/)
  for (const block of events) {
    if (!block.trim()) continue
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''))
      }
    }
    if (!dataLines.length) continue
    const payload = dataLines.join('\n').trim()
    if (!payload || payload === '[DONE]') continue
    try {
      out.push(JSON.parse(payload) as object)
    } catch {
      /* skip non-json event */
    }
  }
  return out
}

export class McpHttpClient implements McpClient {
  readonly serverName: string
  readonly transport = 'http' as const
  private readonly url: string
  private readonly staticHeaders: Record<string, string>
  private readonly timeoutMs: number
  private sessionId: string | undefined
  private closed = true
  private nextId = 1
  private _capabilities: McpServerCapabilities = {}
  private notificationHandlers = new Map<string, Set<McpNotificationHandler>>()

  constructor(opts: HttpClientOptions) {
    const url = opts.server.url?.trim()
    if (!url) {
      throw new Error(
        `MCP server "${opts.server.name}": http transport requires url`,
      )
    }
    this.serverName = opts.server.name
    this.url = url
    this.timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
    this.staticHeaders = {
      ...(opts.server.headers ?? {}),
      ...(opts.headers ?? {}),
    }
  }

  get isConnected(): boolean {
    return !this.closed
  }

  get capabilities(): McpServerCapabilities {
    return this._capabilities
  }

  get supportsTools(): boolean {
    return this._capabilities.tools != null
  }

  get supportsResources(): boolean {
    return this._capabilities.resources != null
  }

  get supportsPrompts(): boolean {
    return this._capabilities.prompts != null
  }

  onNotification(method: string, handler: McpNotificationHandler): () => void {
    let set = this.notificationHandlers.get(method)
    if (!set) {
      set = new Set()
      this.notificationHandlers.set(method, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
      if (set!.size === 0) this.notificationHandlers.delete(method)
    }
  }

  async connect(): Promise<void> {
    if (!this.closed && this._capabilities) {
      // 允许重入：已连则跳过
    }
    this.closed = false
    try {
      await this.initialize()
    } catch (e) {
      this.closed = true
      throw e
    }
  }

  private dispatchNotification(method: string, params: unknown) {
    const set = this.notificationHandlers.get(method)
    if (!set?.size) return
    for (const handler of [...set]) {
      try {
        const r = handler(method, params)
        if (r && typeof (r as Promise<void>).then === 'function') {
          void (r as Promise<void>).catch(() => {
            /* 通知 handler 失败不杀连接 */
          })
        }
      } catch {
        /* ignore */
      }
    }
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: ACCEPT,
      ...this.staticHeaders,
      ...(extra ?? {}),
    }
    if (this.sessionId) {
      h['mcp-session-id'] = this.sessionId
    }
    return h
  }

  /**
   * POST 一条 JSON-RPC；解析 JSON 或 SSE 响应；抽取同 id 的 result/error。
   * 顺带分发无 id 的通知（SSE 流内）。
   */
  private async postMessage(msg: object): Promise<JsonRpcResponse | null> {
    if (this.closed) {
      throw new Error(`MCP server "${this.serverName}" not connected`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(msg),
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(
          `MCP ${this.serverName} request timed out after ${this.timeoutMs}ms`,
        )
      }
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      clearTimeout(timer)
    }

    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(
        `MCP ${this.serverName} HTTP ${res.status}${t ? `: ${t.slice(0, 200)}` : ''}`,
      )
    }

    // 202 Accepted：仅通知，无 body
    if (res.status === 202) {
      return null
    }

    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    const text = await res.text()
    if (!text.trim()) return null

    const messages: object[] = []
    if (ct.includes('text/event-stream')) {
      messages.push(...parseSseDataPayloads(text))
    } else {
      try {
        const parsed = JSON.parse(text) as object | object[]
        if (Array.isArray(parsed)) messages.push(...parsed)
        else messages.push(parsed)
      } catch {
        throw new Error(
          `MCP ${this.serverName}: invalid JSON response (${ct || 'no content-type'})`,
        )
      }
    }

    const reqId =
      msg && typeof msg === 'object' && 'id' in msg
        ? (msg as { id?: unknown }).id
        : undefined

    let matched: JsonRpcResponse | null = null
    for (const m of messages) {
      const jr = m as JsonRpcResponse & { method?: string; params?: unknown }
      if (
        (jr.id === undefined || jr.id === null) &&
        typeof jr.method === 'string'
      ) {
        this.dispatchNotification(jr.method, jr.params)
        continue
      }
      if (reqId !== undefined && String(jr.id) === String(reqId)) {
        matched = jr
      }
    }
    return matched
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    const resp = await this.postMessage(req)
    if (!resp) {
      throw new Error(
        `MCP ${this.serverName} ${method}: empty response (no result)`,
      )
    }
    if (resp.error) {
      throw new Error(
        `MCP ${this.serverName} ${method}: ${resp.error.message} (${resp.error.code})`,
      )
    }
    return resp.result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const n: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    try {
      await this.postMessage(n)
    } catch {
      // 通知失败不杀会话（隔离）
    }
  }

  private async initialize(): Promise<void> {
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        roots: {},
      },
      clientInfo: { name: 'bolo', version: '0.0.1' },
    })) as { capabilities?: McpServerCapabilities }
    this._capabilities =
      result?.capabilities && typeof result.capabilities === 'object'
        ? result.capabilities
        : {}
    await this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolDef[]
    }
    return Array.isArray(result?.tools) ? result.tools : []
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpCallResult> {
    const result = (await this.request('tools/call', {
      name,
      arguments: args,
    })) as McpCallResult
    return result ?? {}
  }

  async listResources(): Promise<McpResourceDef[]> {
    if (!this.supportsResources) return []
    try {
      const result = (await this.request('resources/list', {})) as {
        resources?: McpResourceDef[]
      }
      return Array.isArray(result?.resources) ? result.resources : []
    } catch {
      return []
    }
  }

  async readResource(uri: string): Promise<McpResourceContents[]> {
    if (!this.supportsResources) {
      throw new Error(
        `MCP server "${this.serverName}" does not support resources`,
      )
    }
    const result = (await this.request('resources/read', { uri })) as {
      contents?: McpResourceContents[]
    }
    return Array.isArray(result?.contents) ? result.contents : []
  }

  async listPrompts(): Promise<McpPromptDef[]> {
    if (!this.supportsPrompts) return []
    try {
      const result = (await this.request('prompts/list', {})) as {
        prompts?: McpPromptDef[]
      }
      return Array.isArray(result?.prompts) ? result.prompts : []
    } catch {
      return []
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
  ): Promise<McpGetPromptResult> {
    if (!this.supportsPrompts) {
      throw new Error(
        `MCP server "${this.serverName}" does not support prompts`,
      )
    }
    const result = (await this.request('prompts/get', {
      name,
      arguments: args,
    })) as McpGetPromptResult
    return result ?? {}
  }

  async close(): Promise<void> {
    this.closed = true
    this.notificationHandlers.clear()
    const sid = this.sessionId
    this.sessionId = undefined
    this._capabilities = {}
    if (!sid) return
    // 尽力 DELETE 会话；失败忽略
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 3000)
      await fetch(this.url, {
        method: 'DELETE',
        headers: {
          ...this.staticHeaders,
          'mcp-session-id': sid,
        },
        signal: controller.signal,
      }).catch(() => undefined)
      clearTimeout(t)
    } catch {
      /* ignore */
    }
  }
}