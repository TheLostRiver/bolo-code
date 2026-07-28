/**
 * AR1A：runtime list/inspect query view-model 与非交互 CLI。
 * 运行：npx tsx scripts/test-runtime-cli-query.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
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
import type { RuntimePagerKey } from '../packages/cli/src/tui/runtimePager.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

class RuntimeRetainedInput extends EventEmitter {
  readonly isTTY = true
  isRaw = false
  readonly rawTransitions: boolean[] = []

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    this.rawTransitions.push(mode)
    return this
  }

  resume(): this {
    return this
  }

  pause(): this {
    return this
  }

  send(data: string): void {
    this.emit('data', Buffer.from(data, 'utf8'))
  }
}

class RuntimeRetainedOutput extends EventEmitter {
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
}

async function waitForRuntimePager(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

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

  const pagerTranscript = path.join(root, 'runtime_cli_pager.jsonl')
  const pagerSeed = await createSession({
    cwd: root,
    sessionId: 'runtime_cli_pager',
    systemPrompt: false,
  })
  await ensureTranscriptFile(
    pagerTranscript,
    metaInputFromSession(pagerSeed),
  )
  for (let index = 1; index <= 7; index += 1) {
    const turnId = `turn_pager_${index}`
    await appendTurnEntry(pagerTranscript, {
      sessionId: pagerSeed.id,
      turnId,
      state: 'admitted',
      prompt: `pager prompt ${index}`,
    })
    await appendTurnEntry(pagerTranscript, {
      sessionId: pagerSeed.id,
      turnId,
      state: 'completed',
      terminalReason: 'completed',
    })
  }

  let nonTtyReads = 0
  const nonTtyOut: string[] = []
  const nonTtyText = await runRuntimeQueryCli({
    idOrPath: pagerTranscript,
    cwd: root,
    forceMock: true,
    query: { action: 'list', entity: 'turn' },
    isTty: false,
    columns: 32,
    rows: 8,
    env: { NO_COLOR: '1' },
    readKey: async () => {
      nonTtyReads += 1
      throw new Error('non-TTY runtime query must never read stdin')
    },
    writeOut: (text: string) => nonTtyOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(nonTtyText.exitCode, 0)
  assert.equal(nonTtyReads, 0)
  assert.match(nonTtyOut.join(''), /turn_pager_1/)
  assert.match(nonTtyOut.join(''), /turn_pager_7/)
  assert.equal(nonTtyOut.join('').includes('\u001b[2J'), false)

  const ttyKeys: RuntimePagerKey[] = [
    'next',
    'previous',
    'quit',
  ]
  let ttyKeyIndex = 0
  const ttyOut: string[] = []
  const ttyText = await runRuntimeQueryCli({
    idOrPath: pagerTranscript,
    cwd: root,
    forceMock: true,
    query: { action: 'list', entity: 'turn' },
    isTty: true,
    columns: 48,
    rows: 8,
    env: { NO_COLOR: '1' },
    readKey: async () => ttyKeys[ttyKeyIndex++] ?? 'eof',
    writeOut: (text: string) => ttyOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(ttyText.exitCode, 0)
  assert.equal(ttyKeyIndex, ttyKeys.length)
  assert.match(ttyOut.join(''), /page 1\/4/i)
  assert.match(ttyOut.join(''), /page 2\/4/i)
  assert.match(ttyOut.join(''), /\u001b\[2J/)
  assert.equal(
    /\u001b\[[0-9;]*m/.test(ttyOut.join('')),
    false,
    'NO_COLOR disables SGR while pager control sequences remain',
  )

  const retainedTerminal = new HeadlessTerminalHarness({
    columns: 48,
    rows: 8,
    scrollback: 200,
  })
  const retainedInput = new RuntimeRetainedInput()
  const retainedOutput = new RuntimeRetainedOutput(48, 8)
  const retainedOut: string[] = []
  let retainedLegacyReads = 0
  try {
    const retainedQuery = runRuntimeQueryCli({
      idOrPath: pagerTranscript,
      cwd: root,
      forceMock: true,
      query: { action: 'list', entity: 'turn' },
      isTty: true,
      columns: 48,
      rows: 8,
      env: { NO_COLOR: '1', BOLO_TUI_ENGINE: 'retained' },
      terminalInput: retainedInput,
      terminalOutput: retainedOutput,
      readKey: async () => {
        retainedLegacyReads += 1
        throw new Error('retained runtime pager must not use legacy readKey')
      },
      writeOut: (text: string) => {
        retainedOut.push(text)
        retainedTerminal.write(text)
      },
      writeErr: () => undefined,
    })
    await waitForRuntimePager(
      () => retainedInput.isRaw,
      'runtime CLI retained raw input',
    )
    await waitForRuntimePager(async () => {
      await retainedTerminal.flush()
      return retainedTerminal
        .viewport()
        .some((line) => /page 1\/4/iu.test(line.text))
    }, 'runtime CLI retained page one')
    retainedInput.send('\u001b[6~')
    await waitForRuntimePager(async () => {
      await retainedTerminal.flush()
      return retainedTerminal
        .viewport()
        .some((line) => /page 2\/4/iu.test(line.text))
    }, 'runtime CLI retained page two')
    retainedInput.send('q')
    assert.equal((await retainedQuery).exitCode, 0)
    assert.equal(retainedLegacyReads, 0)
    assert.equal(retainedInput.isRaw, false)
    assert.deepEqual(retainedInput.rawTransitions, [true, false])
    assert.equal(
      retainedOut.join('').includes('\u001b[2J'),
      false,
      'explicit retained runtime query avoids the legacy full-screen clear',
    )
  } finally {
    retainedTerminal.dispose()
  }

  let inspectReads = 0
  const inspectOut: string[] = []
  const inspectedText = await runRuntimeQueryCli({
    idOrPath: pagerTranscript,
    cwd: root,
    forceMock: true,
    query: {
      action: 'inspect',
      entity: 'turn',
      entityId: 'turn_pager_1',
    },
    isTty: true,
    columns: 48,
    rows: 8,
    env: { NO_COLOR: '1' },
    readKey: async () => {
      inspectReads += 1
      return 'quit'
    },
    writeOut: (text: string) => inspectOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(inspectedText.exitCode, 0)
  assert.equal(inspectReads, 1)
  assert.match(inspectOut.join(''), /turn_pager_1/)
  assert.match(inspectOut.join(''), /page 1\//i)

  const colorOut: string[] = []
  const colorText = await runRuntimeQueryCli({
    idOrPath: pagerTranscript,
    cwd: root,
    forceMock: true,
    query: { action: 'list', entity: 'turn' },
    isTty: true,
    columns: 48,
    rows: 8,
    env: {},
    readKey: async () => 'quit',
    writeOut: (text: string) => colorOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(colorText.exitCode, 0)
  assert.match(colorOut.join(''), /\u001b\[[0-9;]*m/)

  let ctrlCReads = 0
  const ctrlC = await runRuntimeQueryCli({
    idOrPath: pagerTranscript,
    cwd: root,
    forceMock: true,
    query: { action: 'list', entity: 'turn' },
    isTty: true,
    columns: 48,
    rows: 8,
    env: { NO_COLOR: '1' },
    readKey: async () => {
      ctrlCReads += 1
      return 'ctrl-c'
    },
    writeOut: () => undefined,
    writeErr: () => undefined,
  })
  assert.equal(ctrlCReads, 1)
  assert.equal(ctrlC.exitCode, 130)

  const pagerFailureErr: string[] = []
  const pagerFailure = await runRuntimeQueryCli({
    idOrPath: pagerTranscript,
    cwd: root,
    forceMock: true,
    query: { action: 'list', entity: 'turn' },
    isTty: true,
    columns: 48,
    rows: 8,
    env: { NO_COLOR: '1' },
    readKey: async () => {
      throw new Error('injected pager input failure')
    },
    writeOut: () => undefined,
    writeErr: (text: string) => pagerFailureErr.push(text),
  })
  assert.equal(pagerFailure.exitCode, 1)
  assert.match(pagerFailureErr.join(''), /pager_failed/)
  assert.match(
    pagerFailureErr.join(''),
    /injected pager input failure/,
  )

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
  const pipedText = spawnSync(
    process.execPath,
    [
      executable,
      'runtime',
      'list',
      'turn',
      '--resume',
      pagerTranscript,
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
        COLUMNS: '24',
        NO_COLOR: '1',
      },
    },
  )
  assert.equal(pipedText.status, 0, pipedText.stderr)
  assert.equal(pipedText.stderr, '')
  assert.match(pipedText.stdout, /turn_pager_1/)
  assert.match(pipedText.stdout, /turn_pager_7/)
  assert.equal(pipedText.stdout.includes('\u001b[2J'), false)
  assert.equal(/\u001b\[[0-9;]*m/.test(pipedText.stdout), false)

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
  assert.equal(noSession.stderr, '')
  assert.deepEqual(JSON.parse(noSession.stdout), {
    ok: false,
    code: 'usage',
    detail:
      'runtime query requires --resume <id|path> or --continue',
  })

  console.log('PASS: test-runtime-cli-query')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
