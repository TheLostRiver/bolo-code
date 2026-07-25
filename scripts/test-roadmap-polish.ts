/**
 * ROADMAP polish: OS sandbox plan · OAuth save · policy
 * 运行：node --import tsx/esm scripts/test-roadmap-polish.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectOsSandboxKind,
  planSandboxedShell,
  cleanupOsSandboxPlan,
} from '../packages/permissions/src/osSandbox.ts'
import {
  saveOAuthTokenFile,
  exchangeAuthorizationCode,
} from '../packages/mcp/src/oauthLocal.ts'
import {
  loadMcpOAuthTokenFile,
  maybeInjectMcpOAuthHeaders,
} from '../packages/mcp/src/oauth.ts'
import { createBashTool } from '../packages/tools/src/index.ts'

function assert(c, m) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// OS sandbox plan — off
const off = await planSandboxedShell({
  command: 'echo hi',
  cwd: process.cwd(),
  mode: 'off',
})
assert(off.isolated === false, 'off not isolated')
assert(off.args.includes('echo hi') || off.args.some((a) => String(a).includes('echo')), 'off has command')

// prefer: may or may not isolate depending on platform tools
const pref = await planSandboxedShell({
  command: 'echo hi',
  cwd: process.cwd(),
  mode: 'prefer',
})
assert(pref.file, 'prefer has file')
await cleanupOsSandboxPlan(pref)

const kind = detectOsSandboxKind()
assert(['none', 'bwrap', 'sandbox-exec'].includes(kind), 'kind enum')

// require without tool → not isolated (Windows always)
const req = await planSandboxedShell({
  command: 'echo x',
  cwd: process.cwd(),
  mode: 'require',
  platform: 'win32',
})
assert(req.isolated === false, 'win32 require not isolated')
assert(req.warning, 'win32 warning')

// OAuth token save + inject
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-oauth-'))
const tokenPath = path.join(tmp, 'tok.json')
await saveOAuthTokenFile(tokenPath, {
  access_token: 'test-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
})
const loaded = await loadMcpOAuthTokenFile(tokenPath)
assert(loaded?.access_token === 'test-access-token', 'token load')
const inj = await maybeInjectMcpOAuthHeaders(
  {},
  { BOLO_MCP_OAUTH_TOKEN_FILE: tokenPath },
)
assert(inj.injected && inj.headers?.Authorization?.includes('test-access-token'), 'inject')

// exchange mock
const raw = await exchangeAuthorizationCode({
  tokenUrl: 'https://example.test/token',
  clientId: 'cid',
  code: 'c',
  redirectUri: 'http://127.0.0.1/callback',
  fetchImpl: async () =>
    new Response(JSON.stringify({ access_token: 'ex', token_type: 'Bearer' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
})
assert(raw.access_token === 'ex', 'exchange')

// Bash still policy-denies
const polDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-pol2-'))
await fs.mkdir(path.join(polDir, '.bolo'), { recursive: true })
await fs.writeFile(
  path.join(polDir, '.bolo', 'policy.json'),
  JSON.stringify({ denyBashPrefixes: ['nope'] }),
  'utf8',
)
const bash = createBashTool()
const d = await bash.call({ command: 'nope 1' }, { cwd: polDir })
assert(d.ok === false && d.errorCode === 'policy_deny', 'policy still works')

console.log('ROADMAP POLISH TESTS PASS')