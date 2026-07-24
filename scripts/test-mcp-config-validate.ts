/**
 * MCP 配置校验 + headers 脱敏（M-GEN-1 / M-GEN-3 最小）
 * 运行：node --import tsx/esm scripts/test-mcp-config-validate.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validateMcpServerConfig,
  validateMcpServerConfigs,
  redactMcpHeaders,
  formatMcpServerConfigSummary,
  loadMcpConfigFileDetailed,
  resolveMcpTransport,
  connectMcpServers,
  closeMcpConnections,
} from '../packages/mcp/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// resolve transport
assert(resolveMcpTransport({ name: 'a', command: 'node' }) === 'stdio', 'infer stdio')
assert(
  resolveMcpTransport({ name: 'a', url: 'http://x' }) === 'http',
  'infer http',
)
assert(
  resolveMcpTransport({ name: 'a', type: 'sse', url: 'http://x' }) === 'sse',
  'explicit sse',
)

// missing command/url
const miss = validateMcpServerConfig({ name: 'bad' })
assert(miss.some((i) => i.level === 'error' && i.message.includes('command')), 'need command/url')

// type conflict
const stdioNoCmd = validateMcpServerConfig({
  name: 's',
  type: 'stdio',
  url: 'http://x',
})
assert(
  stdioNoCmd.some((i) => i.message.includes('command') && i.level === 'error'),
  'stdio needs command',
)

const httpNoUrl = validateMcpServerConfig({
  name: 'h',
  type: 'http',
  command: 'node',
})
assert(httpNoUrl.some((i) => i.message.includes('url')), 'http needs url')

// both without type → warning, still http
const both = validateMcpServerConfig({
  name: 'b',
  command: 'node',
  url: 'http://127.0.0.1:1',
})
assert(
  both.some((i) => i.level === 'warning' && i.message.includes('inferred')),
  'both command+url warn',
)
assert(resolveMcpTransport({ name: 'b', command: 'node', url: 'http://x' }) === 'http', 'url wins')

// invalid type
const badType = validateMcpServerConfig({
  name: 't',
  type: 'websocket' as never,
  url: 'http://x',
})
assert(badType.some((i) => i.message.includes('invalid type')), 'invalid type')

// ok stdio
const ok = validateMcpServerConfig({
  name: 'echo',
  command: 'node',
  args: ['x.js'],
})
assert(ok.filter((i) => i.level === 'error').length === 0, 'ok stdio no errors')

// reconnect on non-sse
const recon = validateMcpServerConfig({
  name: 'h2',
  type: 'http',
  url: 'http://x',
  reconnectAttempts: 3,
})
assert(recon.some((i) => i.message.includes('reconnect')), 'reconnect only sse')

// headers redact
const red = redactMcpHeaders({
  Authorization: 'Bearer secret-token-value',
  'X-Api-Key': 'abcdefghijklmnop',
  Accept: 'application/json',
})!
assert(red.Authorization !== 'Bearer secret-token-value', 'auth redacted')
assert(red.Authorization.includes('***'), 'auth stars')
assert(red.Accept === 'application/json', 'accept kept')
assert(red['X-Api-Key'] !== 'abcdefghijklmnop', 'api-key redacted')

const sum = formatMcpServerConfigSummary({
  name: 'remote',
  type: 'http',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer super-secret-key' },
})
assert(sum.includes('remote'), 'summary name')
assert(sum.includes('[http]'), 'summary transport')
assert(!sum.includes('super-secret-key'), 'summary no secret')
assert(sum.includes('***'), 'summary redacted')

// load file detailed
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mcp-cfg-'))
const good = path.join(tmp, 'good.json')
await fs.writeFile(
  good,
  JSON.stringify({
    mcpServers: {
      ok: { command: 'node', args: ['a.js'] },
      bad: { type: 'http' },
      both: { command: 'node', url: 'http://127.0.0.1:9' },
    },
  }),
  'utf8',
)
const loaded = await loadMcpConfigFileDetailed(good)
assert(loaded.servers.some((s) => s.name === 'ok'), 'ok loaded')
assert(!loaded.servers.some((s) => s.name === 'bad'), 'bad skipped')
assert(loaded.servers.some((s) => s.name === 'both'), 'both still loadable')
assert(loaded.warnings.length >= 1, 'warnings present')
assert(
  loaded.warnings.some((w) => w.includes('url') || w.includes('http')),
  'bad url warning',
)

const badJson = path.join(tmp, 'bad.json')
await fs.writeFile(badJson, '{not json', 'utf8')
const badLoad = await loadMcpConfigFileDetailed(badJson)
assert(badLoad.servers.length === 0, 'bad json no servers')
assert(badLoad.warnings.some((w) => w.includes('invalid JSON')), 'bad json warn')

// connect skips invalid without throwing
const conn = await connectMcpServers({
  servers: [
    { name: 'missing-bits' },
    { name: 'stdio-no-cmd', type: 'stdio' },
  ],
  cwd: tmp,
})
assert(conn.servers.length === 0, 'no connections')
assert(conn.warnings.length >= 2, 'connect warnings')
assert(
  (conn.failures?.length ?? 0) >= 2,
  'connect failures structured',
)
assert(
  conn.failures?.some((f) => f.name === 'missing-bits' && f.error),
  'failure has error text',
)
await closeMcpConnections(conn.servers)

const dups = validateMcpServerConfigs([
  { name: 'x', command: 'node' },
  { name: 'x', command: 'node' },
])
assert(dups.some((i) => i.message.includes('duplicate')), 'duplicate name')

console.log('MCP CONFIG VALIDATE TESTS PASS')