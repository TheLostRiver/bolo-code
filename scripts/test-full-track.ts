/**
 * TODO_FULL 最小验收：TUI / compact-cache / SA / oauth / policy / memory daily
 * 运行：node --import tsx/esm scripts/test-full-track.ts
 */
import {
  applyArrowPickerKey,
  formatArrowPickerScreen,
  renderInkLayout,
  resolveTuiTheme,
  renderWelcomeBanner,
} from '../packages/cli/src/index.ts'
import {
  cachedMicrocompactMessages,
  formatSnipBoundaryContent,
  newSnipId,
  parseSnipBoundaryId,
  createPromptCacheSessionState,
  shouldBreakPromptCache,
  touchPromptCacheSession,
  appendMemoryDailyLog,
  getTeamMemoryDir,
  ensureTeamMemoryDir,
  canStartBackgroundAgent,
  createBackgroundAgentStore,
  markBackgroundAgentRunning,
  getBackgroundOverflowPolicy,
} from '../packages/core/src/index.ts'
import {
  applyBearerAuthHeaders,
  maybeInjectMcpOAuthHeaders,
} from '../packages/mcp/src/oauth.ts'
import {
  resolveSandboxMode,
  applySandboxEnv,
  mergePolicyDenyPrefixes,
} from '../packages/permissions/src/policy.ts'
import {
  filterToolsBySubagentAllowlist,
  resolveSubagentToolNames,
} from '../packages/permissions/src/index.ts'
import { isWorktreeEnabled } from '../packages/core/src/worktree.ts'
import { createOpenAIResponsesWsProvider } from '../packages/providers/src/openaiResponsesWs.ts'
import { pluginUpdateHint } from '../packages/plugins/src/marketplace.ts'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// F1 TUI
assert(applyArrowPickerKey(0, 3, 'down').index === 1, 'arrow down')
assert(applyArrowPickerKey(2, 3, 'down').index === 0, 'arrow wrap')
assert(applyArrowPickerKey(1, 3, 'enter').done === 'select', 'arrow enter')
assert(
  formatArrowPickerScreen(
    [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    1,
  ).includes('›'),
  'picker screen',
)
const layout = renderInkLayout({
  columns: 100,
  plain: false,
  session: { permissionMode: 'default', messages: { length: 0 } },
  env: {} as NodeJS.ProcessEnv,
})
assert(layout.includes('┌') || layout.includes('BOLO'), 'ink layout')
const th = resolveTuiTheme({ env: { BOLO_THEME: 'plain' } as NodeJS.ProcessEnv })
assert(th.id === 'plain', 'theme plain')
const noMascot = renderWelcomeBanner({
  columns: 120,
  plain: false,
  mascot: false,
  env: {} as NodeJS.ProcessEnv,
})
assert(!noMascot.includes('Bolot'), 'mascot off')

// F2 compact/cache
const msgs = [
  { role: 'user' as const, content: 'hi' },
  {
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ id: 't1', name: 'Bash', arguments: '{}' }],
  },
  { role: 'tool' as const, tool_call_id: 't1', content: 'x'.repeat(500) },
  {
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ id: 't2', name: 'Bash', arguments: '{}' }],
  },
  { role: 'tool' as const, tool_call_id: 't2', content: 'recent' },
]
const cmc = cachedMicrocompactMessages(msgs, {
  keepRecentToolResults: 1,
})
assert(cmc.cacheFriendly === true, 'cache friendly')
const sid = newSnipId()
const boundary = formatSnipBoundaryContent({
  snipId: sid,
  removedCount: 2,
  at: new Date().toISOString(),
})
assert(parseSnipBoundaryId(boundary) === sid, 'snip id roundtrip')
let pcs = createPromptCacheSessionState(1000)
pcs = touchPromptCacheSession(pcs, 'stable-a')
assert(
  shouldBreakPromptCache(pcs, 'stable-b').reason === 'system_prefix_changed',
  'prefix break',
)
assert(
  shouldBreakPromptCache(
    { ...pcs, lastCacheAt: Date.now() - 5000, ttlMs: 1000 },
    'stable-a',
  ).break,
  'ttl break',
)

// F3 SA
assert(getBackgroundOverflowPolicy({} as NodeJS.ProcessEnv) === 'reject', 'overflow default')
const store = createBackgroundAgentStore({ maxConcurrent: 1 })
markBackgroundAgentRunning(store, {
  agentId: 'x',
  agentType: 'general',
  prompt: 'p',
})
const cap = canStartBackgroundAgent(store, { policy: 'queue' })
assert(!cap.ok && cap.policy === 'queue', 'queue policy')
assert(!isWorktreeEnabled({} as NodeJS.ProcessEnv), 'wt off default')
assert(
  resolveSubagentToolNames(['Read', 'No'], ['Read', 'Write']).includes('Read'),
  'tool allowlist',
)
assert(
  filterToolsBySubagentAllowlist(
    [{ name: 'Read' }, { name: 'Write' }],
    ['Read'],
  ).length === 1,
  'filter tools',
)

// F4 oauth / ws / plugin hint
const h = applyBearerAuthHeaders({}, 'tok')
assert(h.Authorization === 'Bearer tok', 'bearer')
const inj = await maybeInjectMcpOAuthHeaders({}, {} as NodeJS.ProcessEnv)
assert(inj.injected === false, 'no token file')
const ws = createOpenAIResponsesWsProvider()
assert(ws.id.includes('ws'), 'ws provider id')
assert(
  pluginUpdateHint({ id: 'a', version: '1.0.0', scope: 'user', installPath: '', installedAt: '', source: '' }, '1.1.0')?.includes('1.1.0'),
  'update hint',
)

// F5 policy/sandbox
assert(resolveSandboxMode({} as NodeJS.ProcessEnv) === 'off', 'sandbox off')
const se = applySandboxEnv({}, 'prefer')
assert(se.env.BOLO_SANDBOX_ACTIVE === '1', 'sandbox mark')
assert(
  mergePolicyDenyPrefixes(['rm'], { denyBashPrefixes: ['sudo'] }).includes('sudo'),
  'policy deny',
)

// F6 memory daily
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-full-'))
const daily = await appendMemoryDailyLog('note one', { userBoloDir: tmp })
assert((await fs.readFile(daily, 'utf8')).includes('note one'), 'daily log')
const team = await ensureTeamMemoryDir({ userBoloDir: tmp })
assert(team.includes('team'), 'team dir')
assert(getTeamMemoryDir({ userBoloDir: tmp }).endsWith('team'), 'team path')

console.log('FULL TRACK TESTS PASS')