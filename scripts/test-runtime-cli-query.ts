/**
 * AR1A：runtime list/inspect query view-model 与非交互 CLI。
 * 运行：npx tsx scripts/test-runtime-cli-query.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  queryRuntimeSnapshot,
  type RuntimeInspectView,
  type RuntimeListView,
} from '../packages/shared/src/runtimeQuery.ts'
import {
  SessionCoordinator,
  appendTaskEntry,
  appendTurnEntry,
  buildRuntimeSnapshot,
  createSession,
  ensureTranscriptFile,
  metaInputFromSession,
  projectDurableTaskEvents,
  projectDurableTurnEvents,
} from '../packages/core/src/index.ts'
import {
  formatHelp,
  parseArgs,
} from '../packages/cli/src/parseArgs.ts'
import { runRuntimeQueryCli } from '../packages/cli/src/runtimeCli.ts'

const inMemory = await createSession({
  cwd: process.cwd(),
  sessionId: 'runtime_query_contract',
  coordinator: new SessionCoordinator(),
  systemPrompt: false,
})
inMemory.durableTurns = projectDurableTurnEvents(
  [
    {
      turnId: 'turn_completed',
      state: 'admitted',
      timestamp: '2026-07-26T10:00:00.000Z',
      prompt: 'completed prompt',
    },
    {
      turnId: 'turn_completed',
      state: 'completed',
      timestamp: '2026-07-26T10:00:01.000Z',
      terminalReason: 'completed',
    },
    {
      turnId: 'turn_interrupted',
      state: 'interrupted',
      timestamp: '2026-07-26T10:00:02.000Z',
      prompt: 'inspect interrupted prompt',
    },
  ],
  { recoverIncomplete: false },
)
inMemory.durableTasks = projectDurableTaskEvents(
  [
    {
      type: 'state',
      taskId: 'task_admitted',
      sessionId: inMemory.id,
      agentType: 'explore',
      state: 'admitted',
      timestamp: '2026-07-26T10:01:00.000Z',
      prompt: 'inspect runtime query',
    },
  ],
  { recoverIncomplete: false },
)
const snapshot = buildRuntimeSnapshot(inMemory, {
  generatedAt: '2026-07-26T10:02:00.000Z',
})

const all = queryRuntimeSnapshot(snapshot, { action: 'list' })
assert.equal(all.ok, true)
if (!all.ok) throw new Error('runtime list unexpectedly failed')
assert.equal(all.view.kind, 'runtime.list')
if (all.view.kind !== 'runtime.list') {
  throw new Error('runtime list returned an inspect view')
}
assert.equal(all.view.entity, 'all')
assert.deepEqual(
  all.view.items.map((item) => `${item.entity}:${item.entityId}`),
  [
    'turn:turn_completed',
    'turn:turn_interrupted',
    'task:task_admitted',
  ],
)

const turns = queryRuntimeSnapshot(snapshot, {
  action: 'list',
  entity: 'turn',
})
assert.equal(turns.ok, true)
if (!turns.ok) throw new Error('runtime turn list unexpectedly failed')
if (turns.view.kind !== 'runtime.list') {
  throw new Error('runtime turn list returned an inspect view')
}
assert(
  turns.view.items.every((item) => item.entity === 'turn'),
  'entity-filtered list contains only turns',
)

const inspected = queryRuntimeSnapshot(snapshot, {
  action: 'inspect',
  entity: 'task',
  entityId: 'task_admitted',
})
assert.equal(inspected.ok, true)
if (!inspected.ok) throw new Error('runtime inspect unexpectedly failed')
assert.equal(inspected.view.kind, 'runtime.inspect')
if (inspected.view.kind !== 'runtime.inspect') {
  throw new Error('runtime inspect returned a list view')
}
assert.equal(inspected.view.entity, 'task')
assert.equal(inspected.view.item.entityId, 'task_admitted')
assert.equal(inspected.view.item.record.state, 'admitted')

const missing = queryRuntimeSnapshot(snapshot, {
  action: 'inspect',
  entity: 'turn',
  entityId: 'turn_missing',
})
assert.equal(missing.ok, false)
if (!missing.ok) assert.equal(missing.code, 'not_found')

const listCopy = all.view as RuntimeListView
const inspectCopy = inspected.view as RuntimeInspectView
;(listCopy.items[0]?.record as { state: string }).state = 'mutated'
assert.equal(
  snapshot.session.turns[0]?.state,
  'completed',
  'query view never exposes mutable snapshot records',
)
;(inspectCopy.item.record as { state: string }).state = 'mutated'
assert.equal(snapshot.session.tasks[0]?.state, 'admitted')

const parsedList = parseArgs([
  'runtime',
  'list',
  'turn',
  '--resume',
  'session_a',
  '--json',
])
assert.deepEqual(parsedList.runtimeQuery, {
  action: 'list',
  entity: 'turn',
})
assert.equal(parsedList.resume, 'session_a')
assert.equal(parsedList.json, true)
assert.equal(parsedList.prompt, undefined)

const parsedInspect = parseArgs([
  '--continue',
  '--json',
  'runtime',
  'inspect',
  'task',
  'task_a',
])
assert.deepEqual(parsedInspect.runtimeQuery, {
  action: 'inspect',
  entity: 'task',
  entityId: 'task_a',
})
assert.equal(parsedInspect.continue, true)
assert.equal(parsedInspect.json, true)
assert.throws(
  () => parseArgs(['runtime', 'inspect', 'turn']),
  /runtime inspect requires/,
)
assert.throws(
  () => parseArgs(['runtime', 'list', 'unknown']),
  /runtime entity/,
)
assert.throws(() => parseArgs(['--json']), /--json requires runtime/)
assert.throws(
  () =>
    parseArgs([
      'runtime',
      'list',
      '--resume',
      'session_a',
      '--continue',
    ]),
  /either --resume or --continue/,
)
assert.match(formatHelp(), /bolo runtime list/)
assert.match(formatHelp(), /bolo runtime inspect/)

const tempBase = path.resolve('.bolo-tmp')
await fs.mkdir(tempBase, { recursive: true })
const root = path.resolve(
  tempBase,
  `runtime-cli-query-${process.pid}-${Date.now()}`,
)
const relativeRoot = path.relative(tempBase, root)
assert(
  relativeRoot !== '' &&
    !relativeRoot.startsWith(`..${path.sep}`) &&
    relativeRoot !== '..' &&
    !path.isAbsolute(relativeRoot),
  'temporary test root stays inside .bolo-tmp',
)
await fs.mkdir(root, { recursive: true })

try {
  const transcript = path.join(root, 'runtime_cli_query.jsonl')
  const seed = await createSession({
    cwd: root,
    sessionId: 'runtime_cli_query',
    systemPrompt: false,
  })
  await ensureTranscriptFile(transcript, metaInputFromSession(seed))
  await appendTurnEntry(transcript, {
    sessionId: seed.id,
    turnId: 'turn_cli_interrupted',
    state: 'admitted',
    prompt: 'query this turn without calling a provider',
  })
  await appendTaskEntry(transcript, {
    taskId: 'task_cli_interrupted',
    sessionId: seed.id,
    agentType: 'explore',
    state: 'admitted',
    timestamp: '2026-07-26T10:03:00.000Z',
    prompt: 'query this task',
  })

  const projectSessions = path.join(root, '.bolo', 'sessions')
  await fs.mkdir(projectSessions, { recursive: true })
  const continueTranscript = path.join(
    projectSessions,
    'runtime_cli_continue.jsonl',
  )
  const continueSeed = await createSession({
    cwd: root,
    sessionId: 'runtime_cli_continue',
    systemPrompt: false,
  })
  await ensureTranscriptFile(
    continueTranscript,
    metaInputFromSession(continueSeed),
  )
  await appendTurnEntry(continueTranscript, {
    sessionId: continueSeed.id,
    turnId: 'turn_cli_continue',
    state: 'admitted',
    prompt: 'latest project runtime query',
  })

  const out: string[] = []
  const err: string[] = []
  const direct = await runRuntimeQueryCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    query: { action: 'list', entity: 'turn' },
    json: true,
    writeOut: (text: string) => out.push(text),
    writeErr: (text: string) => err.push(text),
  })
  assert.equal(direct.exitCode, 0)
  assert.equal(err.join(''), '')
  assert.equal(out.length, 1, 'JSON mode writes one complete payload')
  const directJson = JSON.parse(out.join('')) as RuntimeListView
  assert.equal(directJson.kind, 'runtime.list')
  assert.equal(directJson.entity, 'turn')
  assert.deepEqual(
    directJson.items.map((item) => item.entityId),
    ['turn_cli_interrupted'],
  )

  const missingOut: string[] = []
  const missingCli = await runRuntimeQueryCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    query: {
      action: 'inspect',
      entity: 'task',
      entityId: 'task_missing',
    },
    json: true,
    writeOut: (text: string) => missingOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(missingCli.exitCode, 1)
  const missingJson = JSON.parse(missingOut.join('')) as {
    ok: boolean
    code: string
  }
  assert.equal(missingJson.ok, false)
  assert.equal(missingJson.code, 'not_found')

  const configDir = path.join(root, 'config')
  await fs.mkdir(configDir, { recursive: true })
  const executable = path.resolve('packages/cli/bin/bolo.js')
  const spawned = spawnSync(
    process.execPath,
    [
      executable,
      'runtime',
      'inspect',
      'turn',
      'turn_cli_interrupted',
      '--resume',
      transcript,
      '--json',
      '--cwd',
      root,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOLO_PROVIDER: 'mock',
        BOLO_CONFIG_DIR: configDir,
        NO_COLOR: '1',
      },
    },
  )
  assert.equal(spawned.status, 0, spawned.stderr)
  assert.equal(
    spawned.stdout.includes('BOLO'),
    false,
    'runtime JSON stdout has no banner or summary',
  )
  const spawnedJson = JSON.parse(spawned.stdout) as RuntimeInspectView
  assert.equal(spawnedJson.kind, 'runtime.inspect')
  assert.equal(spawnedJson.entity, 'turn')
  assert.equal(spawnedJson.item.entityId, 'turn_cli_interrupted')
  assert.deepEqual(
    spawnedJson.item.availableActions.map((action) => action.action),
    ['runtime.discard', 'runtime.retry-safe'],
  )

  const continued = spawnSync(
    process.execPath,
    [
      executable,
      'runtime',
      'list',
      'turn',
      '--continue',
      '--json',
      '--cwd',
      root,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOLO_PROVIDER: 'mock',
        BOLO_CONFIG_DIR: configDir,
        NO_COLOR: '1',
      },
    },
  )
  assert.equal(continued.status, 0, continued.stderr)
  const continuedJson = JSON.parse(continued.stdout) as RuntimeListView
  assert.equal(continuedJson.sessionId, 'runtime_cli_continue')
  assert.deepEqual(
    continuedJson.items.map((item) => item.entityId),
    ['turn_cli_continue'],
  )

  const loadFailure = spawnSync(
    process.execPath,
    [
      executable,
      'runtime',
      'list',
      '--resume',
      path.join(root, 'missing.jsonl'),
      '--json',
      '--cwd',
      root,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOLO_PROVIDER: 'mock',
        BOLO_CONFIG_DIR: configDir,
      },
    },
  )
  assert.equal(loadFailure.status, 1)
  assert.equal(loadFailure.stderr, '')
  const loadFailureJson = JSON.parse(loadFailure.stdout) as {
    ok: boolean
    code: string
  }
  assert.equal(loadFailureJson.ok, false)
  assert.equal(loadFailureJson.code, 'load_failed')

  const noSession = spawnSync(
    process.execPath,
    [executable, 'runtime', 'list', '--json', '--cwd', root],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOLO_PROVIDER: 'mock',
        BOLO_CONFIG_DIR: configDir,
      },
    },
  )
  assert.equal(noSession.status, 2)
  assert.match(noSession.stderr, /requires --resume <id\\|path> or --continue/)

  console.log('PASS: test-runtime-cli-query')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
