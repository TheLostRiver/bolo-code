/**
 * ROADMAP 加深回归：WebFetch · policy/sandbox · desktop IPC 形状
 * 运行：node --import tsx/esm scripts/test-roadmap-closeout.ts
 */
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSession,
  productionDeps,
  submitUserInput,
} from '../packages/core/src/index.ts'
import { createMockProvider } from '../packages/providers/src/index.ts'
import {
  createWebFetchTool,
  createBashTool,
  createBuiltinTools,
} from '../packages/tools/src/index.ts'

function assert(c: unknown, m: string): asserts c {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// WebFetch in builtins
const names = createBuiltinTools().map((t) => t.name)
assert(names.includes('WebFetch'), 'WebFetch registered')

// local HTTP server for fetch
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('hello-bolo-fetch')
})
await new Promise<void>((resolve) =>
  server.listen(0, '127.0.0.1', resolve),
)
const address = server.address()
assert(address && typeof address === 'object', 'server address')
const port = address.port

const fetchTool = createWebFetchTool()
// 127.0.0.1 应被 SSRF 拦
const blocked = await fetchTool.call(
  { url: `http://127.0.0.1:${port}/` },
  { cwd: process.cwd() },
)
assert(blocked.ok === false && blocked.errorCode === 'ssrf_block', 'ssrf block')

// example.com 可能离线；用 mock：临时放行 — 测 example 不稳，改测 bad scheme
const bad = await fetchTool.call({ url: 'file:///etc/passwd' }, { cwd: process.cwd() })
assert(bad.ok === false, 'file scheme blocked')

server.close()

// policy deny on Bash
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-pol-'))
await fs.mkdir(path.join(tmp, '.bolo'), { recursive: true })
await fs.writeFile(
  path.join(tmp, '.bolo', 'policy.json'),
  JSON.stringify({ denyBashPrefixes: ['echo-forbidden'] }),
  'utf8',
)
const bash = createBashTool()
const denied = await bash.call(
  { command: 'echo-forbidden hi' },
  { cwd: tmp },
)
assert(denied.ok === false && denied.errorCode === 'policy_deny', 'policy deny bash')

// session with allow always permission path
const provider = createMockProvider()
const session = await createSession({
  cwd: tmp,
  provider,
  deps: productionDeps(provider),
  systemPrompt: false,
  permissionMode: 'bypassPermissions',
})
const help = await submitUserInput(session, '/help')
assert(help.type === 'slash', 'help')

console.log('ROADMAP CLOSEOUT TESTS PASS')
