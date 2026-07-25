/**
 * DR4C：真实 CLI consumer、crash/restart 与旧 protocol/transcript closeout。
 * 运行：npx tsx scripts/test-runtime-closeout.ts
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  parseRuntimeSnapshot,
} from '../packages/shared/src/index.ts'
import {
  SessionCoordinator,
  appendControlEntry,
  appendTurnEntry,
  buildRuntimeSnapshot,
  createSession,
  ensureTranscriptFile,
  metaInputFromSession,
  resumeSession,
  submitUserInput,
} from '../packages/core/src/index.ts'
import {
  runOnePrompt,
  takeNextQueuedReplPrompt,
} from '../packages/cli/src/resumeCli.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

type CountingProvider = {
  provider: LlmProvider
  calls: () => number
}

function countingProvider(id: string): CountingProvider {
  let calls = 0
  return {
    provider: {
      id,
      async *completeStream() {
        calls += 1
        yield { type: 'text_delta', text: 'runtime closeout answer' }
        yield { type: 'done' }
      },
    },
    calls: () => calls,
  }
}

async function createTranscript(
  root: string,
  sessionId: string,
): Promise<string> {
  const file = path.join(root, `${sessionId}.jsonl`)
  const session = await createSession({
    cwd: root,
    sessionId,
    systemPrompt: false,
  })
  await ensureTranscriptFile(file, metaInputFromSession(session))
  return file
}

async function resumeFixture(
  file: string,
  root: string,
  provider: LlmProvider,
) {
  return await resumeSession({
    idOrPath: file,
    cwd: root,
    provider,
    reassembleSystem: false,
    systemPrompt: false,
    autoSave: true,
    create: { coordinator: new SessionCoordinator() },
  })
}

function slashMessage(
  result: Awaited<ReturnType<typeof submitUserInput>>,
): string {
  assert.equal(result.type, 'slash')
  if (result.type !== 'slash') {
    throw new Error('expected slash result')
  }
  return result.message
}

const tempBase = path.resolve('.bolo-tmp')
await fs.mkdir(tempBase, { recursive: true })
const root = path.resolve(
  tempBase,
  `runtime-closeout-${process.pid}-${Date.now()}`,
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
  // New 与 resume CLI 都只渲染 core protocol snapshot。
  const freshProvider = countingProvider('runtime-closeout-new')
  const fresh = await createSession({
    cwd: root,
    sessionId: 'runtime_closeout_new',
    coordinator: new SessionCoordinator(),
    provider: freshProvider.provider,
    systemPrompt: false,
  })
  const freshJson = await runOnePrompt(fresh, '/runtime json', {
    isTty: false,
    writeOut: () => undefined,
    writeErr: () => undefined,
  })
  assert.equal(freshJson.terminalReason, 'slash')
  const parsedFresh = parseRuntimeSnapshot(
    JSON.parse(freshJson.assistantText),
  )
  assert.equal(parsedFresh.ok, true)
  assert.equal(freshProvider.calls(), 0)

  // DR4A 的旧 v1 snapshot 缺少 DR4B features/optional fields 时仍可读。
  const legacySnapshot = structuredClone(buildRuntimeSnapshot(fresh))
  legacySnapshot.features = [
    'views.session',
    'views.turns',
    'views.controls',
    'views.tasks',
    'commands.inspect',
    'commands.interrupt',
    'commands.cancel',
  ]
  const parsedLegacy = parseRuntimeSnapshot(legacySnapshot)
  assert.equal(parsedLegacy.ok, true)
  const invalidLegacy = structuredClone(
    legacySnapshot,
  ) as unknown as Record<string, unknown>
  ;(invalidLegacy.session as Record<string, unknown>).phase =
    'teleported'
  const rejectedLegacy = parseRuntimeSnapshot(invalidLegacy)
  assert.equal(rejectedLegacy.ok, false)

  // 真实 crash → resume：保留 admitted/running/ready provenance，不建 live queue。
  const executedFile = await createTranscript(
    root,
    'runtime_closeout_execute',
  )
  await appendTurnEntry(executedFile, {
    sessionId: 'runtime_closeout_execute',
    turnId: 'turn_crashed_admitted',
    state: 'admitted',
    prompt: 'retry this admitted prompt through the CLI',
    querySource: 'runtime_closeout_fixture',
  })
  await appendTurnEntry(executedFile, {
    sessionId: 'runtime_closeout_execute',
    turnId: 'turn_crashed_running',
    state: 'admitted',
    prompt: 'never replay running work',
  })
  await appendTurnEntry(executedFile, {
    sessionId: 'runtime_closeout_execute',
    turnId: 'turn_crashed_running',
    state: 'running',
  })
  await appendTurnEntry(executedFile, {
    sessionId: 'runtime_closeout_execute',
    turnId: 'turn_old_queue',
    state: 'admitted',
    prompt: 'old queued prompt',
  })
  await appendControlEntry(executedFile, {
    controlId: 'control_crashed_ready',
    sessionId: 'runtime_closeout_execute',
    kind: 'queue',
    state: 'ready',
    turnId: 'turn_old_queue',
    prompt: 'old queued prompt',
    querySource: 'runtime_closeout_fixture',
    timestamp: '2026-07-26T09:00:03.000Z',
  })

  const executedProvider = countingProvider('runtime-closeout-execute')
  const firstResume = await resumeFixture(
    executedFile,
    root,
    executedProvider.provider,
  )
  const firstSnapshot = buildRuntimeSnapshot(firstResume.session)
  assert.equal(
    firstSnapshot.session.turns.find(
      (turn) => turn.turnId === 'turn_crashed_admitted',
    )?.interruptedFrom,
    'admitted',
  )
  assert.equal(
    firstSnapshot.session.turns.find(
      (turn) => turn.turnId === 'turn_crashed_running',
    )?.interruptedFrom,
    'running',
  )
  assert.equal(
    firstSnapshot.session.controls.find(
      (control) => control.controlId === 'control_crashed_ready',
    )?.interruptedFrom,
    'ready',
  )
  assert.equal(
    firstResume.session.coordinator.snapshot(firstResume.session.id)
      .controls.length,
    0,
    'resume never rebuilds executable controls',
  )

  const retryFromCli = await runOnePrompt(
    firstResume.session,
    '/runtime retry-safe turn turn_crashed_admitted',
    {
      isTty: false,
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
  )
  assert.equal(retryFromCli.terminalReason, 'slash')
  assert.match(retryFromCli.assistantText, /accepted/)
  assert.equal(
    executedProvider.calls(),
    0,
    'retry-safe command does not call the provider',
  )
  const retriedSnapshot = buildRuntimeSnapshot(firstResume.session)
  const original = retriedSnapshot.session.turns.find(
    (turn) => turn.turnId === 'turn_crashed_admitted',
  )
  assert.equal(original?.resolution?.action, 'retry_safe')
  const replacementTurnId = original?.resolution?.replacementId
  assert(replacementTurnId, 'retry-safe exposes replacement turn id')

  const queued = await takeNextQueuedReplPrompt(firstResume.session)
  assert.equal(queued?.turnId, replacementTurnId)
  if (!queued) throw new Error('retry-safe queue was not available to CLI')
  const executed = await runOnePrompt(
    firstResume.session,
    queued.prompt,
    {
      isTty: false,
      writeOut: () => undefined,
      writeErr: () => undefined,
      turnId: queued.turnId,
      querySource: queued.querySource,
    },
  )
  assert.equal(executed.terminalReason, 'completed')
  assert.equal(executedProvider.calls(), 1)
  assert.equal(
    await takeNextQueuedReplPrompt(firstResume.session),
    null,
    'replacement queue is consumed once',
  )

  const afterExecution = await resumeFixture(
    executedFile,
    root,
    executedProvider.provider,
  )
  assert.equal(
    afterExecution.session.coordinator.snapshot(afterExecution.session.id)
      .controls.length,
    0,
  )
  const afterSnapshot = buildRuntimeSnapshot(afterExecution.session)
  assert.equal(
    afterSnapshot.session.turns.find(
      (turn) => turn.turnId === replacementTurnId,
    )?.state,
    'completed',
  )
  assert.equal(
    afterSnapshot.session.turns.find(
      (turn) => turn.turnId === 'turn_crashed_admitted',
    )?.resolution?.replacementId,
    replacementTurnId,
  )
  const resumedJson = await runOnePrompt(
    afterExecution.session,
    '/runtime json',
    {
      isTty: false,
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
  )
  assert.equal(resumedJson.terminalReason, 'slash')
  assert.equal(
    parseRuntimeSnapshot(JSON.parse(resumedJson.assistantText)).ok,
    true,
  )
  assert.equal(await takeNextQueuedReplPrompt(afterExecution.session), null)
  assert.equal(
    executedProvider.calls(),
    1,
    'restart never replays the completed replacement',
  )

  // retry-safe 后尚未消费即再次 crash：audit 可见，但 live queue 仍为空。
  const pendingFile = await createTranscript(
    root,
    'runtime_closeout_pending',
  )
  await appendTurnEntry(pendingFile, {
    sessionId: 'runtime_closeout_pending',
    turnId: 'turn_pending_retry',
    state: 'admitted',
    prompt: 'leave this replacement unconsumed',
  })
  const pendingProvider = countingProvider('runtime-closeout-pending')
  const pendingResume = await resumeFixture(
    pendingFile,
    root,
    pendingProvider.provider,
  )
  const pendingRetry = await runOnePrompt(
    pendingResume.session,
    '/runtime retry-safe turn turn_pending_retry',
    {
      isTty: false,
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
  )
  assert.equal(pendingRetry.terminalReason, 'slash')
  assert.match(pendingRetry.assistantText, /accepted/)
  const pendingSnapshot = buildRuntimeSnapshot(pendingResume.session)
  const pendingReplacement = pendingSnapshot.session.turns.find(
    (turn) => turn.turnId === 'turn_pending_retry',
  )?.resolution?.replacementId
  assert(pendingReplacement)

  const pendingRestart = await resumeFixture(
    pendingFile,
    root,
    pendingProvider.provider,
  )
  assert.equal(
    pendingRestart.session.coordinator.snapshot(pendingRestart.session.id)
      .controls.length,
    0,
  )
  const pendingRestartSnapshot = buildRuntimeSnapshot(
    pendingRestart.session,
  )
  assert.equal(
    pendingRestartSnapshot.session.turns.find(
      (turn) => turn.turnId === pendingReplacement,
    )?.interruptedFrom,
    'admitted',
  )
  assert.equal(
    pendingRestartSnapshot.session.turns.find(
      (turn) => turn.turnId === 'turn_pending_retry',
    )?.resolution?.replacementId,
    pendingReplacement,
  )
  assert.equal(
    pendingRestartSnapshot.session.controls.find(
      (control) => control.turnId === pendingReplacement,
    )?.interruptedFrom,
    'ready',
  )
  const inspectedPendingOriginal = await runOnePrompt(
    pendingRestart.session,
    '/runtime inspect turn turn_pending_retry',
    {
      isTty: false,
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
  )
  assert.equal(inspectedPendingOriginal.terminalReason, 'slash')
  assert.equal(
    (
      JSON.parse(inspectedPendingOriginal.assistantText) as {
        resolution?: { replacementId?: string }
      }
    ).resolution?.replacementId,
    pendingReplacement,
  )
  const inspectedPendingReplacement = await runOnePrompt(
    pendingRestart.session,
    `/runtime inspect turn ${pendingReplacement}`,
    {
      isTty: false,
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
  )
  assert.equal(inspectedPendingReplacement.terminalReason, 'slash')
  assert.equal(
    (
      JSON.parse(inspectedPendingReplacement.assistantText) as {
        interruptedFrom?: string
      }
    ).interruptedFrom,
    'admitted',
  )
  assert.equal(await takeNextQueuedReplPrompt(pendingRestart.session), null)
  assert.equal(pendingProvider.calls(), 0)

  // 外部坏 resolution 只被忽略，不能毒化整个 runtime snapshot。
  const malformedFile = await createTranscript(
    root,
    'runtime_closeout_malformed',
  )
  await appendTurnEntry(malformedFile, {
    sessionId: 'runtime_closeout_malformed',
    turnId: 'turn_malformed_target',
    state: 'admitted',
    prompt: 'valid interrupted target',
  })
  await appendTurnEntry(malformedFile, {
    sessionId: 'runtime_closeout_malformed',
    turnId: 'turn_valid_resolution',
    state: 'admitted',
    prompt: 'valid discard target',
  })
  await appendTurnEntry(malformedFile, {
    sessionId: 'runtime_closeout_malformed',
    turnId: 'turn_completed_target',
    state: 'admitted',
    prompt: 'completed work',
  })
  await appendTurnEntry(malformedFile, {
    sessionId: 'runtime_closeout_malformed',
    turnId: 'turn_completed_target',
    state: 'completed',
    terminalReason: 'completed',
  })
  const malformedLines = [
    {
      type: 'resolution',
      sessionId: 'runtime_closeout_malformed',
      resolutionId: 'resolution_unknown_action',
      entityKind: 'turn',
      entityId: 'turn_malformed_target',
      action: 'force_replay',
      timestamp: '2026-07-26T09:10:00.000Z',
    },
    {
      type: 'resolution',
      sessionId: 'runtime_closeout_malformed',
      resolutionId: 'resolution_orphan',
      entityKind: 'turn',
      entityId: 'turn_missing',
      action: 'discard',
      timestamp: '2026-07-26T09:10:01.000Z',
    },
    {
      type: 'resolution',
      sessionId: 'another_session',
      resolutionId: 'resolution_cross_session',
      entityKind: 'turn',
      entityId: 'turn_malformed_target',
      action: 'discard',
      timestamp: '2026-07-26T09:10:02.000Z',
    },
    {
      type: 'resolution',
      sessionId: 'runtime_closeout_malformed',
      resolutionId: 'resolution_wrong_kind',
      entityKind: 'task',
      entityId: 'turn_malformed_target',
      action: 'discard',
      timestamp: '2026-07-26T09:10:03.000Z',
    },
    {
      type: 'resolution',
      sessionId: 'runtime_closeout_malformed',
      resolutionId: 'resolution_completed',
      entityKind: 'turn',
      entityId: 'turn_completed_target',
      action: 'discard',
      timestamp: '2026-07-26T09:10:04.000Z',
    },
    {
      type: 'resolution',
      sessionId: 'runtime_closeout_malformed',
      resolutionId: 'resolution_missing_replacement',
      entityKind: 'turn',
      entityId: 'turn_malformed_target',
      action: 'retry_safe',
      timestamp: '2026-07-26T09:10:05.000Z',
    },
    {
      type: 'resolution',
      sessionId: 'runtime_closeout_malformed',
      resolutionId: 'resolution_valid',
      entityKind: 'turn',
      entityId: 'turn_valid_resolution',
      action: 'discard',
      timestamp: '2026-07-26T09:10:06.000Z',
    },
  ]
  await fs.appendFile(
    malformedFile,
    `${malformedLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  )
  const malformedResume = await resumeFixture(
    malformedFile,
    root,
    countingProvider('runtime-closeout-malformed').provider,
  )
  assert.deepEqual(
    malformedResume.session.durableResolutions.map(
      (resolution) => resolution.resolutionId,
    ),
    ['resolution_valid'],
    'orphan/cross-session/kind/state/unknown resolution rows fail closed',
  )
  const malformedJson = slashMessage(
    await submitUserInput(malformedResume.session, '/runtime json'),
  )
  const parsedMalformed = parseRuntimeSnapshot(
    JSON.parse(malformedJson),
  )
  assert.equal(parsedMalformed.ok, true)
  if (parsedMalformed.ok) {
    assert.equal(
      parsedMalformed.value.session.turns.find(
        (turn) => turn.turnId === 'turn_valid_resolution',
      )?.resolution?.action,
      'discard',
    )
  }

  console.log('PASS: test-runtime-closeout')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
