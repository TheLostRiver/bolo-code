/**
 * MCP 经典 SSE 长连接测试 — type:sse + endpoint 事件 + host + /mcp
 * 运行：npx tsx scripts/test-mcp-sse.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  closeMcpConnections,
  connectMcpServers,
  consumeSseEvents,
  mcpToolName,
  resolveMcpTransport,
  resolveSseMessageUrl,
  McpSseClient,
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
const sseFixture = path.resolve(__dirname, 'fixtures/mcp-sse-echo-server.mjs')
const echoStdio = path.resolve(__dirname, 'fixtures/mcp-echo-server.mjs')
const nodeBin = process.execPath

async function startSseFixture(): Promise<{
  port: number
  proc: ChildProcess
  sseUrl: string
  base: string
}> {
  const proc = spawn(nodeBin, [sseFixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCP_SSE_PORT: '0' },
    windowsHide: true,
  })
  let buf = ''
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('sse fixture start timeout')),
      8000,
    )
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const m = /MCP_SSE_READY port=(\d+)/.exec(buf)
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
      reject(new Error(`sse fixture exited early code=${code} ${buf}`))
    })
  })
  const base = `http://127.0.0.1:${port}`
  return { port, proc, sseUrl: `${base}/sse`, base }
}

async function stopProc(proc: ChildProcess) {
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
}

function testHelpers() {
  const { events, rest } = consumeSseEvents(
    [
      'event: endpoint',
      'data: /message?sessionId=abc',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}',
      '',
      'partial',
    ].join('\n'),
  )
  assert(events.length === 3, `events ${events.length}`)
  assert(events[0]!.event === 'endpoint', 'endpoint event')
  assert(events[0]!.data.includes('sessionId=abc'), 'endpoint data')
  assert(events[1]!.event === 'message', 'message event')
  assert(rest === 'partial', `rest ${rest}`)

  const abs = resolveSseMessageUrl(
    'http://127.0.0.1:9/sse',
    '/message?sessionId=x',
  )
  assert(
    abs === 'http://127.0.0.1:9/message?sessionId=x',
    `resolve relative ${abs}`,
  )
  const full = resolveSseMessageUrl(
    'http://127.0.0.1:9/sse',
    'http://example.com/m',
  )
  assert(full === 'http://example.com/m', 'resolve absolute')

  assert(
    resolveMcpTransport({ name: 's', type: 'sse', url: 'http://x/sse' }) ===
      'sse',
    'type sse',
  )
}

async function testSseClient(sseUrl: string) {
  const client = new McpSseClient({
    server: {
      name: 'sse-echo',
      type: 'sse',
      url: sseUrl,
      headers: { 'x-test': '1' },
    },
    timeoutMs: 10_000,
  })
  await client.connect()
  assert(client.transport === 'sse', 'transport sse')
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
  assert(text === 'sse-echo:hi', `call got ${text}`)

  const resources = await client.listResources()
  assert(
    resources.some((r) => r.uri === 'bolo://sse-echo/greeting'),
    'resources',
  )
  const contents = await client.readResource('bolo://sse-echo/greeting')
  assert(
    contents.some((c) => c.text === 'hello-from-sse-resource'),
    'read resource',
  )

  const prompts = await client.listPrompts()
  assert(prompts.some((p) => p.name === 'greet'), 'prompts')
  const pr = await client.getPrompt('greet', { who: 'bolo' })
  assert(JSON.stringify(pr).includes('bolo'), 'getPrompt')

  await client.close()
  assert(!client.isConnected, 'closed')
}

async function testHostAndListChanged(sseUrl: string, base: string) {
  const result = await connectMcpServers({
    servers: [
      {
        name: 'sse-ok',
        type: 'sse',
        url: sseUrl,
      },
      {
        name: 'sse-dead',
        type: 'sse',
        url: 'http://127.0.0.1:1/sse',
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
    result.warnings.some((w) => w.includes('sse-dead')),
    `dead warns: ${result.warnings.join('; ')}`,
  )
  assert(
    result.servers.some((s) => s.name === 'sse-ok' && s.transport === 'sse'),
    'sse-ok connected',
  )
  assert(
    result.servers.some((s) => s.name === 'stdio-ok' && s.transport === 'stdio'),
    'stdio-ok despite dead sse',
  )
  assert(
    result.tools.some((t) => t.name === mcpToolName('sse-ok', 'echo')),
    'sse tool registered',
  )

  const tool = result.tools.find((t) => t.name === 'mcp__sse-ok__echo')!
  const out = await tool.call({ text: 'host' }, { cwd: process.cwd() })
  assert(out.ok && out.output.includes('sse-echo:host'), `host call ${out.output}`)

  // list_changed：推通知后应再 list 出 ping
  const sseServer = result.servers.find((s) => s.name === 'sse-ok')!
  const before = sseServer.tools.length
  await fetch(`${base}/notify-list-changed`, { method: 'POST' })
  // 等 handler 异步 list
  let sawPing = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50))
    if (sseServer.tools.some((t) => t.name === 'ping')) {
      sawPing = true
      break
    }
  }
  assert(sawPing, `list_changed refresh tools=${sseServer.tools.map((t) => t.name).join(',')}`)
  assert(sseServer.tools.length >= before, 'tools grew or same')

  await closeMcpConnections(result.servers)
}

async function testSessionAndSlash(sseUrl: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mcp-sse-'))
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
      remoteSse: {
        type: 'sse',
        url: sseUrl,
        headers: { Authorization: 'Bearer test-token' },
      },
    },
  })

  const { session, mcp } = await createSessionFromWorkspace({
    cwd: projectCwd,
    ensureDefaults: true,
    systemPrompt: false,
    connectMcp: true,
  })

  assert(mcp, 'mcp result')
  assert(
    session.tools?.some((t) => t.name === 'mcp__remoteSse__echo'),
    'session mcp tool',
  )
  const slash = await dispatchSlashCommand(session, 'mcp', '')
  assert(slash.ok, 'slash ok')
  assert(
    slash.message.includes('transport=sse'),
    `/mcp transport: ${slash.message}`,
  )
  assert(
    slash.message.includes('status=connected'),
    `/mcp status: ${slash.message}`,
  )

  await closeSessionMcp(session)
}

async function main() {
  testHelpers()

  const fx = await startSseFixture()
  try {
    await testSseClient(fx.sseUrl)
    await testHostAndListChanged(fx.sseUrl, fx.base)
    await testSessionAndSlash(fx.sseUrl)
    console.log('MCP SSE TESTS PASS')
  } finally {
    await stopProc(fx.proc)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})