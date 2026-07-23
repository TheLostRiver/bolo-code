/**
 * MCP stdio 真连接测试 — mock echo server list + call
 * 运行：npx tsx scripts/test-mcp-stdio.ts
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectMcpServers,
  closeMcpConnections,
  extractMessages,
  loadMcpConfigFile,
  mcpToolName,
  parseMcpToolName,
  McpStdioClient,
} from '../packages/mcp/src/index.ts'
import {
  createSessionFromWorkspace,
  closeSessionMcp,
} from '../packages/core/src/index.ts'
import { writeJsonFile } from '../packages/config/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const echoServer = path.resolve(__dirname, 'fixtures/mcp-echo-server.mjs')
const nodeBin = process.execPath

async function testFraming() {
  const body = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}', 'utf8')
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ])
  const { messages, rest } = extractMessages(frame)
  assert(messages.length === 1, 'one framed message')
  assert(rest.length === 0, 'no rest')
  assert((messages[0] as { id: number }).id === 1, 'id=1')

  const nd = Buffer.from('{"a":1}\n{"b":2}\n', 'utf8')
  const r2 = extractMessages(nd)
  assert(r2.messages.length === 2, 'ndjson two lines')
}

async function testStdioListCall() {
  const client = new McpStdioClient({
    server: {
      name: 'echo',
      command: nodeBin,
      args: [echoServer],
    },
    timeoutMs: 10_000,
  })
  await client.connect()
  const tools = await client.listTools()
  assert(tools.some((t) => t.name === 'echo'), 'listTools has echo')
  const call = await client.callTool('echo', { text: 'hello' })
  const text =
    Array.isArray(call.content) && call.content[0] && 'text' in call.content[0]
      ? String((call.content[0] as { text: string }).text)
      : ''
  assert(text === 'echo:hello', `call echo got ${text}`)
  await client.close()
}

async function testConnectHost() {
  const result = await connectMcpServers({
    servers: [
      {
        name: 'echo',
        command: nodeBin,
        args: [echoServer],
      },
      {
        name: 'broken',
        command: nodeBin,
        args: ['-e', 'process.exit(1)'],
      },
    ],
    timeoutMs: 10_000,
  })
  assert(result.warnings.some((w) => w.includes('broken')), 'broken warns')
  assert(
    result.tools.some((t) => t.name === mcpToolName('echo', 'echo')),
    'registered mcp__echo__echo',
  )
  const tool = result.tools.find((t) => t.name === 'mcp__echo__echo')!
  const out = await tool.call({ text: 'host' }, { cwd: process.cwd() })
  assert(out.ok && out.output.includes('echo:host'), `host call ${out.output}`)
  await closeMcpConnections(result.servers)
}

async function testSessionWiring() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mcp-'))
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
      echo: {
        command: nodeBin,
        args: [echoServer],
      },
    },
  })

  const { session, mcp } = await createSessionFromWorkspace({
    cwd: projectCwd,
    ensureDefaults: true,
    systemPrompt: false,
    connectMcp: true,
  })
  assert(mcp, 'mcp result present')
  assert(
    session.tools?.some((t) => t.name === 'mcp__echo__echo'),
    'session has mcp tool',
  )
  const t = session.tools!.find((x) => x.name === 'mcp__echo__echo')!
  const r = await t.call({ text: 'sess' }, { cwd: projectCwd })
  assert(r.ok && r.output.includes('echo:sess'), 'session tool call')
  await closeSessionMcp(session)
}

async function testNamesAndConfig() {
  assert(mcpToolName('s', 't') === 'mcp__s__t', 'name')
  assert(parseMcpToolName('mcp__s__t')?.server === 's', 'parse server')
  assert(parseMcpToolName('mcp__s__t')?.tool === 't', 'parse tool')
  assert(parseMcpToolName('Bash') === null, 'non-mcp')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mcp-cfg-'))
  const f = path.join(tmp, 'mcp.json')
  await fs.writeFile(
    f,
    JSON.stringify({
      mcpServers: {
        x: { command: 'node', args: ['a.js'], env: { A: '1' } },
      },
    }),
    'utf8',
  )
  const servers = await loadMcpConfigFile(f)
  assert(servers.length === 1 && servers[0]!.name === 'x', 'load config')
  assert(servers[0]!.env?.A === '1', 'env kept')
}

async function main() {
  await testFraming()
  await testNamesAndConfig()
  await testStdioListCall()
  await testConnectHost()
  await testSessionWiring()
  console.log('MCP STDIO TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})