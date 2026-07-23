/**
 * MCP stdio JSON-RPC client — Content-Length framing（对照 MCP SDK / HC mcp client）
 * 无遥测；最小能力：initialize → tools/list → tools/call
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { McpServerConfig } from './types.ts'

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

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 15_000

function encodeMessage(msg: object): Buffer {
  const json = JSON.stringify(msg)
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
  return Buffer.concat([header, body])
}

/**
 * 从缓冲解析 Content-Length 帧；兼容纯 NDJSON 一行一条
 */
export function extractMessages(buffer: Buffer): {
  messages: object[]
  rest: Buffer
} {
  const messages: object[] = []
  let rest = buffer

  while (rest.length > 0) {
    const asStr = rest.toString('utf8')
    // Content-Length framing
    const headerMatch = /^(?:Content-Length:\s*(\d+)\r?\n)+(?:\r?\n)/i.exec(
      asStr,
    )
    if (headerMatch) {
      const len = Number(headerMatch[1])
      const headerBytes = Buffer.byteLength(headerMatch[0], 'utf8')
      if (rest.length < headerBytes + len) break
      const body = rest.subarray(headerBytes, headerBytes + len).toString('utf8')
      rest = rest.subarray(headerBytes + len)
      try {
        messages.push(JSON.parse(body) as object)
      } catch {
        // skip bad frame
      }
      continue
    }

    // NDJSON fallback（无 Content-Length）
    const nl = asStr.indexOf('\n')
    if (nl < 0) break
    const line = asStr.slice(0, nl).trim()
    rest = rest.subarray(nl + 1)
    if (!line) continue
    try {
      messages.push(JSON.parse(line) as object)
    } catch {
      // skip
    }
  }

  return { messages, rest }
}

export type StdioClientOptions = {
  server: McpServerConfig
  cwd?: string
  timeoutMs?: number
  /** 额外 env（合并进 process.env + server.env） */
  env?: Record<string, string>
}

export class McpStdioClient {
  readonly serverName: string
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<
    string,
    {
      resolve: (v: JsonRpcResponse) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private closed = false
  private readonly timeoutMs: number
  private readonly opts: StdioClientOptions

  constructor(opts: StdioClientOptions) {
    this.opts = opts
    this.serverName = opts.server.name
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get isConnected(): boolean {
    return this.proc !== null && !this.closed
  }

  async connect(): Promise<void> {
    if (this.proc) return
    const { server, cwd, env } = this.opts
    if (!server.command?.trim()) {
      throw new Error(`MCP server "${server.name}": missing command`)
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(server.env ?? {}),
      ...(env ?? {}),
    }
    // 避免子进程继承父级 MCP 调试噪声；无遥测注入
    delete childEnv.NODE_OPTIONS

    const proc = spawn(server.command, server.args ?? [], {
      cwd: cwd ?? process.cwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    this.proc = proc

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', (_chunk: Buffer) => {
      // 不打遥测；调试时可接外部 logger
    })
    proc.on('error', (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)))
    })
    proc.on('exit', (code, signal) => {
      this.failAll(
        new Error(
          `MCP server "${this.serverName}" exited (code=${code}, signal=${signal})`,
        ),
      )
      this.proc = null
      this.closed = true
    })

    await this.initialize()
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk])
    const { messages, rest } = extractMessages(this.buf)
    this.buf = rest
    for (const msg of messages) {
      this.handleMessage(msg as JsonRpcResponse)
    }
  }

  private handleMessage(msg: JsonRpcResponse) {
    if (msg.id === undefined || msg.id === null) {
      // notification — ignore for minimal host
      return
    }
    const key = String(msg.id)
    const p = this.pending.get(key)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(key)
    p.resolve(msg)
  }

  private failAll(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private write(msg: object) {
    if (!this.proc?.stdin.writable) {
      throw new Error(`MCP server "${this.serverName}" stdin not writable`)
    }
    this.proc.stdin.write(encodeMessage(msg))
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || !this.proc) {
      return Promise.reject(
        new Error(`MCP server "${this.serverName}" not connected`),
      )
    }
    const id = this.nextId++
    const key = String(id)
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(
          new Error(
            `MCP ${this.serverName} ${method} timed out after ${this.timeoutMs}ms`,
          ),
        )
      }, this.timeoutMs)

      this.pending.set(key, {
        resolve: (resp) => {
          if (resp.error) {
            reject(
              new Error(
                `MCP ${this.serverName} ${method}: ${resp.error.message} (${resp.error.code})`,
              ),
            )
            return
          }
          resolve(resp.result)
        },
        reject,
        timer,
      })

      try {
        this.write(req)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(key)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    const n: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    this.write(n)
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bolo', version: '0.0.1' },
    })
    this.notify('notifications/initialized')
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

  async close(): Promise<void> {
    this.closed = true
    this.failAll(new Error(`MCP server "${this.serverName}" closed`))
    if (!this.proc) return
    try {
      this.proc.stdin.end()
    } catch {
      /* ignore */
    }
    const proc = this.proc
    this.proc = null
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 2000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      try {
        proc.kill()
      } catch {
        clearTimeout(t)
        resolve()
      }
    })
  }
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