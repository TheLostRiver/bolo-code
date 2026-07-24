/**
 * MCP 经典 SSE 长连接 client（type: sse）
 * 语义对照规范 2024-11-05 HTTP+SSE 与参考实现 SSE transport：
 * - GET url 建长连接（Accept: text/event-stream）
 * - 首帧 event:endpoint 给出 POST 消息 URL
 * - 客户端 POST JSON-RPC 到该 endpoint；服务端经 SSE event:message 回结果/通知
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

export type SseClientOptions = {
  server: McpServerConfig
  timeoutMs?: number
  headers?: Record<string, string>
}

type Pending = {
  resolve: (v: JsonRpcResponse) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type ParsedSseEvent = {
  event: string
  data: string
}

/**
 * 从缓冲中切出完整 SSE 事件（空行分隔）；返回剩余半包。
 */
export function consumeSseEvents(buffer: string): {
  events: ParsedSseEvent[]
  rest: string
} {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: ParsedSseEvent[] = []
  for (const block of parts) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim() || 'message'
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''))
      }
    }
    if (!dataLines.length) continue
    events.push({ event, data: dataLines.join('\n') })
  }
  return { events, rest }
}

/** 将 endpoint 事件 data 解析为绝对 URL（相对路径相对 sseBase）。 */
export function resolveSseMessageUrl(
  sseBaseUrl: string,
  endpointData: string,
): string {
  const raw = endpointData.trim()
  if (!raw) {
    throw new Error('SSE endpoint event has empty data')
  }
  try {
    return new URL(raw).href
  } catch {
    return new URL(raw, sseBaseUrl).href
  }
}

export class McpSseClient implements McpClient {
  readonly serverName: string
  readonly transport = 'sse' as const
  private readonly sseUrl: string
  private readonly staticHeaders: Record<string, string>
  private readonly timeoutMs: number
  private messageUrl: string | undefined
  private closed = true
  private nextId = 1
  private _capabilities: McpServerCapabilities = {}
  private notificationHandlers = new Map<string, Set<McpNotificationHandler>>()
  private pending = new Map<string, Pending>()
  private abort: AbortController | undefined
  private streamTask: Promise<void> | undefined
  private endpointReady: {
    promise: Promise<string>
    resolve: (url: string) => void
    reject: (e: Error) => void
  }

  constructor(opts: SseClientOptions) {
    const url = opts.server.url?.trim()
    if (!url) {
      throw new Error(
        `MCP server "${opts.server.name}": sse transport requires url`,
      )
    }
    this.serverName = opts.server.name
    this.sseUrl = url
    this.timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
    this.staticHeaders = {
      ...(opts.server.headers ?? {}),
      ...(opts.headers ?? {}),
    }
    this.endpointReady = this.makeEndpointGate()
  }

  private makeEndpointGate() {
    let resolve!: (url: string) => void
    let reject!: (e: Error) => void
    const promise = new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  get isConnected(): boolean {
    return !this.closed && Boolean(this.messageUrl)
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
    if (this.isConnected) return
    this.closed = false
    this.endpointReady = this.makeEndpointGate()
    this.messageUrl = undefined
    this.abort = new AbortController()

    try {
      this.streamTask = this.openSseStream()
      const endpointWait = this.withTimeout(
        this.endpointReady.promise,
        this.timeoutMs,
        `SSE endpoint not received within ${this.timeoutMs}ms`,
      )
      this.messageUrl = await endpointWait
      await this.initialize()
    } catch (e) {
      await this.teardown(e instanceof Error ? e : new Error(String(e)))
      throw e
    }
  }

  private withTimeout<T>(
    p: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms)
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  private async openSseStream(): Promise<void> {
    const signal = this.abort?.signal
    let res: Response
    try {
      res = await fetch(this.sseUrl, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...this.staticHeaders,
        },
        signal,
      })
    } catch (e) {
      if (this.closed) return
      const err =
        e instanceof Error
          ? e
          : new Error(String(e))
      this.endpointReady.reject(err)
      this.failAllPending(err)
      return
    }

    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '')
      const err = new Error(
        `MCP ${this.serverName} SSE HTTP ${res.status}${t ? `: ${t.slice(0, 200)}` : ''}`,
      )
      this.endpointReady.reject(err)
      this.failAllPending(err)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let endpointSeen = false

    try {
      while (!this.closed) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const { events, rest } = consumeSseEvents(buf)
        buf = rest
        for (const ev of events) {
          if (ev.event === 'endpoint') {
            try {
              const url = resolveSseMessageUrl(this.sseUrl, ev.data)
              if (!endpointSeen) {
                endpointSeen = true
                this.endpointReady.resolve(url)
              }
              this.messageUrl = url
            } catch (e) {
              const err = e instanceof Error ? e : new Error(String(e))
              if (!endpointSeen) this.endpointReady.reject(err)
            }
            continue
          }
          // message 或默认：JSON-RPC
          this.handleSsePayload(ev.data)
        }
      }
    } catch (e) {
      if (!this.closed && e instanceof Error && e.name !== 'AbortError') {
        if (!endpointSeen) this.endpointReady.reject(e)
        this.failAllPending(e)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
      if (!this.closed) {
        const err = new Error(
          `MCP ${this.serverName} SSE stream closed unexpectedly`,
        )
        if (!endpointSeen) this.endpointReady.reject(err)
        this.failAllPending(err)
        this.closed = true
      }
    }
  }

  private handleSsePayload(data: string) {
    const payload = data.trim()
    if (!payload || payload === '[DONE]') return
    let msg: JsonRpcResponse & { method?: string; params?: unknown }
    try {
      msg = JSON.parse(payload) as JsonRpcResponse & {
        method?: string
        params?: unknown
      }
    } catch {
      return
    }

    if (
      (msg.id === undefined || msg.id === null) &&
      typeof msg.method === 'string'
    ) {
      this.dispatchNotification(msg.method, msg.params)
      return
    }

    if (msg.id === undefined || msg.id === null) return
    const key = String(msg.id)
    const pend = this.pending.get(key)
    if (!pend) return
    clearTimeout(pend.timer)
    this.pending.delete(key)
    pend.resolve(msg)
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

  private failAllPending(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private async postToMessageEndpoint(msg: object): Promise<void> {
    if (this.closed || !this.messageUrl) {
      throw new Error(`MCP server "${this.serverName}" not connected`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.messageUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.staticHeaders,
        },
        body: JSON.stringify(msg),
        signal: controller.signal,
      })
      // 经典 SSE：多数服务端 202；也允许 200 + 空/JSON（少数实现）
      if (!res.ok && res.status !== 202) {
        const t = await res.text().catch(() => '')
        throw new Error(
          `MCP ${this.serverName} SSE POST ${res.status}${t ? `: ${t.slice(0, 200)}` : ''}`,
        )
      }
      // 若 POST 直接回 JSON-RPC（非规范但兼容），走同路径
      if (res.status === 200) {
        const ct = (res.headers.get('content-type') ?? '').toLowerCase()
        const text = await res.text().catch(() => '')
        if (text.trim() && ct.includes('application/json')) {
          try {
            this.handleSsePayload(text)
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(
          `MCP ${this.serverName} request timed out after ${this.timeoutMs}ms`,
        )
      }
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      clearTimeout(timer)
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const key = String(id)
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }

    const respPromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(
          new Error(
            `MCP ${this.serverName} ${method}: timed out after ${this.timeoutMs}ms`,
          ),
        )
      }, this.timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
    })

    try {
      await this.postToMessageEndpoint(req)
    } catch (e) {
      const pend = this.pending.get(key)
      if (pend) {
        clearTimeout(pend.timer)
        this.pending.delete(key)
      }
      throw e
    }

    const resp = await respPromise
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
      await this.postToMessageEndpoint(n)
    } catch {
      // 通知失败不杀会话
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

  private async teardown(err?: Error): Promise<void> {
    this.closed = true
    this.messageUrl = undefined
    this._capabilities = {}
    this.notificationHandlers.clear()
    if (err) this.failAllPending(err)
    else this.failAllPending(new Error(`MCP ${this.serverName} closed`))
    try {
      this.abort?.abort()
    } catch {
      /* ignore */
    }
    this.abort = undefined
    if (this.streamTask) {
      try {
        await this.streamTask
      } catch {
        /* ignore */
      }
      this.streamTask = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed && !this.abort) return
    await this.teardown()
  }
}