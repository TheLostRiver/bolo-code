/**
 * 极简 MCP Streamable HTTP fixture（测试用）
 * POST JSON-RPC：initialize / tools / resources / prompts
 * 可选 SSE 响应（?sse=1 或 Accept 含 event-stream 且 body 带 X-Prefer-Sse）
 * 运行：node scripts/fixtures/mcp-http-echo-server.mjs
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.MCP_HTTP_PORT || 0)

/** 可变目录 */
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
    uri: 'bolo://http-echo/greeting',
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

const sessions = new Set()

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
          tools: {},
          resources: {},
          prompts: {},
        },
        serverInfo: { name: 'bolo-http-echo', version: '0.0.1' },
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
          content: [{ type: 'text', text: `http-echo:${text}` }],
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
    if (uri === 'bolo://http-echo/greeting') {
      return {
        kind: 'result',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'hello-from-http-resource',
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

function writeSse(res, payload, sessionId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'mcp-session-id': sessionId,
  })
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1`)
  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id']
    if (sid) sessions.delete(String(sid))
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST, DELETE' })
    res.end('method not allowed')
    return
  }

  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid json' }))
    return
  }

  let sessionId = req.headers['mcp-session-id']
    ? String(req.headers['mcp-session-id'])
    : undefined
  if (!sessionId && body?.method === 'initialize') {
    sessionId = randomUUID()
    sessions.add(sessionId)
  }

  const out = handleRpc(body)
  if (out.kind === 'notify') {
    res.writeHead(202, {
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    })
    res.end()
    return
  }

  const payload = toJsonRpc(out)
  const preferSse =
    url.searchParams.get('sse') === '1' ||
    String(req.headers['x-bolo-prefer-sse'] || '') === '1'

  if (preferSse && payload) {
    writeSse(res, payload, sessionId || 'anon')
    return
  }

  res.writeHead(200, {
    'content-type': 'application/json',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  })
  res.end(JSON.stringify(payload))
})

server.listen(port, '127.0.0.1', () => {
  const addr = server.address()
  const p = typeof addr === 'object' && addr ? addr.port : port
  // 子进程模式：把端口打到 stdout 一行，便于测试解析
  process.stdout.write(`MCP_HTTP_READY port=${p}\n`)
})

export { server }