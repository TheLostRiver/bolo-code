/**
 * OI-06F2: packages-first model/effort settings mutation.
 *
 * Run: npm run test:session-settings
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createSession,
  getSessionModelEffortSettings,
  loadSession,
  updateSessionModelEffort,
} from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function settingsAre(
  session: { model?: string; effortLevel?: string },
  model: string,
  effortLevel: string | undefined,
) {
  return session.model === model && session.effortLevel === effortLevel
}

async function main() {
  const tempRoot = path.join(process.cwd(), '.bolo-tmp')
  await fs.mkdir(tempRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(tempRoot, 'session-settings-'))
  try {
    const transcript = path.join(root, 'settings_session.jsonl')
    const session = await createSession({
      cwd: root,
      sessionId: 'settings_session',
      systemPrompt: false,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      effortDialect: 'deepseek-chat',
      effortLevel: 'high',
      autoSave: { scope: 'project', filePath: transcript },
    })

    const initial = getSessionModelEffortSettings(session)
    assert(initial.model === 'deepseek-chat', 'snapshot exposes current model')
    assert(initial.effortLevel === 'high', 'snapshot exposes current effort')
    assert(
      initial.modelSuggestions.includes('deepseek-reasoner'),
      'builtin models are suggestions for the current provider',
    )
    assert(
      !JSON.stringify(initial).toLowerCase().includes('apikey'),
      'settings snapshot has no secret-bearing fields',
    )

    const invalidEffort = await updateSessionModelEffort(session, {
      effort: 'low',
    })
    assert(
      !invalidEffort.ok && invalidEffort.code === 'invalid_effort',
      'unchoosable effort is rejected',
    )
    assert(
      settingsAre(session, 'deepseek-chat', 'high'),
      'validation failure preserves old model and effort',
    )

    const invalidModel = await updateSessionModelEffort(session, {
      model: 'bad\nmodel',
    })
    assert(
      !invalidModel.ok && invalidModel.code === 'invalid_model',
      'model control characters are rejected before mutation',
    )
    assert(
      settingsAre(session, 'deepseek-chat', 'high'),
      'invalid model preserves old value',
    )

    const updated = await updateSessionModelEffort(session, {
      model: 'deepseek-reasoner',
      effort: 'max',
    })
    assert(updated.ok, 'valid model and effort update succeeds')
    assert(updated.ok && updated.persisted, 'durable session saves immediately')
    assert(
      settingsAre(session, 'deepseek-reasoner', 'max'),
      'valid update mutates both fields',
    )

    const loaded = await loadSession(transcript, { cwd: root })
    assert(
      loaded.snapshot.model === 'deepseek-reasoner' &&
        loaded.snapshot.effortLevel === 'max',
      'model and effort survive an immediate reload',
    )

    const automatic = await updateSessionModelEffort(session, {
      effort: 'auto',
    })
    assert(
      automatic.ok && session.effortLevel === undefined,
      'auto clears the session effort override',
    )

    const blocker = path.join(root, 'not-a-directory')
    await fs.writeFile(blocker, 'block writes below this path', 'utf8')
    const rollbackSession = await createSession({
      cwd: root,
      sessionId: 'settings_rollback',
      systemPrompt: false,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      effortDialect: 'deepseek-chat',
      effortLevel: 'high',
      autoSave: {
        scope: 'project',
        filePath: path.join(blocker, 'settings_rollback.jsonl'),
      },
    })
    const classifier: NonNullable<typeof rollbackSession.classifyPermission> =
      async () => ({ decision: 'deny', reason: 'fixture' })
    rollbackSession.classifyPermission = classifier
    rollbackSession.promptCacheState = {
      ttlMs: 60_000,
      lastModel: 'deepseek-chat',
      lastBreakReason: 'forced',
      lastBreakDetail: 'fixture',
      breakCount: 3,
    }
    const oldCache = JSON.stringify(rollbackSession.promptCacheState)

    const failed = await updateSessionModelEffort(rollbackSession, {
      model: 'deepseek-reasoner',
      effort: 'max',
    })
    assert(
      !failed.ok && failed.code === 'settings_persistence_failed',
      'write failure is reported as a structured mutation failure',
    )
    assert(
      settingsAre(rollbackSession, 'deepseek-chat', 'high'),
      'write failure restores visible settings',
    )
    assert(
      rollbackSession.classifyPermission === classifier &&
        JSON.stringify(rollbackSession.promptCacheState) === oldCache,
      'write failure restores classifier and prompt-cache state',
    )

    console.log('PASS: session model/effort settings')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
