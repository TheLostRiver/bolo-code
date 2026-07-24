/**
 * 极简 MCP stdio fixture（测试用）
 * 支持 Content-Length 帧：
 *   initialize / tools/list / tools/call(echo|mutate)
 *   resources/list / resources/read
 *   prompts/list / prompts/get
 *   经 mutate 后发 notifications list_changed（MCP2 热刷新）
 * 运行：node scripts/fixtures/mcp-echo-server.mjs
 */

function writeMessage(msg) {
  const json = JSON.stringify(msg)
  const body = Buffer.from(json, 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function writeNotification(method, params) {
  writeMessage({
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
  })
}

/** 可变目录：mutate 工具可增删，再 list_changed */
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
  {
    name: 'mutate',
    description:
      'Test helper: add/remove tool|resource|prompt then emit list_changed',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'tools | resources | prompts',
        },
        action: {
          type: 'string',
          description: 'add | remove',
        },
      },
      required: ['kind', 'action'],
    },
  },
]

let resources = [
  {
    uri: 'bolo://echo/greeting',
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

function handleRequest(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
        serverInfo: { name: 'bolo-echo', version: '0.0.3' },
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
      result: { tools },
    })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'echo') {
      const text =
        typeof args.text === 'string' ? args.text : JSON.stringify(args)
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
    if (name === 'mutate') {
      const kind = typeof args.kind === 'string' ? args.kind : ''
      const action = typeof args.action === 'string' ? args.action : ''
      let note = ''
      if (kind === 'tools') {
        if (action === 'add') {
          if (!tools.some((t) => t.name === 'extra')) {
            tools = [
              ...tools,
              {
                name: 'extra',
                description: 'Extra tool after list_changed',
                inputSchema: {
                  type: 'object',
                  properties: {
                    n: { type: 'number' },
                  },
                },
              },
            ]
          }
          note = 'tools+extra'
        } else if (action === 'remove') {
          tools = tools.filter((t) => t.name !== 'extra')
          note = 'tools-extra'
        }
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `mutate:${note || 'noop'}` }],
            isError: false,
          },
        })
        // 先回 call 结果，再发通知（host 异步 re-list）
        setImmediate(() =>
          writeNotification('notifications/tools/list_changed', {}),
        )
        return
      }
      if (kind === 'resources') {
        if (action === 'add') {
          if (!resources.some((r) => r.uri === 'bolo://echo/extra')) {
            resources = [
              ...resources,
              {
                uri: 'bolo://echo/extra',
                name: 'extra',
                description: 'Extra resource',
                mimeType: 'text/plain',
              },
            ]
          }
          note = 'resources+extra'
        } else if (action === 'remove') {
          resources = resources.filter((r) => r.uri !== 'bolo://echo/extra')
          note = 'resources-extra'
        }
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `mutate:${note || 'noop'}` }],
            isError: false,
          },
        })
        setImmediate(() =>
          writeNotification('notifications/resources/list_changed', {}),
        )
        return
      }
      if (kind === 'prompts') {
        if (action === 'add') {
          if (!prompts.some((p) => p.name === 'extra')) {
            prompts = [
              ...prompts,
              {
                name: 'extra',
                description: 'Extra prompt',
                arguments: [],
              },
            ]
          }
          note = 'prompts+extra'
        } else if (action === 'remove') {
          prompts = prompts.filter((p) => p.name !== 'extra')
          note = 'prompts-extra'
        }
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `mutate:${note || 'noop'}` }],
            isError: false,
          },
        })
        setImmediate(() =>
          writeNotification('notifications/prompts/list_changed', {}),
        )
        return
      }
      writeMessage({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: `mutate needs kind=tools|resources|prompts action=add|remove`,
        },
      })
      return
    }
    if (name === 'extra') {
      const n = args.n
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `extra:${String(n ?? '')}` }],
          isError: false,
        },
      })
      return
    }
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    })
    return
  }
  if (method === 'resources/list') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: { resources },
    })
    return
  }
  if (method === 'resources/read') {
    const uri = params?.uri
    if (uri === 'bolo://echo/greeting') {
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'hello-from-resource',
            },
          ],
        },
      })
      return
    }
    if (uri === 'bolo://echo/extra') {
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'extra-resource-body',
            },
          ],
        },
      })
      return
    }
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32002, message: `Resource not found: ${uri}` },
    })
    return
  }
  if (method === 'prompts/list') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: { prompts },
    })
    return
  }
  if (method === 'prompts/get') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'greet') {
      const who = typeof args.who === 'string' && args.who ? args.who : 'world'
      writeMessage({
        jsonrpc: '2.0',
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
      })
      return
    }
    if (name === 'extra') {
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Extra prompt',
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: 'Extra prompt body.' },
            },
          ],
        },
      })
      return
    }
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Unknown prompt: ${name}` },
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