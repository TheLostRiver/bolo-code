/**
 * P-SA-CAP 后台并发上限 + P-T9 窄终端
 * 运行：node --import tsx/esm scripts/test-product-track.ts
 */
import {
  createBackgroundAgentStore,
  canStartBackgroundAgent,
  countRunningBackgroundAgents,
  getDefaultMaxBackgroundAgents,
  markBackgroundAgentRunning,
  markBackgroundAgentFinished,
} from '../packages/core/src/subagent.ts'
import {
  shouldUsePlainBanner,
  isNarrowTerminal,
  getTerminalColumns,
  renderWelcomeBanner,
  NARROW_TERMINAL_COLUMNS,
} from '../packages/cli/src/tui/banner.ts'
import { formatSessionStatusLine } from '../packages/cli/src/tui/statusLine.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// --- SA-CAP ---
assert(getDefaultMaxBackgroundAgents({}) === 3, 'default max 3')
assert(
  getDefaultMaxBackgroundAgents({ BOLO_MAX_BACKGROUND_AGENTS: '5' } as NodeJS.ProcessEnv) === 5,
  'env max',
)
const store = createBackgroundAgentStore({ maxConcurrent: 2 })
assert(canStartBackgroundAgent(store).ok, 'can start 0')
markBackgroundAgentRunning(store, {
  agentId: 'a1',
  agentType: 'general',
  prompt: 'p1',
})
markBackgroundAgentRunning(store, {
  agentId: 'a2',
  agentType: 'general',
  prompt: 'p2',
})
assert(countRunningBackgroundAgents(store) === 2, 'running 2')
const blocked = canStartBackgroundAgent(store)
assert(!blocked.ok, 'blocked at cap')
if (!blocked.ok) {
  assert(blocked.reason.includes('limit'), 'reason mentions limit')
}
markBackgroundAgentFinished(store, {
  agentId: 'a1',
  agentType: 'general',
  summary: 'done',
  isError: false,
})
assert(canStartBackgroundAgent(store).ok, 'can start after finish')

// --- T9 narrow ---
assert(getTerminalColumns({ columns: 40 }) === 40, 'columns')
assert(isNarrowTerminal({ columns: 40 }), 'narrow 40')
assert(!isNarrowTerminal({ columns: 120 }), 'wide 120')
assert(
  shouldUsePlainBanner({ columns: 50, env: {} as NodeJS.ProcessEnv }),
  'plain when narrow',
)
assert(
  !shouldUsePlainBanner({
    columns: 120,
    plain: false,
    env: {} as NodeJS.ProcessEnv,
  }),
  'full when wide and plain false',
)
const plainBan = renderWelcomeBanner({
  columns: 40,
  version: '0.0.1',
})
assert(!plainBan.includes('──◆──'), 'no art on narrow')
assert(plainBan.includes('BOLO'), 'has BOLO')
const fullBan = renderWelcomeBanner({
  columns: 120,
  plain: false,
  version: '0.0.1',
})
assert(fullBan.includes('──◆──'), 'full banner uses the crystal mark')

const short = formatSessionStatusLine(
  { permissionMode: 'default', model: 'gpt-test', messages: { length: 3 } },
  { columns: 40 },
)
assert(short.includes('m=') || short.includes('n=3'), 'compact status')
const wide = formatSessionStatusLine(
  { permissionMode: 'default', model: 'gpt-test', messages: { length: 3 } },
  { columns: 120 },
)
assert(wide.includes('mode=') && wide.includes('messages=3'), 'full status')
assert(NARROW_TERMINAL_COLUMNS === 80, 'threshold 80')

console.log('PRODUCT TRACK TESTS PASS')
