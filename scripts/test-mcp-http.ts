/**
 * MCP Streamable HTTP 真连接测试 — transport 抽象 + 错误隔离 + /mcp
 * 运行：npx tsx scripts/test-mcp-http.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  closeMcpConnections,
  connectMcpServers,
  loadMcpConfigFile,
  mcpToolName,
  parseSseDataPayloads,
  resolveMcpTransport,
  McpHttpClient,
} from '../packages/mcp/src/index.ts'
import {
  createSessionFromWorkspace,
  closeSessionMcp,
  dispatchSlashCommand,
} from '../packages/core/src/index.ts'
import { writeJsonFile } from '../packages/config/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const httpFixture = path.resolve(__dirname, 'fixtures/mcp-http-echo-server.mjs')
const echoStdio = path.resolve(__dirname, 'fixtures/mcp-echo-server.mjs')
const nodeBin = process.execPath

async function startHttpFixture(): Promise<{
  port: number
  proc: ChildProcess
  url: string
}> {
  const proc = spawn(nodeBin, [httpFixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCP_HTTP_PORT: '0' },
    windowsHide: true,
  })
  let buf = ''
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('http fixture start timeout')), 8000)
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const m = /MCP_HTTP_READY port=(\d+)/.exec(buf)
      if (m) {
        clearTimeout(t)
        resolve(Number(m[1]))
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
    })
    proc.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
    proc.on('exit', (code) => {
      clearTimeout(t)
      reject(new Error(`http fixture exited early code=${code} ${buf}`))
    })
  })
  return { port, proc, url: `http://127.0.0.1:${port}/mcp` }
}

async function stopProc(proc: ChildProcess) {
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
}

function testSseParse() {
  const body = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}',
    '',
  ].join('\n')
  const msgs = parseSseDataPayloads(body)
  assert(msgs.length === 2, 'sse two payloads')
  assert((msgs[0] as { id: number }).id === 1, 'sse id 1')
  assert(
    (msgs[1] as { method: string }).method ===
      'notifications/tools/list_changed',
    'sse notify',
  )
}

function testResolveTransport() {
  assert(
    resolveMcpTransport({ name: 'a', command: 'node' }) === 'stdio',
    'command→stdio',
  )
  assert(
    resolveMcpTransport({ name: 'b', url: 'http://x' }) === 'http',
    'url→http',
  )
  assert(
    resolveMcpTransport({ name: 'c', type: 'http', url: 'http://x' }) ===
      'http',
    'type http',
  )
  assert(
    resolveMcpTransport({ name: 'd', type: 'stdio', command: 'n' }) ===
      'stdio',
    'type stdio',
  )
  assert(resolveMcpTransport({ name: 'e' }) === null, 'empty null')
}

async function testHttpClientJson(url: string) {
  const client = new McpHttpClient({
    server: {
      name: 'http-echo',
      type: 'http',
      url,
      headers: { 'x-test': '1' },
    },
    timeoutMs: 10_000,
  })
  await client.connect()
  assert(client.transport === 'http', 'transport http')
  assert(client.isConnected, 'connected')
  assert(client.supportsTools, 'tools cap')
  assert(client.supportsResources, 'resources cap')
  assert(client.supportsPrompts, 'prompts cap')

  const tools = await client.listTools()
  assert(tools.some((t) => t.name === 'echo'), 'listTools echo')
  const call = await client.callTool('echo', { text: 'hi' })
  const text =
    Array.isArray(call.content) && call.content[0] && 'text' in call.content[0]
      ? String((call.content[0] as { text: string }).text)
      : ''
  assert(text === 'http-echo:hi', `call got ${text}`)

  const resources = await client.listResources()
  assert(
    resources.some((r) => r.uri === 'bolo://http-echo/greeting'),
    'resources',
  )
  const contents = await client.readResource('bolo://http-echo/greeting')
  assert(
    contents.some((c) => c.text === 'hello-from-http-resource'),
    'read resource',
  )

  const prompts = await client.listPrompts()
  assert(prompts.some((p) => p.name === 'greet'), 'prompts')
  const pr = await client.getPrompt('greet', { who: 'bolo' })
  assert(JSON.stringify(pr).includes('bolo'), 'getPrompt')

  await client.close()
  assert(!client.isConnected, 'closed')
}

async function testHttpClientSse(baseUrl: string) {
  const url = `${baseUrl}?sse=1`
  const client = new McpHttpClient({
    server: { name: 'http-sse', type: 'http', url },
    timeoutMs: 10_000,
  })
  await client.connect()
  const call = await client.callTool('echo', { text: 'sse' })
  const text =
    Array.isArray(call.content) && call.content[0] && 'text' in call.content[0]
      ? String((call.content[0] as { text: string }).text)
      : ''
  assert(text === 'http-echo:sse', `sse call ${text}`)
  await client.close()
}

/**
 * M-GEN-5：Streamable HTTP 响应体可带 SSE 帧通知。
 * 经典「长连接 list_changed」走 type:sse；http 仅在**同响应**内嵌 notification 时分发。
 * 本 fixture 的 tools/call?sse=1 不保证推 list_changed；此处断言：
 * - parseSseDataPayloads 能识别 list_changed method
 * - http client 在 JSON 模式可正常 list resources/prompts（无 cap 则空）
 */
async function testHttpListChangedSemantics(url: string) {
  // 文档契约：http list_changed 仅限响应内嵌 SSE；无长推送
  const notifyBody = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/resources/list_changed","params":{}}',
    '',
  ].join('\n')
  const msgs = parseSseDataPayloads(notifyBody)
  assert(msgs.length === 2, 'http sse frames parse list_changed methods')
  assert(
    (msgs[0] as { method: string }).method ===
      'notifications/tools/list_changed',
    'tools list_changed method',
  )
  assert(
    (msgs[1] as { method: string }).method ===
      'notifications/resources/list_changed',
    'resources list_changed method',
  )

  const client = new McpHttpClient({
    server: { name: 'http-r', type: 'http', url },
    timeoutMs: 10_000,
  })
  await client.connect()
  // 无 cap 时 list 必须空数组且不抛
  if (!client.supportsResources) {
    const r = await client.listResources()
    assert(Array.isArray(r) && r.length === 0, 'no-cap resources empty')
  } else {
    const r = await client.listResources()
    assert(Array.isArray(r), 'resources array')
  }
  if (!client.supportsPrompts) {
    const p = await client.listPrompts()
    assert(Array.isArray(p) && p.length === 0, 'no-cap prompts empty')
  }
  await client.close()
}

async function testHostIsolation(httpUrl: string) {
  const result = await connectMcpServers({
    servers: [
      {
        name: 'http-ok',
        type: 'http',
        url: httpUrl,
      },
      {
        name: 'http-dead',
        type: 'http',
        url: 'http://127.0.0.1:1/mcp',
      },
      {
        name: 'stdio-ok',
        command: nodeBin,
        args: [echoStdio],
      },
    ],
    timeoutMs: 8_000,
  })

  assert(
    result.warnings.some((w) => w.includes('http-dead')),
    `dead warns: ${result.warnings.join('; ')}`,
  )
  assert(
    result.servers.some((s) => s.name === 'http-ok' && s.transport === 'http'),
    'http-ok connected',
  )
  assert(
    result.servers.some((s) => s.name === 'stdio-ok' && s.transport === 'stdio'),
    'stdio-ok connected despite dead http',
  )
  assert(
    result.tools.some((t) => t.name === mcpToolName('http-ok', 'echo')),
    'http tool registered',
  )
  assert(
    result.tools.some((t) => t.name === mcpToolName('stdio-ok', 'echo')),
    'stdio tool registered',
  )

  const tool = result.tools.find((t) => t.name === 'mcp__http-ok__echo')!
  const out = await tool.call({ text: 'host' }, { cwd: process.cwd() })
  assert(out.ok && out.output.includes('http-echo:host'), `host call ${out.output}`)

  await closeMcpConnections(result.servers)
}

async function testSessionAndSlash(httpUrl: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mcp-http-'))
  const userRoot = path.join(tmp, 'user-bolo')
  const projectCwd = path.join(tmp, 'proj')
  await fs.mkdir(projectCwd, { recursive: true })
  process.env.BOLO_CONFIG_DIR = userRoot
  process.env.BOLO_PROVIDER = 'mock'
  delete process.env.BOLO_API_KEY
  delete process.env.OPENAI_API_KEY

  await fs.mkdir(path.join(projectCwd, '.bolo'), { recursive: true })
  await writeJsonFile(path.join(projectCwd, '.bolo', 'mcp.json'), {
    mcpServers: {
      remote: {
        type: 'http',
        url: httpUrl,
        headers: { Authorization: 'Bearer test-token' },
      },
    },
  })

  const loaded = await loadMcpConfigFile(
    path.join(projectCwd, '.bolo', 'mcp.json'),
  )
  assert(loaded[0]?.type === 'http', 'config type http')
  assert(loaded[0]?.url === httpUrl, 'config url')
  assert(loaded[0]?.headers?.Authorization === 'Bearer test-token', 'headers')

  const { session, mcp } = await createSessionFromWorkspace({
    cwd: projectCwd,
    ensureDefaults: true,
    systemPrompt: false,
    connectMcp: true,
  })

  assert(mcp, 'mcp result')
  assert(
    session.tools?.some((t) => t.name === 'mcp__remote__echo'),
    'session mcp tool',
  )
  const slash = await dispatchSlashCommand(session, 'mcp', '')
  assert(slash.ok, 'slash ok')
  assert(
    slash.message.includes('transport=http'),
    `/mcp transport: ${slash.message}`,
  )
  assert(
    slash.message.includes('status=connected'),
    `/mcp status: ${slash.message}`,
  )

  await closeSessionMcp(session)
}

async function main() {
  testSseParse()
  testResolveTransport()

  const fx = await startHttpFixture()
  try {
    await testHttpClientJson(fx.url)
    await testHttpClientSse(fx.url)
    await testHttpListChangedSemantics(fx.url)
    await testHostIsolation(fx.url)
    await testSessionAndSlash(fx.url)
    console.log('MCP HTTP TESTS PASS')
  } finally {
    await stopProc(fx.proc)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})