/**
 * AR1C2a：runtime automation JSON / exit / stdout contract。
 * 运行：npx tsx scripts/test-runtime-cli-automation.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import {
  RUNTIME_CLI_FAILURE_CODES,
  formatRuntimeCliFailure,
  formatRuntimeQueryJson,
  type RuntimeCliFailure,
} from '../packages/cli/src/runtimeCli.ts'
import type { RuntimeListView } from '../packages/shared/src/runtimeQuery.ts'

const view: RuntimeListView = {
  protocolVersion: 1,
  kind: 'runtime.list',
  generatedAt: '2026-07-26T14:00:00.000Z',
  sessionId: 'runtime_automation',
  phase: 'idle',
  runner: { state: 'idle' },
  entity: 'turn',
  items: [
    {
      entity: 'turn',
      entityId: 'turn_a',
      record: {
        turnId: 'turn_a',
        state: 'completed',
        updatedAt: '2026-07-26T14:00:00.000Z',
        terminalReason: 'completed',
      },
      availableActions: [],
    },
  ],
}

assert.equal(
  formatRuntimeQueryJson(view),
  '{"protocolVersion":1,"kind":"runtime.list","generatedAt":"2026-07-26T14:00:00.000Z","sessionId":"runtime_automation","phase":"idle","runner":{"state":"idle"},"entity":"turn","items":[{"entity":"turn","entityId":"turn_a","record":{"turnId":"turn_a","state":"completed","updatedAt":"2026-07-26T14:00:00.000Z","terminalReason":"completed"},"availableActions":[]}]}',
)

const additive = {
  ...view,
  futureField: {
    supported: true,
  },
} as RuntimeListView
assert.match(
  formatRuntimeQueryJson(additive),
  /"futureField":\{"supported":true\}/,
  'automation serializer preserves additive fields',
)

const failure: RuntimeCliFailure = {
  ok: false,
  code: 'usage',
  detail: 'bad runtime arguments',
}
assert.equal(
  formatRuntimeCliFailure(failure),
  '{"ok":false,"code":"usage","detail":"bad runtime arguments"}',
)
assert.deepEqual(RUNTIME_CLI_FAILURE_CODES, [
  'usage',
  'load_failed',
  'invalid_query',
  'not_found',
  'pager_failed',
])

const executable = path.resolve('packages/cli/bin/bolo.js')
const baseEnv = {
  ...process.env,
  BOLO_PROVIDER: 'mock',
  NO_COLOR: '1',
}

function spawn(args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: baseEnv,
  })
}

const parseFailure = spawn([
  'runtime',
  'inspect',
  'turn',
  '--json',
])
assert.equal(parseFailure.status, 2)
assert.equal(parseFailure.stderr, '')
assert.equal(parseFailure.stdout.trim().split('\n').length, 1)
assert.deepEqual(JSON.parse(parseFailure.stdout), {
  ok: false,
  code: 'usage',
  detail: 'runtime inspect requires <turn|control|task> <id>',
})

const invalidEntity = spawn([
  'runtime',
  'list',
  'unknown',
  '--json',
])
assert.equal(invalidEntity.status, 2)
assert.equal(invalidEntity.stderr, '')
assert.deepEqual(JSON.parse(invalidEntity.stdout), {
  ok: false,
  code: 'usage',
  detail: 'runtime entity must be turn, control, or task',
})

const queryNoSession = spawn(['runtime', 'list', '--json'])
assert.equal(queryNoSession.status, 2)
assert.equal(queryNoSession.stderr, '')
assert.deepEqual(JSON.parse(queryNoSession.stdout), {
  ok: false,
  code: 'usage',
  detail:
    'runtime query requires --resume <id|path> or --continue',
})

const commandNoSession = spawn([
  'runtime',
  'discard',
  'turn',
  'turn_missing',
  '--json',
])
assert.equal(commandNoSession.status, 2)
assert.equal(commandNoSession.stderr, '')
assert.deepEqual(JSON.parse(commandNoSession.stdout), {
  ok: false,
  code: 'usage',
  detail:
    'runtime command requires --resume <id|path> or --continue',
})

const textUsage = spawn(['runtime', 'inspect', 'turn'])
assert.equal(textUsage.status, 2)
assert.equal(textUsage.stdout, '')
assert.match(textUsage.stderr, /^error: runtime inspect requires/)
assert.match(textUsage.stderr, /用法:/)

console.log('PASS: test-runtime-cli-automation')
