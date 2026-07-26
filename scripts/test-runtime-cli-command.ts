/**
 * AR1B3：顶层 recovery command、稳定 result envelope 与 exit 0/1/2。
 * 运行：npx tsx scripts/test-runtime-cli-command.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  parseRuntimeCommandResult,
  type RuntimeCommandResult,
} from '../packages/shared/src/index.ts'
import {
  SessionCoordinator,
  appendTurnEntry,
  createSession,
  endSession,
  ensureTranscriptFile,
  loadTranscriptFile,
  metaInputFromSession,
  resumeSession,
} from '../packages/core/src/index.ts'
import {
  formatHelp,
  parseArgs,
} from '../packages/cli/src/parseArgs.ts'
import {
  deriveRuntimeCommandRequestId,
  runRuntimeCommandCli,
} from '../packages/cli/src/runtimeCli.ts'

const parsedDiscard = parseArgs([
  'runtime',
  'discard',
  'turn',
  'turn_a',
  '--resume',
  'session_a',
  '--json',
])
assert.deepEqual(parsedDiscard.runtimeAction, {
  action: 'runtime.discard',
  entity: 'turn',
  entityId: 'turn_a',
})
assert.equal(parsedDiscard.resume, 'session_a')
assert.equal(parsedDiscard.json, true)

const parsedRetry = parseArgs([
  '--request-id',
  'request_explicit',
  '--continue',
  'runtime',
  'retry-safe',
  'control',
  'control_a',
])
assert.deepEqual(parsedRetry.runtimeAction, {
  action: 'runtime.retry-safe',
  entity: 'control',
  entityId: 'control_a',
})
assert.equal(parsedRetry.runtimeRequestId, 'request_explicit')
assert.equal(parsedRetry.continue, true)
assert.throws(
  () => parseArgs(['runtime', 'discard', 'turn']),
  /runtime discard requires/,
)
assert.throws(
  () => parseArgs(['runtime', 'retry-safe', 'unknown', 'id']),
  /runtime entity/,
)
assert.throws(
  () => parseArgs(['runtime', 'interrupt', 'turn_a']),
  /runtime requires/,
)
assert.throws(
  () => parseArgs(['--request-id', 'request_orphan']),
  /--request-id requires runtime discard or runtime retry-safe/,
)
assert.throws(
  () =>
    parseArgs([
      '--request-id',
      '   ',
      'runtime',
      'discard',
      'turn',
      'turn_a',
    ]),
  /--request-id is empty/,
)
assert.throws(
  () =>
    parseArgs([
      '--request-id',
      'bad\nid',
      'runtime',
      'discard',
      'turn',
      'turn_a',
    ]),
  /invalid control characters/,
)
assert.match(formatHelp(), /bolo runtime discard/)
assert.match(formatHelp(), /bolo runtime retry-safe/)
assert.match(formatHelp(), /--request-id/)

const derivedA = deriveRuntimeCommandRequestId({
  sessionId: 'runtime_cli_command',
  action: 'runtime.discard',
  entity: 'turn',
  entityId: 'turn_a',
})
const derivedAgain = deriveRuntimeCommandRequestId({
  sessionId: 'runtime_cli_command',
  action: 'runtime.discard',
  entity: 'turn',
  entityId: 'turn_a',
})
const derivedDifferent = deriveRuntimeCommandRequestId({
  sessionId: 'runtime_cli_command',
  action: 'runtime.retry-safe',
  entity: 'turn',
  entityId: 'turn_a',
})
assert.equal(derivedA, derivedAgain)
assert.notEqual(derivedA, derivedDifferent)

const tempBase = path.resolve('.bolo-tmp')
await fs.mkdir(tempBase, { recursive: true })
const root = path.resolve(
  tempBase,
  `runtime-cli-command-${process.pid}-${Date.now()}`,
)
const relativeRoot = path.relative(tempBase, root)
assert(
  relativeRoot !== '' &&
    relativeRoot !== '..' &&
    !relativeRoot.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeRoot),
)
await fs.mkdir(root, { recursive: true })

async function seedTranscript(
  file: string,
  sessionId: string,
  turns: Array<{
    turnId: string
    prompt: string
    running?: boolean
  }>,
): Promise<void> {
  const session = await createSession({
    cwd: root,
    sessionId,
    systemPrompt: false,
  })
  await ensureTranscriptFile(file, metaInputFromSession(session))
  for (const turn of turns) {
    await appendTurnEntry(file, {
      sessionId,
      turnId: turn.turnId,
      state: 'admitted',
      prompt: turn.prompt,
    })
    if (turn.running) {
      await appendTurnEntry(file, {
        sessionId,
        turnId: turn.turnId,
        state: 'running',
      })
    }
  }
}

function parseCommandOutput(text: string): RuntimeCommandResult {
  const parsed = parseRuntimeCommandResult(JSON.parse(text))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('runtime command result parse failed')
  return parsed.value
}

try {
  const transcript = path.join(root, 'runtime_cli_command.jsonl')
  await seedTranscript(transcript, 'runtime_cli_command', [
    {
      turnId: 'turn_discard',
      prompt: 'discard this interrupted diagnostic',
    },
    {
      turnId: 'turn_running',
      prompt: 'never retry work that started',
      running: true,
    },
    {
      turnId: 'turn_retry_warning',
      prompt: 'admit replacement but fail resolution once',
    },
    {
      turnId: 'turn_persist_failure',
      prompt: 'discard persistence must fail',
    },
    {
      turnId: 'turn_bin_discard',
      prompt: 'discard through the real bin',
    },
  ])

  const discardOut: string[] = []
  const discardErr: string[] = []
  const discarded = await runRuntimeCommandCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    action: {
      action: 'runtime.discard',
      entity: 'turn',
      entityId: 'turn_discard',
    },
    json: true,
    writeOut: (text: string) => discardOut.push(text),
    writeErr: (text: string) => discardErr.push(text),
  })
  assert.equal(discarded.exitCode, 0)
  assert.equal(discardErr.join(''), '')
  assert.equal(discardOut.length, 1)
  const discardedResult = parseCommandOutput(discardOut.join(''))
  assert.equal(discardedResult.ok, true)
  const discardRequestId = discardedResult.requestId

  const duplicateOut: string[] = []
  const duplicate = await runRuntimeCommandCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    action: {
      action: 'runtime.discard',
      entity: 'turn',
      entityId: 'turn_discard',
    },
    writeOut: (text: string) => duplicateOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(duplicate.exitCode, 0)
  assert.match(duplicateOut.join(''), /runtime command accepted/)
  assert.match(duplicateOut.join(''), new RegExp(discardRequestId))

  const loadedAfterDuplicate = await loadTranscriptFile(transcript)
  assert.equal(
    loadedAfterDuplicate.entries.filter(
      (entry) =>
        entry.type === 'resolution' &&
        entry.entityId === 'turn_discard',
    ).length,
    1,
    'stable requestId keeps duplicate discard append-idempotent',
  )

  const changedOut: string[] = []
  const changedErr: string[] = []
  const changed = await runRuntimeCommandCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    action: {
      action: 'runtime.retry-safe',
      entity: 'turn',
      entityId: 'turn_discard',
    },
    writeOut: (text: string) => changedOut.push(text),
    writeErr: (text: string) => changedErr.push(text),
  })
  assert.equal(changed.exitCode, 1)
  assert.equal(changedOut.join(''), '')
  assert.match(changedErr.join(''), /state_conflict/)

  const unsafeOut: string[] = []
  const unsafe = await runRuntimeCommandCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    action: {
      action: 'runtime.retry-safe',
      entity: 'turn',
      entityId: 'turn_running',
    },
    json: true,
    writeOut: (text: string) => unsafeOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(unsafe.exitCode, 1)
  const unsafeResult = parseCommandOutput(unsafeOut.join(''))
  assert.equal(unsafeResult.ok, false)
  if (!unsafeResult.ok) assert.equal(unsafeResult.code, 'not_retry_safe')

  const originalAppendFile = fs.appendFile.bind(fs)
  const writableFs = fs as typeof fs & {
    appendFile: typeof fs.appendFile
  }

  let discardFailureInjected = false
  writableFs.appendFile = (async (
    file: Parameters<typeof fs.appendFile>[0],
    data: Parameters<typeof fs.appendFile>[1],
    options?: Parameters<typeof fs.appendFile>[2],
  ) => {
    if (
      !discardFailureInjected &&
      String(file) === transcript &&
      String(data).includes('"type":"resolution"') &&
      String(data).includes('"turn_persist_failure"')
    ) {
      discardFailureInjected = true
      throw Object.assign(new Error('injected discard persistence failure'), {
        code: 'EIO',
      })
    }
    return await originalAppendFile(file, data, options)
  }) as typeof fs.appendFile
  const persistOut: string[] = []
  try {
    const persistFailure = await runRuntimeCommandCli({
      idOrPath: transcript,
      cwd: root,
      forceMock: true,
      action: {
        action: 'runtime.discard',
        entity: 'turn',
        entityId: 'turn_persist_failure',
      },
      json: true,
      writeOut: (text: string) => persistOut.push(text),
      writeErr: () => undefined,
    })
    assert.equal(persistFailure.exitCode, 1)
  } finally {
    writableFs.appendFile = originalAppendFile
  }
  assert(discardFailureInjected)
  const persistResult = parseCommandOutput(persistOut.join(''))
  assert.equal(persistResult.ok, false)
  if (!persistResult.ok) {
    assert.equal(persistResult.code, 'persistence_failed')
  }

  let resolutionFailureInjected = false
  writableFs.appendFile = (async (
    file: Parameters<typeof fs.appendFile>[0],
    data: Parameters<typeof fs.appendFile>[1],
    options?: Parameters<typeof fs.appendFile>[2],
  ) => {
    if (
      !resolutionFailureInjected &&
      String(file) === transcript &&
      String(data).includes('"type":"resolution"') &&
      String(data).includes('"turn_retry_warning"')
    ) {
      resolutionFailureInjected = true
      throw Object.assign(new Error('injected retry resolution failure'), {
        code: 'EIO',
      })
    }
    return await originalAppendFile(file, data, options)
  }) as typeof fs.appendFile
  const warningOut: string[] = []
  let warnedRequestId = ''
  try {
    const warned = await runRuntimeCommandCli({
      idOrPath: transcript,
      cwd: root,
      forceMock: true,
      action: {
        action: 'runtime.retry-safe',
        entity: 'turn',
        entityId: 'turn_retry_warning',
      },
      json: true,
      writeOut: (text: string) => warningOut.push(text),
      writeErr: () => undefined,
    })
    assert.equal(warned.exitCode, 0)
    const result = parseCommandOutput(warningOut.join(''))
    assert.equal(result.ok, true)
    warnedRequestId = result.requestId
    if (result.ok) {
      assert.match(result.warnings?.join('\n') ?? '', /resolution persistence failed/)
      assert.match(result.warnings?.join('\n') ?? '', /does not execute/i)
    }
  } finally {
    writableFs.appendFile = originalAppendFile
  }
  assert(resolutionFailureInjected)

  const afterWarning = await resumeSession({
    idOrPath: transcript,
    cwd: root,
    reassembleSystem: false,
    systemPrompt: false,
    create: { coordinator: new SessionCoordinator() },
  })
  assert.equal(
    afterWarning.session.coordinator.snapshot(afterWarning.session.id)
      .controls.length,
    0,
    'top-level command process never leaves an executable queue after restart',
  )
  assert(
    afterWarning.session.durableTurns.some(
      (turn) =>
        turn.turnId !== 'turn_retry_warning' &&
        turn.interruptedFrom === 'admitted',
    ),
  )
  await endSession(afterWarning.session, { reason: 'other' })

  const differentOut: string[] = []
  const differentAfterWarning = await runRuntimeCommandCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    requestId: 'request_retry_warning_different',
    action: {
      action: 'runtime.retry-safe',
      entity: 'turn',
      entityId: 'turn_retry_warning',
    },
    json: true,
    writeOut: (text: string) => differentOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(differentAfterWarning.exitCode, 1)
  const differentResult = parseCommandOutput(differentOut.join(''))
  assert.equal(differentResult.ok, false)
  if (!differentResult.ok) {
    assert.equal(differentResult.code, 'state_conflict')
  }

  const repairedOut: string[] = []
  const repaired = await runRuntimeCommandCli({
    idOrPath: transcript,
    cwd: root,
    forceMock: true,
    action: {
      action: 'runtime.retry-safe',
      entity: 'turn',
      entityId: 'turn_retry_warning',
    },
    json: true,
    writeOut: (text: string) => repairedOut.push(text),
    writeErr: () => undefined,
  })
  assert.equal(repaired.exitCode, 0)
  const repairedResult = parseCommandOutput(repairedOut.join(''))
  assert.equal(repairedResult.requestId, warnedRequestId)
  const loadedAfterRepair = await loadTranscriptFile(transcript)
  assert.equal(
    loadedAfterRepair.entries.filter(
      (entry) =>
        entry.type === 'resolution' &&
        entry.entityId === 'turn_retry_warning',
    ).length,
    1,
  )

  const configDir = path.join(root, 'config')
  await fs.mkdir(configDir, { recursive: true })
  const executable = path.resolve('packages/cli/bin/bolo.js')
  const spawned = spawnSync(
    process.execPath,
    [
      executable,
      'runtime',
      'discard',
      'turn',
      'turn_bin_discard',
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
  assert.equal(spawned.stderr, '')
  assert.equal(spawned.stdout.includes('BOLO'), false)
  assert.equal(parseCommandOutput(spawned.stdout).ok, true)

  const missing = spawnSync(
    process.execPath,
    [
      executable,
      'runtime',
      'discard',
      'turn',
      'turn_missing',
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
      },
    },
  )
  assert.equal(missing.status, 1)
  const missingResult = parseCommandOutput(missing.stdout)
  assert.equal(missingResult.ok, false)
  if (!missingResult.ok) assert.equal(missingResult.code, 'not_found')

  const loadFailure = spawnSync(
    process.execPath,
    [
      executable,
      'runtime',
      'discard',
      'turn',
      'turn_missing',
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
    [
      executable,
      'runtime',
      'discard',
      'turn',
      'turn_bin_discard',
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
  assert.equal(noSession.status, 2)
  assert.equal(noSession.stderr, '')
  assert.deepEqual(JSON.parse(noSession.stdout), {
    ok: false,
    code: 'usage',
    detail:
      'runtime command requires --resume <id|path> or --continue',
  })

  console.log('PASS: test-runtime-cli-command')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
