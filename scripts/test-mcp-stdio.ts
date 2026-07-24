/**
 * MCP stdio 真连接测试 — tools + resources + prompts + list_changed 热刷新（MCP2）
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
  mergeSessionToolsWithMcp,
  parseMcpToolName,
  coerceMcpPromptArguments,
  safeListMcpResources,
  safeListMcpPrompts,
  McpStdioClient,
  type McpListChangedEvent,
} from '../packages/mcp/src/index.ts'
import {
  createSessionFromWorkspace,
  closeSessionMcp,
  dispatchSlashCommand,
  type SessionEvent,
} from '../packages/core/src/index.ts'
import { writeJsonFile } from '../packages/config/src/index.ts'
import type { BoloTool } from '../packages/tools/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(
  cond: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      assert(false, `timeout waiting: ${label}`)
    }
    await sleep(30)
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
  assert(client.supportsTools, 'supports tools capability')
  assert(client.supportsResources, 'supports resources capability')
  assert(client.supportsPrompts, 'supports prompts capability')

  const tools = await client.listTools()
  assert(tools.some((t) => t.name === 'echo'), 'listTools has echo')
  assert(tools.some((t) => t.name === 'mutate'), 'listTools has mutate')
  const call = await client.callTool('echo', { text: 'hello' })
  const text =
    Array.isArray(call.content) && call.content[0] && 'text' in call.content[0]
      ? String((call.content[0] as { text: string }).text)
      : ''
  assert(text === 'echo:hello', `call echo got ${text}`)

  const resources = await client.listResources()
  assert(
    resources.some((r) => r.uri === 'bolo://echo/greeting'),
    'listResources has greeting',
  )
  const contents = await client.readResource('bolo://echo/greeting')
  assert(
    contents.some((c) => c.text === 'hello-from-resource'),
    'readResource greeting text',
  )

  const prompts = await client.listPrompts()
  assert(prompts.some((p) => p.name === 'greet'), 'listPrompts has greet')
  const prompt = await client.getPrompt('greet', { who: 'bolo' })
  const msgText = JSON.stringify(prompt)
  assert(msgText.includes('bolo'), `getPrompt includes who: ${msgText}`)

  await client.close()
}

async function testListChangedHotRefresh() {
  const events: McpListChangedEvent[] = []
  let sessionTools: BoloTool[] = []

  const result = await connectMcpServers({
    servers: [
      {
        name: 'echo',
        command: nodeBin,
        args: [echoServer],
      },
    ],
    timeoutMs: 10_000,
    onListChanged: (ev) => {
      events.push(ev)
      sessionTools = mergeSessionToolsWithMcp(sessionTools, result.servers)
    },
  })
  sessionTools = result.tools

  assert(
    result.tools.some((t) => t.name === mcpToolName('echo', 'echo')),
    'initial echo tool',
  )
  assert(
    !result.tools.some((t) => t.name === mcpToolName('echo', 'extra')),
    'no extra yet',
  )

  const mutate = result.tools.find(
    (t) => t.name === mcpToolName('echo', 'mutate'),
  )!
  const m1 = await mutate.call(
    { kind: 'tools', action: 'add' },
    { cwd: process.cwd() },
  )
  assert(m1.ok && m1.output.includes('tools+extra'), `mutate tools ${m1.output}`)

  await waitFor(
    () =>
      events.some(
        (e) => e.kind === 'tools' && e.tools.some((t) => t.name === 'extra'),
      ),
    'tools list_changed with extra',
  )
  assert(
    sessionTools.some((t) => t.name === mcpToolName('echo', 'extra')),
    'session tools gained mcp__echo__extra',
  )
  const echoConn = result.servers.find((s) => s.name === 'echo')!
  assert(
    echoConn.tools.some((t) => t.name === 'extra'),
    'conn.tools cache has extra',
  )

  const m2 = await mutate.call(
    { kind: 'resources', action: 'add' },
    { cwd: process.cwd() },
  )
  assert(m2.ok, 'mutate resources')
  await waitFor(
    () =>
      events.some(
        (e) =>
          e.kind === 'resources' &&
          e.resources.some((r) => r.uri === 'bolo://echo/extra'),
      ),
    'resources list_changed',
  )
  assert(
    echoConn.resources.some((r) => r.uri === 'bolo://echo/extra'),
    'conn.resources has extra',
  )

  const m3 = await mutate.call(
    { kind: 'prompts', action: 'add' },
    { cwd: process.cwd() },
  )
  assert(m3.ok, 'mutate prompts')
  await waitFor(
    () =>
      events.some(
        (e) => e.kind === 'prompts' && e.prompts.some((p) => p.name === 'extra'),
      ),
    'prompts list_changed',
  )
  assert(
    echoConn.prompts.some((p) => p.name === 'extra'),
    'conn.prompts has extra',
  )

  await closeMcpConnections(result.servers)
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
  assert(
    result.tools.some((t) => t.name === 'ListMcpResources'),
    'meta ListMcpResources',
  )
  assert(
    result.tools.some((t) => t.name === 'ReadMcpResource'),
    'meta ReadMcpResource',
  )
  assert(result.tools.some((t) => t.name === 'GetMcpPrompt'), 'meta GetMcpPrompt')

  const echoConn = result.servers.find((s) => s.name === 'echo')
  assert(echoConn?.capabilities.resources === true, 'echo resources cap')
  assert(
    echoConn?.resources.some((r) => r.uri.includes('greeting')),
    'echo resources listed',
  )
  assert(echoConn?.prompts.some((p) => p.name === 'greet'), 'echo prompts listed')

  const tool = result.tools.find((t) => t.name === 'mcp__echo__echo')!
  const out = await tool.call({ text: 'host' }, { cwd: process.cwd() })
  assert(out.ok && out.output.includes('echo:host'), `host call ${out.output}`)

  const listRes = result.tools.find((t) => t.name === 'ListMcpResources')!
  const listed = await listRes.call({}, { cwd: process.cwd() })
  assert(
    listed.ok && listed.output.includes('bolo://echo/greeting'),
    `list res ${listed.output}`,
  )

  const readRes = result.tools.find((t) => t.name === 'ReadMcpResource')!
  const read = await readRes.call(
    { server: 'echo', uri: 'bolo://echo/greeting' },
    { cwd: process.cwd() },
  )
  assert(read.ok && read.output.includes('hello-from-resource'), `read ${read.output}`)

  const getPrompt = result.tools.find((t) => t.name === 'GetMcpPrompt')!
  const gp = await getPrompt.call(
    { server: 'echo', name: 'greet', arguments: { who: 'host' } },
    { cwd: process.cwd() },
  )
  assert(gp.ok && gp.output.includes('host'), `prompt ${gp.output}`)

  // M-GEN-4：空 server 过滤 / 错误路径
  const listBad = await listRes.call(
    { server: 'nope' },
    { cwd: process.cwd() },
  )
  assert(!listBad.ok && listBad.output.includes('not found'), 'list filter missing server')
  const readBad = await readRes.call(
    { server: 'echo', uri: '' },
    { cwd: process.cwd() },
  )
  assert(!readBad.ok, 'read requires uri')
  const gpBad = await getPrompt.call(
    { server: 'echo', name: 'no-such-prompt' },
    { cwd: process.cwd() },
  )
  assert(!gpBad.ok || gpBad.isError !== false, 'unknown prompt fails or empty')

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

  const events: SessionEvent[] = []
  const { session, mcp } = await createSessionFromWorkspace({
    cwd: projectCwd,
    ensureDefaults: true,
    systemPrompt: false,
    connectMcp: true,
  })
  const prevOnEvent = session.onEvent
  session.onEvent = (e) => {
    events.push(e)
    prevOnEvent(e)
  }

  assert(mcp, 'mcp result present')
  assert(
    session.tools?.some((t) => t.name === 'mcp__echo__echo'),
    'session has mcp tool',
  )
  assert(
    session.tools?.some((t) => t.name === 'ListMcpResources'),
    'session has ListMcpResources',
  )
  const t = session.tools!.find((x) => x.name === 'mcp__echo__echo')!
  const r = await t.call({ text: 'sess' }, { cwd: projectCwd })
  assert(r.ok && r.output.includes('echo:sess'), 'session tool call')

  const slashServers = await dispatchSlashCommand(session, 'mcp', '')
  assert(
    slashServers.ok && slashServers.message.includes('resources='),
    `/mcp: ${slashServers.message}`,
  )
  const slashRes = await dispatchSlashCommand(session, 'mcp', 'resources')
  assert(
    slashRes.ok && slashRes.message.includes('bolo://echo/greeting'),
    `/mcp resources: ${slashRes.message}`,
  )
  const slashPrompts = await dispatchSlashCommand(session, 'mcp', 'prompts')
  assert(
    slashPrompts.ok && slashPrompts.message.includes('greet'),
    `/mcp prompts: ${slashPrompts.message}`,
  )

  // 会话层 list_changed：mutate → 工具表 + SessionEvent
  const mutate = session.tools!.find((x) => x.name === 'mcp__echo__mutate')!
  assert(mutate, 'session has mutate')
  const mr = await mutate.call(
    { kind: 'tools', action: 'add' },
    { cwd: projectCwd },
  )
  assert(mr.ok, `session mutate ${mr.output}`)
  await waitFor(
    () =>
      events.some(
        (e) =>
          e.type === 'mcp_list_changed' &&
          e.kind === 'tools' &&
          e.server === 'echo',
      ),
    'session mcp_list_changed event',
  )
  assert(
    session.tools?.some((x) => x.name === 'mcp__echo__extra'),
    'session tools hot-refreshed with extra',
  )

  const slashTools = await dispatchSlashCommand(session, 'mcp', 'tools')
  assert(
    slashTools.ok && slashTools.message.includes('mcp__echo__extra'),
    `/mcp tools after refresh: ${slashTools.message}`,
  )

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

  // M-GEN-4 helpers
  assert(
    Object.keys(coerceMcpPromptArguments({ a: 1, b: 'x', c: null })).join() ===
      'a,b',
    'coerce prompt args',
  )
  assert(coerceMcpPromptArguments({ a: 1 }).a === '1', 'coerce number to string')
  assert(
    Object.keys(coerceMcpPromptArguments(null)).length === 0,
    'coerce null empty',
  )
}

async function testSafeListEmptyCaps() {
  // tools-only 假 client：无 resources/prompts cap
  const client = {
    serverName: 'tools-only',
    transport: 'stdio' as const,
    isConnected: true,
    capabilities: { tools: {} },
    supportsTools: true,
    supportsResources: false,
    supportsPrompts: false,
    connect: async () => {},
    close: async () => {},
    onNotification: () => () => {},
    listTools: async () => [],
    callTool: async () => ({}),
    listResources: async () => {
      throw new Error('should not call')
    },
    readResource: async () => {
      throw new Error('should not call')
    },
    listPrompts: async () => {
      throw new Error('should not call')
    },
    getPrompt: async () => ({}),
  }
  const r = await safeListMcpResources(client)
  const p = await safeListMcpPrompts(client)
  assert(r.items.length === 0 && !r.error, 'no resources without cap')
  assert(p.items.length === 0 && !p.error, 'no prompts without cap')
}

async function main() {
  await testFraming()
  await testNamesAndConfig()
  await testSafeListEmptyCaps()
  await testStdioListCall()
  await testConnectHost()
  await testListChangedHotRefresh()
  await testSessionWiring()
  console.log('MCP STDIO TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})