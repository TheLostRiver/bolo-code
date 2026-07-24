/**
 * 极简 MCP 经典 SSE transport fixture（测试用）
 * - GET /sse → text/event-stream；首帧 event:endpoint → POST 消息路径
 * - POST /message?sessionId=… → 收 JSON-RPC；结果经 SSE event:message 推回
 * - 可选 POST /notify-list-changed 推 tools list_changed（测热刷新）
 * 运行：node scripts/fixtures/mcp-sse-echo-server.mjs
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.MCP_SSE_PORT || 0)

let tools = [
  {
    name: 'echo',
    description: 'Echo back text',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'text to echo' },
      },
      required: ['text'],
    },
  },
]

let resources = [
  {
    uri: 'bolo://sse-echo/greeting',
    name: 'greeting',
    description: 'A short greeting text',
    mimeType: 'text/plain',
  },
]

let prompts = [
  {
    name: 'greet',
    description: 'Greet someone by name',
    arguments: [
      { name: 'who', description: 'Name to greet', required: false },
    ],
  },
]

/** sessionId → { res, write(event, data) } */
const sessions = new Map()

function writeSse(res, event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  res.write(`event: ${event}\ndata: ${payload}\n\n`)
}

function handleRpc(msg) {
  const { id, method, params } = msg
  if (method === 'notifications/initialized' || method === 'initialized') {
    return { kind: 'notify' }
  }
  if (method === 'initialize') {
    return {
      kind: 'result',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
          resources: {},
          prompts: {},
        },
        serverInfo: { name: 'bolo-sse-echo', version: '0.0.1' },
      },
    }
  }
  if (method === 'tools/list') {
    return { kind: 'result', id, result: { tools } }
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'echo') {
      const text =
        typeof args.text === 'string' ? args.text : JSON.stringify(args)
      return {
        kind: 'result',
        id,
        result: {
          content: [{ type: 'text', text: `sse-echo:${text}` }],
          isError: false,
        },
      }
    }
    return {
      kind: 'error',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    }
  }
  if (method === 'resources/list') {
    return { kind: 'result', id, result: { resources } }
  }
  if (method === 'resources/read') {
    const uri = params?.uri
    if (uri === 'bolo://sse-echo/greeting') {
      return {
        kind: 'result',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'hello-from-sse-resource',
            },
          ],
        },
      }
    }
    return {
      kind: 'error',
      id,
      error: { code: -32002, message: `Resource not found: ${uri}` },
    }
  }
  if (method === 'prompts/list') {
    return { kind: 'result', id, result: { prompts } }
  }
  if (method === 'prompts/get') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'greet') {
      const who = typeof args.who === 'string' && args.who ? args.who : 'world'
      return {
        kind: 'result',
        id,
        result: {
          description: 'Greet prompt',
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: `Please greet ${who}.` },
            },
          ],
        },
      }
    }
    return {
      kind: 'error',
      id,
      error: { code: -32602, message: `Unknown prompt: ${name}` },
    }
  }
  if (id !== undefined) {
    return {
      kind: 'error',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }
  }
  return { kind: 'notify' }
}

function toJsonRpc(out) {
  if (out.kind === 'result') {
    return { jsonrpc: '2.0', id: out.id, result: out.result }
  }
  if (out.kind === 'error') {
    return { jsonrpc: '2.0', id: out.id, error: out.error }
  }
  return null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1`)

  // 测试辅助：动态加 tool + 推 list_changed
  if (req.method === 'POST' && url.pathname === '/notify-list-changed') {
    tools = [
      ...tools,
      {
        name: 'ping',
        description: 'Ping tool added at runtime',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    for (const s of sessions.values()) {
      try {
        writeSse(s.res, 'message', {
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
          params: {},
        })
      } catch {
        /* ignore */
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, tools: tools.length }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = randomUUID()
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // 经典 SSE：endpoint 给出客户端 POST 消息的 URL（相对路径）
    writeSse(res, 'endpoint', `/message?sessionId=${sessionId}`)
    sessions.set(sessionId, { res })
    req.on('close', () => {
      sessions.delete(sessionId)
    })
    // 保持连接；不 end
    return
  }

  if (req.method === 'POST' && url.pathname === '/message') {
    const sessionId = url.searchParams.get('sessionId') || ''
    const session = sessions.get(sessionId)
    if (!session) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown session' }))
      return
    }
    let raw
    try {
      raw = await readBody(req)
    } catch {
      res.writeHead(400)
      res.end('bad body')
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json' }))
      return
    }

    const out = handleRpc(body)
    const payload = toJsonRpc(out)
    if (payload) {
      try {
        writeSse(session.res, 'message', payload)
      } catch {
        /* stream gone */
      }
    }
    // 规范：POST 常回 202 Accepted
    res.writeHead(202)
    res.end()
    return
  }

  res.writeHead(404)
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  const addr = server.address()
  const p = typeof addr === 'object' && addr ? addr.port : port
  process.stdout.write(`MCP_SSE_READY port=${p}\n`)
})

export { server }