/**
 * AR1B2：append-only queue remove/edit、FIFO、幂等与部分成功。
 * 运行：npx tsx scripts/test-runtime-queue-edit.ts
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  RUNTIME_PROTOCOL_VERSION,
  parseRuntimeCommand,
  parseRuntimeCommandResult,
  type RuntimeCommand,
} from '../packages/shared/src/index.ts'
import {
  SessionCoordinator,
  buildRuntimeSnapshot,
  createSession,
  executeRuntimeCommand,
  loadTranscriptFile,
  queryRuntimeSnapshot,
  requestSessionControl,
  submitUserInput,
  takeNextSessionQueued,
} from '../packages/core/src/index.ts'

type RuntimeCommandInput<T> = T extends RuntimeCommand
  ? Omit<T, 'protocolVersion' | 'kind'>
  : never

function command(
  value: RuntimeCommandInput<RuntimeCommand>,
): RuntimeCommand {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.command',
    ...value,
  } as RuntimeCommand
}

const parsedReplace = parseRuntimeCommand({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'request_parse_replace',
  action: 'control.replace',
  target: {
    sessionId: 'session_parse',
    controlId: 'control_parse',
    expectedState: 'ready',
  },
  replacement: {
    prompt: 'replacement prompt',
    querySource: 'runtime_edit',
  },
  futureField: true,
})
assert.equal(parsedReplace.ok, true)
if (parsedReplace.ok) {
  assert.equal(parsedReplace.value.action, 'control.replace')
}
const rejectedEmptyPrompt = parseRuntimeCommand({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'request_parse_empty',
  action: 'control.replace',
  target: {
    sessionId: 'session_parse',
    controlId: 'control_parse',
    expectedState: 'ready',
  },
  replacement: { prompt: '   ' },
})
assert.equal(rejectedEmptyPrompt.ok, false)

const coordinator = new SessionCoordinator()
const session = await createSession({
  cwd: process.cwd(),
  sessionId: 'runtime_queue_edit',
  coordinator,
  systemPrompt: false,
})
for (const [controlId, turnId, prompt] of [
  ['control_edit_old', 'turn_edit_old', 'old prompt'],
  ['control_after', 'turn_after', 'after prompt'],
] as const) {
  const queued = await requestSessionControl(session, {
    controlId,
    kind: 'queue',
    sessionId: session.id,
    turnId,
    prompt,
    querySource: 'test',
  })
  assert.equal(queued.ok, true)
}

const beforeQuery = queryRuntimeSnapshot(buildRuntimeSnapshot(session), {
  action: 'inspect',
  entity: 'control',
  entityId: 'control_edit_old',
})
assert.equal(beforeQuery.ok, true)
if (!beforeQuery.ok || beforeQuery.view.kind !== 'runtime.inspect') {
  throw new Error('queue edit inspect fixture failed')
}
assert.deepEqual(
  beforeQuery.view.item.availableActions.map((action) => action.action),
  ['control.cancel', 'control.replace'],
)
const replaceDescriptor = beforeQuery.view.item.availableActions.find(
  (action) => action.action === 'control.replace',
)
assert.deepEqual(replaceDescriptor?.requiredInput, ['prompt'])

const replaceCommand = command({
  requestId: 'request_replace_ready',
  action: 'control.replace',
  target: {
    sessionId: session.id,
    controlId: 'control_edit_old',
    expectedState: 'ready',
  },
  replacement: {
    prompt: 'edited prompt',
    querySource: 'runtime_edit_test',
  },
})
const replaced = await executeRuntimeCommand(session, replaceCommand)
assert.equal(replaced.ok, true)
if (!replaced.ok || !replaced.replacement) {
  throw new Error('queue replacement was not returned')
}
assert.equal(replaced.replacement.replacedControlId, 'control_edit_old')
const replacementControlId = replaced.replacement.controlId
const replacementTurnId = replaced.replacement.turnId

const afterReplace = buildRuntimeSnapshot(session)
assert.equal(
  afterReplace.session.controls.find(
    (control) => control.controlId === 'control_edit_old',
  )?.state,
  'cancelled',
)
const replacementControl = afterReplace.session.controls.find(
  (control) => control.controlId === replacementControlId,
)
assert.equal(replacementControl?.state, 'ready')
assert.equal(replacementControl?.turnId, replacementTurnId)
assert.equal(replacementControl?.prompt, 'edited prompt')
assert.equal(
  afterReplace.session.controls.find(
    (control) => control.controlId === 'control_edit_old',
  )?.prompt,
  'old prompt',
  'append-only edit preserves original prompt/history',
)

const duplicate = await executeRuntimeCommand(session, replaceCommand)
assert.equal(duplicate.ok, true)
if (!duplicate.ok) throw new Error('duplicate replace unexpectedly failed')
assert.deepEqual(duplicate.replacement, replaced.replacement)
assert.equal(
  coordinator
    .snapshot(session.id)
    .controls.filter((control) => control.controlId === replacementControlId)
    .length,
  1,
)

const conflicting = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_replace_different',
    action: 'control.replace',
    target: {
      sessionId: session.id,
      controlId: 'control_edit_old',
      expectedState: 'ready',
    },
    replacement: { prompt: 'different edit' },
  }),
)
assert.equal(conflicting.ok, false)
if (!conflicting.ok) assert.equal(conflicting.code, 'state_conflict')

const firstDrained = await takeNextSessionQueued(session)
assert.equal(firstDrained.control?.controlId, 'control_after')
const secondDrained = await takeNextSessionQueued(session)
assert.equal(secondDrained.control?.controlId, replacementControlId)
assert.equal(secondDrained.control?.turnId, replacementTurnId)
assert.equal(
  await takeNextSessionQueued(session).then((result) => result.control),
  null,
)

const staleQueued = await requestSessionControl(session, {
  controlId: 'control_stale',
  kind: 'queue',
  sessionId: session.id,
  turnId: 'turn_stale',
  prompt: 'promote before edit',
})
assert.equal(staleQueued.ok, true)
assert.equal((await takeNextSessionQueued(session)).control?.controlId, 'control_stale')
const staleReplace = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_replace_stale',
    action: 'control.replace',
    target: {
      sessionId: session.id,
      controlId: 'control_stale',
      expectedState: 'ready',
    },
    replacement: { prompt: 'must not appear' },
  }),
)
assert.equal(staleReplace.ok, false)
if (!staleReplace.ok) assert.equal(staleReplace.code, 'state_conflict')

const owner = coordinator.tryAcquire({
  sessionId: session.id,
  turnId: 'turn_active_for_steer',
})
assert.equal(owner.ok, true)
if (!owner.ok) throw new Error('steer fixture owner missing')
const steer = await requestSessionControl(session, {
  controlId: 'control_steer',
  kind: 'steer',
  sessionId: session.id,
  expectedTurnId: owner.lease.turnId,
  prompt: 'steer, not queue',
})
assert.equal(steer.ok, true)
const rejectedSteer = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_replace_steer',
    action: 'control.replace',
    target: {
      sessionId: session.id,
      controlId: 'control_steer',
      expectedState: 'pending',
    },
    replacement: { prompt: 'must reject' },
  }),
)
assert.equal(rejectedSteer.ok, false)
if (!rejectedSteer.ok) assert.equal(rejectedSteer.code, 'not_cancellable')
assert.equal(
  coordinator
    .snapshot(session.id)
    .controls.find((control) => control.controlId === 'control_steer')?.state,
  'pending',
)

const pendingQueue = await requestSessionControl(session, {
  controlId: 'control_pending_edit',
  kind: 'queue',
  sessionId: session.id,
  expectedTurnId: owner.lease.turnId,
  turnId: 'turn_pending_edit',
  prompt: 'old pending prompt',
})
assert.equal(pendingQueue.ok, true)
const pendingReplaced = await executeRuntimeCommand(
  session,
  command({
    requestId: 'request_replace_pending',
    action: 'control.replace',
    target: {
      sessionId: session.id,
      controlId: 'control_pending_edit',
      expectedState: 'pending',
    },
    replacement: { prompt: 'edited pending prompt' },
  }),
)
assert.equal(pendingReplaced.ok, true)
if (!pendingReplaced.ok || !pendingReplaced.replacement) {
  throw new Error('pending queue replacement was not returned')
}
const pendingReplacement = coordinator
  .snapshot(session.id)
  .controls.find(
    (control) =>
      control.controlId === pendingReplaced.replacement?.controlId,
  )
assert.equal(pendingReplacement?.state, 'pending')
assert.equal(pendingReplacement?.expectedTurnId, owner.lease.turnId)
assert.equal(pendingReplacement?.prompt, 'edited pending prompt')
owner.lease.release()

const slashEditQueue = await requestSessionControl(session, {
  controlId: 'control_slash_edit',
  kind: 'queue',
  sessionId: session.id,
  turnId: 'turn_slash_edit',
  prompt: 'old slash prompt',
})
assert.equal(slashEditQueue.ok, true)
const slashEdited = await submitUserInput(
  session,
  '/runtime edit control_slash_edit new slash prompt',
)
assert.equal(slashEdited.type, 'slash')
if (slashEdited.type === 'slash') {
  assert.match(slashEdited.message, /accepted/)
  assert.match(slashEdited.message, /replacement:/)
}
assert.equal(
  coordinator
    .snapshot(session.id)
    .controls.find((control) => control.controlId === 'control_slash_edit')
    ?.state,
  'cancelled',
)
assert(
  coordinator
    .snapshot(session.id)
    .controls.some(
      (control) =>
        control.kind === 'queue' &&
        control.prompt === 'new slash prompt' &&
        control.state === 'ready',
    ),
)

const slashRemoveQueue = await requestSessionControl(session, {
  controlId: 'control_slash_remove',
  kind: 'queue',
  sessionId: session.id,
  turnId: 'turn_slash_remove',
  prompt: 'remove slash prompt',
})
assert.equal(slashRemoveQueue.ok, true)
const slashRemoved = await submitUserInput(
  session,
  '/runtime remove control_slash_remove',
)
assert.equal(slashRemoved.type, 'slash')
if (slashRemoved.type === 'slash') {
  assert.match(slashRemoved.message, /accepted/)
}
assert.equal(
  coordinator
    .snapshot(session.id)
    .controls.find((control) => control.controlId === 'control_slash_remove')
    ?.state,
  'cancelled',
)

const parsedResult = parseRuntimeCommandResult(
  JSON.parse(JSON.stringify(replaced)),
)
assert.equal(parsedResult.ok, true)
if (parsedResult.ok && parsedResult.value.ok) {
  assert.deepEqual(parsedResult.value.replacement, replaced.replacement)
}

const tempBase = path.resolve('.bolo-tmp')
await fs.mkdir(tempBase, { recursive: true })
const failureRoot = path.resolve(
  tempBase,
  `runtime-queue-edit-${process.pid}-${Date.now()}`,
)
const relativeFailureRoot = path.relative(tempBase, failureRoot)
assert(
  relativeFailureRoot !== '' &&
    relativeFailureRoot !== '..' &&
    !relativeFailureRoot.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeFailureRoot),
)
await fs.mkdir(failureRoot, { recursive: true })

try {
  const failureCoordinator = new SessionCoordinator()
  const transcript = path.join(failureRoot, 'queue-edit.jsonl')
  const failureSession = await createSession({
    cwd: failureRoot,
    sessionId: 'runtime_queue_edit_failure',
    coordinator: failureCoordinator,
    systemPrompt: false,
    autoSave: {
      scope: 'project',
      filePath: transcript,
    },
  })
  const oldQueue = await requestSessionControl(failureSession, {
    controlId: 'control_partial_old',
    kind: 'queue',
    sessionId: failureSession.id,
    turnId: 'turn_partial_old',
    prompt: 'old prompt survives in history',
  })
  assert.equal(oldQueue.ok, true)

  const originalAppendFile = fs.appendFile.bind(fs)
  const writableFs = fs as typeof fs & {
    appendFile: typeof fs.appendFile
  }
  let replacementFailureInjected = false
  writableFs.appendFile = (async (
    file: Parameters<typeof fs.appendFile>[0],
    data: Parameters<typeof fs.appendFile>[1],
    options?: Parameters<typeof fs.appendFile>[2],
  ) => {
    const text = String(data)
    if (
      !replacementFailureInjected &&
      text.includes('"type":"control"') &&
      text.includes('"state":"ready"')
    ) {
      replacementFailureInjected = true
      throw Object.assign(new Error('injected replacement admission failure'), {
        code: 'EIO',
      })
    }
    return await originalAppendFile(file, data, options)
  }) as typeof fs.appendFile

  let partial
  try {
    partial = await executeRuntimeCommand(
      failureSession,
      command({
        requestId: 'request_replace_partial',
        action: 'control.replace',
        target: {
          sessionId: failureSession.id,
          controlId: 'control_partial_old',
          expectedState: 'ready',
        },
        replacement: { prompt: 'replacement must not execute' },
      }),
    )
  } finally {
    writableFs.appendFile = originalAppendFile
  }
  assert(replacementFailureInjected)
  assert.equal(partial.ok, true)
  if (!partial.ok) throw new Error('partial replace must stay accepted')
  assert.equal(partial.replacement, undefined)
  assert.match(partial.warnings?.join('\n') ?? '', /was cancelled.*not admitted/i)
  assert.equal(
    failureCoordinator
      .snapshot(failureSession.id)
      .controls.find(
        (control) => control.controlId === 'control_partial_old',
      )?.state,
    'cancelled',
  )
  assert.equal(
    failureCoordinator
      .snapshot(failureSession.id)
      .controls.some(
        (control) =>
          control.prompt === 'replacement must not execute' &&
          (control.state === 'pending' || control.state === 'ready'),
      ),
    false,
  )

  const loaded = await loadTranscriptFile(transcript)
  const oldStates = loaded.entries.flatMap((entry) =>
    entry.type === 'control' &&
    entry.controlId === 'control_partial_old'
      ? [entry.state]
      : [],
  )
  assert.deepEqual(oldStates, ['ready', 'cancelled'])
  assert.equal(
    loaded.entries.some(
      (entry) =>
        entry.type === 'control' &&
        entry.prompt === 'replacement must not execute',
    ),
    false,
  )
} finally {
  await fs.rm(failureRoot, { recursive: true, force: true })
}

console.log('PASS: test-runtime-queue-edit')
