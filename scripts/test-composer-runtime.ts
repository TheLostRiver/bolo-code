/**
 * OI-06F1: packages-first composer runtime adapter.
 *
 * Run: npm run test:composer-runtime
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  SessionCoordinator,
  createSession,
  getSessionComposerActions,
  loadTranscriptFile,
  releaseSessionRunner,
  requestSessionComposerControl,
  takeNextSessionQueued,
} from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

async function main() {
  const tempRoot = path.join(process.cwd(), '.bolo-tmp')
  await fs.mkdir(tempRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(tempRoot, 'composer-runtime-'))
  try {
    const transcript = path.join(root, 'composer_runtime.jsonl')
    const coordinator = new SessionCoordinator()
    const session = await createSession({
      cwd: root,
      sessionId: 'composer_runtime',
      coordinator,
      systemPrompt: false,
      autoSave: { scope: 'project', filePath: transcript },
    })
    const owner = coordinator.tryAcquire({
      sessionId: session.id,
      turnId: 'turn_active',
      querySource: 'desktop_submit',
    })
    assert(owner.ok, 'fixture acquires active turn')

    const actions = getSessionComposerActions(session, 'next step')
    assert(
      actions.find((action) => action.action === 'submit')?.available === false,
      'plain submit is unavailable while a turn is active',
    )
    for (const action of ['queue', 'steer', 'interrupt'] as const) {
      assert(
        actions.find((option) => option.action === action)?.available === true,
        `${action} is available while a turn is active`,
      )
    }

    const queued = await requestSessionComposerControl(session, {
      action: 'queue',
      text: 'next step',
    })
    assert(
      queued.ok &&
        queued.control.kind === 'queue' &&
        queued.control.state === 'pending',
      'queue is durably admitted behind the active turn',
    )
    assert(
      queued.ok &&
        queued.control.turnId !== queued.control.expectedTurnId,
      'queued input owns a new durable turn id',
    )
    const duplicate = await requestSessionComposerControl(session, {
      action: 'queue',
      text: 'next step',
    })
    assert(
      duplicate.ok && duplicate.duplicate === true,
      'repeating the same composer intent is idempotent',
    )

    const steered = await requestSessionComposerControl(session, {
      action: 'steer',
      text: 'change direction',
    })
    assert(
      steered.ok &&
        steered.control.kind === 'steer' &&
        steered.control.state === 'pending',
      'steer is admitted against the active turn',
    )

    const interrupted = await requestSessionComposerControl(session, {
      action: 'interrupt',
      text: '',
    })
    assert(
      interrupted.ok &&
        interrupted.control.kind === 'interrupt' &&
        interrupted.control.state === 'promoted',
      'interrupt is promoted immediately',
    )
    assert(owner.lease.signal.aborted, 'interrupt aborts the active owner signal')

    const released = await releaseSessionRunner(session, owner.lease)
    assert(released.released, 'active owner releases through durable barrier')
    const next = await takeNextSessionQueued(session)
    assert(
      next.control?.controlId === (queued.ok ? queued.control.controlId : ''),
      'ready queue is taken in FIFO order',
    )
    assert(
      next.control?.turnId === (queued.ok ? queued.control.turnId : ''),
      'queue take preserves the new durable turn id',
    )

    const transcriptData = await loadTranscriptFile(transcript)
    const controlEntries = transcriptData.entries.filter(
      (entry) => entry.type === 'control',
    )
    assert(
      controlEntries.some(
        (entry) =>
          entry.type === 'control' &&
          entry.controlId === (queued.ok ? queued.control.controlId : '') &&
          entry.state === 'pending',
      ),
      'queue admission is present in the JSONL transcript',
    )
    assert(
      session.durableControls.some(
        (control) =>
          control.controlId ===
            (interrupted.ok ? interrupted.control.controlId : '') &&
          control.state === 'promoted',
      ),
      'interrupt admission is projected into durable controls',
    )

    console.log('PASS: composer runtime adapter')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
