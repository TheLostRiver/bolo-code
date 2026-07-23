/**
 * 极简 MCP stdio echo server（测试用）
 * 支持 Content-Length 帧：initialize / tools/list / tools/call(echo)
 * 运行：node scripts/fixtures/mcp-echo-server.mjs
 */

function writeMessage(msg) {
  const json = JSON.stringify(msg)
  const body = Buffer.from(json, 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function handleRequest(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bolo-echo', version: '0.0.1' },
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return
  }
  if (method === 'tools/list') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
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
        ],
      },
    })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name !== 'echo') {
      writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      })
      return
    }
    const text = typeof args.text === 'string' ? args.text : JSON.stringify(args)
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `echo:${text}` }],
        isError: false,
      },
    })
    return
  }
  if (id !== undefined) {
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    })
  }
}

// Content-Length 缓冲解析
let buf = Buffer.alloc(0)

function onChunk(chunk) {
  buf = Buffer.concat([buf, chunk])
  while (true) {
    const s = buf.toString('utf8')
    const m = /^Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(s)
    if (!m) {
      // NDJSON fallback
      const nl = s.indexOf('\n')
      if (nl < 0) break
      const line = s.slice(0, nl).trim()
      buf = buf.subarray(nl + 1)
      if (!line) continue
      try {
        handleRequest(JSON.parse(line))
      } catch {
        /* ignore */
      }
      continue
    }
    const len = Number(m[1])
    const headerBytes = Buffer.byteLength(m[0], 'utf8')
    if (buf.length < headerBytes + len) break
    const body = buf.subarray(headerBytes, headerBytes + len).toString('utf8')
    buf = buf.subarray(headerBytes + len)
    try {
      handleRequest(JSON.parse(body))
    } catch {
      /* ignore */
    }
  }
}

process.stdin.on('data', onChunk)
process.stdin.on('end', () => process.exit(0))

// 也支持 readline 纯行模式（若上游只写 NDJSON）
// 主路径走 data 缓冲即可