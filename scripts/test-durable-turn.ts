/**
 * DR0–DR1：turn admission、生命周期、幂等与恢复。
 * 运行：npx tsx scripts/test-durable-turn.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendTurnEntry,
  createSession,
  ensureTranscriptFile,
  loadTranscriptFile,
  projectDurableTurns,
  resumeSession,
  rewriteTranscriptFromMessages,
  submitPrompt,
} from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function statesFor(
  entries: Awaited<ReturnType<typeof loadTranscriptFile>>['entries'],
  turnId: string,
): string[] {
  const states: string[] = []
  for (const entry of entries) {
    if (entry.type === 'turn' && entry.turnId === turnId) {
      states.push(entry.state)
    }
  }
  return states
}

function lastEntryIndex(
  entries: Awaited<ReturnType<typeof loadTranscriptFile>>['entries'],
  predicate: (
    entry: Awaited<ReturnType<typeof loadTranscriptFile>>['entries'][number],
  ) => boolean,
): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (predicate(entries[index]!)) return index
  }
  return -1
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-durable-turn-'))
  const cwd = path.join(tmpRoot, 'project')
  const sessionsDir = path.join(tmpRoot, 'sessions')
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  const completedPath = path.join(sessionsDir, 'durable_completed.jsonl')
  let completedCalls = 0
  const completedProvider: LlmProvider = {
    id: 'mock',
    async *completeStream() {
      completedCalls += 1
      const { entries } = await loadTranscriptFile(completedPath)
      assert(
        statesFor(entries, 'turn_completed').join(',') ===
          'admitted,running',
        'provider starts only after admitted + running are durable',
      )
      yield { type: 'text_delta', text: 'durable ok' }
      yield { type: 'done' }
    },
  }
  const completedSession = await createSession({
    cwd,
    sessionId: 'durable_completed',
    provider: completedProvider,
    systemPrompt: false,
    autoSave: { sessionsDir },
  })
  const completed = await submitPrompt(completedSession, 'persist me first', {
    turnId: 'turn_completed',
  })
  assert(completed.reason === 'completed', 'completed terminal')

  let loaded = await loadTranscriptFile(completedPath)
  assert(
    statesFor(loaded.entries, 'turn_completed').join(',') ===
      'admitted,running,completed',
    'completed lifecycle order',
  )
  const completedTurn = projectDurableTurns(loaded.entries, {
    recoverIncomplete: false,
  }).find((turn) => turn.turnId === 'turn_completed')
  assert(completedTurn?.state === 'completed', 'completed projection')
  assert(completedTurn.prompt === 'persist me first', 'prompt retained')
  assert(
    loaded.entries.filter(
      (entry) =>
        entry.type === 'turn' &&
        entry.turnId === 'turn_completed' &&
        entry.prompt !== undefined,
    ).length === 1,
    'prompt is stored only on admitted',
  )
  const completedMessageIndex = lastEntryIndex(
    loaded.entries,
    (entry) => entry.type === 'message',
  )
  const completedTerminalIndex = lastEntryIndex(
    loaded.entries,
    (entry) =>
      entry.type === 'turn' &&
      entry.turnId === 'turn_completed' &&
      entry.state === 'completed',
  )
  assert(
    completedMessageIndex >= 0 &&
      completedTerminalIndex > completedMessageIndex,
    'terminal is written only after messages are durable',
  )

  const duplicate = await submitPrompt(completedSession, 'must not replay', {
    turnId: 'turn_completed',
  })
  assert(duplicate.reason === 'error', 'duplicate turn returns error')
  assert(
    duplicate.detail?.includes('turn_completed'),
    'duplicate error identifies turn',
  )
  assert(completedCalls === 1, 'duplicate turn never calls provider')

  let resumedDuplicateCalls = 0
  const resumedCompleted = await resumeSession({
    idOrPath: completedPath,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
    provider: {
      id: 'mock',
      async *completeStream() {
        resumedDuplicateCalls += 1
        yield { type: 'done' }
      },
    },
  })
  assert(
    resumedCompleted.session.durableTurns.find(
      (turn) => turn.turnId === 'turn_completed',
    )?.state === 'completed',
    'resume restores completed projection',
  )
  const resumedDuplicate = await submitPrompt(
    resumedCompleted.session,
    'must not replay after resume',
    { turnId: 'turn_completed' },
  )
  assert(resumedDuplicate.reason === 'error', 'resume duplicate returns error')
  assert(resumedDuplicateCalls === 0, 'resume duplicate never calls provider')

  const errorProvider: LlmProvider = {
    id: 'mock',
    async *completeStream() {
      yield { type: 'error', message: 'provider failed deliberately' }
      yield { type: 'done' }
    },
  }
  const errorSession = await createSession({
    cwd,
    sessionId: 'durable_error',
    provider: errorProvider,
    systemPrompt: false,
    autoSave: { sessionsDir },
  })
  const failed = await submitPrompt(errorSession, 'record provider error', {
    turnId: 'turn_error',
  })
  assert(failed.reason === 'error', 'provider error terminal')
  loaded = await loadTranscriptFile(
    path.join(sessionsDir, 'durable_error.jsonl'),
  )
  assert(
    statesFor(loaded.entries, 'turn_error').at(-1) === 'error',
    'provider error is durable',
  )

  const abortingProvider: LlmProvider = {
    id: 'mock',
    async *completeStream(_messages, options) {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve()
        options?.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        })
      })
      throw Object.assign(new Error('aborted by durable test'), {
        name: 'AbortError',
      })
    },
  }
  const abortedSession = await createSession({
    cwd,
    sessionId: 'durable_aborted',
    provider: abortingProvider,
    systemPrompt: false,
    autoSave: { sessionsDir },
  })
  const controller = new AbortController()
  const pending = submitPrompt(abortedSession, 'cancel durably', {
    turnId: 'turn_aborted',
    signal: controller.signal,
  })
  setTimeout(() => controller.abort('test'), 5)
  const aborted = await pending
  assert(aborted.reason === 'aborted', 'aborted terminal')
  loaded = await loadTranscriptFile(
    path.join(sessionsDir, 'durable_aborted.jsonl'),
  )
  assert(
    statesFor(loaded.entries, 'turn_aborted').at(-1) === 'aborted',
    'abort is durable',
  )

  const blockedParent = path.join(tmpRoot, 'not-a-directory')
  await fs.writeFile(blockedParent, 'file blocks mkdir', 'utf8')
  let admissionFailureCalls = 0
  const admissionFailureSession = await createSession({
    cwd,
    sessionId: 'durable_admission_failure',
    provider: {
      id: 'mock',
      async *completeStream() {
        admissionFailureCalls += 1
        yield { type: 'done' }
      },
    },
    systemPrompt: false,
    autoSave: {
      filePath: path.join(blockedParent, 'session.jsonl'),
    },
  })
  const admissionFailure = await submitPrompt(
    admissionFailureSession,
    'must not reach provider',
    { turnId: 'turn_admission_failure' },
  )
  assert(admissionFailure.reason === 'error', 'admission write failure errors')
  assert(
    admissionFailure.detail?.includes('durable turn admission failed'),
    'admission failure is actionable',
  )
  assert(
    admissionFailureCalls === 0,
    'admission failure calls provider zero times',
  )
  assert(
    admissionFailureSession.messages.length === 0,
    'admission failure does not enqueue user message',
  )

  const crashSession = await createSession({
    cwd,
    sessionId: 'durable_crash',
    systemPrompt: false,
  })
  const crashPath = path.join(sessionsDir, 'durable_crash.jsonl')
  await ensureTranscriptFile(
    crashPath,
    {
      sessionId: crashSession.id,
      cwd,
      createdAt: new Date().toISOString(),
    },
  )
  await appendTurnEntry(crashPath, {
    sessionId: crashSession.id,
    turnId: 'turn_admitted_only',
    state: 'admitted',
    prompt: 'admitted before crash',
  })
  await appendTurnEntry(crashPath, {
    sessionId: crashSession.id,
    turnId: 'turn_crash',
    state: 'admitted',
    prompt: 'survive process death',
  })
  await appendTurnEntry(crashPath, {
    sessionId: crashSession.id,
    turnId: 'turn_crash',
    state: 'running',
  })
  const resumed = await resumeSession({
    idOrPath: crashPath,
    cwd,
    sessionsDir,
    reassembleSystem: false,
    systemPrompt: false,
  })
  const recovered = resumed.session.durableTurns.find(
    (turn) => turn.turnId === 'turn_crash',
  )
  assert(recovered?.state === 'interrupted', 'running recovers interrupted')
  assert(recovered.recovered === true, 'interrupted is marked recovered')
  assert(
    recovered.prompt === 'survive process death',
    'recovery retains admitted prompt',
  )
  assert(
    resumed.session.durableTurns.find(
      (turn) => turn.turnId === 'turn_admitted_only',
    )?.state === 'interrupted',
    'admitted recovers interrupted',
  )

  completedSession.messages.splice(0, completedSession.messages.length, {
    role: 'user',
    content: 'compacted chain',
  })
  await rewriteTranscriptFromMessages(completedPath, completedSession, {
    compactBoundarySummary: 'durable compact',
  })
  loaded = await loadTranscriptFile(completedPath)
  assert(
    statesFor(loaded.entries, 'turn_completed').at(-1) === 'completed',
    'compact rewrite preserves turn lifecycle',
  )

  console.log('PASS: test-durable-turn')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
