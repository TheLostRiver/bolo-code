/**
 * DR2C2：session-level control lifecycle 持久化与 release barrier。
 * 运行：npx tsx scripts/test-session-control-persistence.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionCoordinator,
  cancelSessionControl,
  createSession,
  loadTranscriptFile,
  promoteSessionControls,
  releaseSessionRunner,
  requestSessionControl,
  resumeSession,
  setSessionPersistMeta,
  takeNextSessionQueued,
} from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function statesFor(
  entries: Awaited<ReturnType<typeof loadTranscriptFile>>['entries'],
  controlId: string,
): string[] {
  const states: string[] = []
  for (const entry of entries) {
    if (entry.type === 'control' && entry.controlId === controlId) {
      states.push(entry.state)
    }
  }
  return states
}

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bolo-control-persistence-'),
  )
  try {
    const coordinator = new SessionCoordinator()
    const transcript = path.join(root, 'control_persistence_session.jsonl')
    const session = await createSession({
      cwd: root,
      sessionId: 'control_persistence_session',
      coordinator,
      systemPrompt: false,
      autoSave: {
        scope: 'project',
        filePath: transcript,
      },
    })
    const owner = coordinator.tryAcquire({
      sessionId: session.id,
      turnId: 'turn_active',
      querySource: 'control_persistence_test',
    })
    assert(owner.ok, 'fixture acquires active owner')

    const queueInput = {
      controlId: 'control_queue_cancel',
      kind: 'queue' as const,
      sessionId: session.id,
      expectedTurnId: owner.lease.turnId,
      turnId: 'turn_queue_cancel',
      prompt: 'queue then cancel',
      querySource: 'test',
    }
    const queue = await requestSessionControl(session, queueInput)
    assert(queue.ok && queue.control.state === 'pending', 'queue persists pending')
    const duplicate = await requestSessionControl(session, queueInput)
    assert(
      duplicate.ok && duplicate.duplicate === true,
      'duplicate request is idempotent',
    )
    const cancelled = await cancelSessionControl(session, {
      controlId: queueInput.controlId,
    })
    assert(cancelled.ok, 'cancel persists terminal state')

    const steer = await requestSessionControl(session, {
      controlId: 'control_steer_promote',
      kind: 'steer',
      sessionId: session.id,
      expectedTurnId: owner.lease.turnId,
      prompt: 'persisted steering',
    })
    assert(steer.ok && steer.control.state === 'pending', 'steer persists pending')
    const promotedSteer = await promoteSessionControls(session, {
      turnId: owner.lease.turnId,
      boundary: 'after_tools',
    })
    assert(
      promotedSteer.ok &&
        promotedSteer.controls.length === 1 &&
        promotedSteer.controls[0]?.state === 'promoted',
      'steer promotion persists before caller sees control',
    )

    const releaseQueue = await requestSessionControl(session, {
      controlId: 'control_queue_release',
      kind: 'queue',
      sessionId: session.id,
      expectedTurnId: owner.lease.turnId,
      turnId: 'turn_queue_release',
      prompt: 'run after release',
      querySource: 'test_release',
    })
    const releaseSteer = await requestSessionControl(session, {
      controlId: 'control_steer_release',
      kind: 'steer',
      sessionId: session.id,
      expectedTurnId: owner.lease.turnId,
      prompt: 'must not escape active turn',
    })
    assert(releaseQueue.ok && releaseSteer.ok, 'release fixtures accepted')

    const barrierStarted = new Promise<void>((resolve) => {
      void owner.lease.releaseWithBarrier(async () => {
        resolve()
        await new Promise<void>((finish) => setTimeout(finish, 20))
      })
    })
    await barrierStarted
    const blockedDuringBarrier = coordinator.tryAcquire({
      sessionId: session.id,
      turnId: 'turn_too_early',
    })
    assert(
      !blockedDuringBarrier.ok,
      'same-session acquire stays busy while release barrier is pending',
    )
    const rejectedDuringBarrier = coordinator.requestControl({
      controlId: 'control_during_release',
      kind: 'queue',
      sessionId: session.id,
      expectedTurnId: owner.lease.turnId,
      turnId: 'turn_during_release',
      prompt: 'must be rejected',
    })
    assert(
      !rejectedDuringBarrier.ok &&
        rejectedDuringBarrier.code === 'turn_releasing',
      'new controls are rejected while owner is releasing',
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assert(
      coordinator.snapshot(session.id).state === 'idle',
      'manual barrier eventually releases fixture owner',
    )
    const cancelManualBarrierQueue = await cancelSessionControl(session, {
      controlId: 'control_queue_release',
    })
    assert(
      cancelManualBarrierQueue.ok,
      'manual barrier queue is removed before product release fixture',
    )

    // 以上直接 barrier 只验证 ownership；重新建立 owner 以验证产品 release wrapper 落盘。
    const releaseOwner = coordinator.tryAcquire({
      sessionId: session.id,
      turnId: 'turn_release_persist',
    })
    assert(releaseOwner.ok, 'second owner acquired after barrier')
    const persistedReleaseQueue = await requestSessionControl(session, {
      controlId: 'control_queue_release_persisted',
      kind: 'queue',
      sessionId: session.id,
      expectedTurnId: releaseOwner.lease.turnId,
      turnId: 'turn_queue_promoted',
      prompt: 'durable queued prompt',
    })
    const persistedReleaseSteer = await requestSessionControl(session, {
      controlId: 'control_steer_release_persisted',
      kind: 'steer',
      sessionId: session.id,
      expectedTurnId: releaseOwner.lease.turnId,
      prompt: 'cancel at terminal',
    })
    assert(
      persistedReleaseQueue.ok && persistedReleaseSteer.ok,
      'persisted release fixtures accepted',
    )
    const released = await releaseSessionRunner(session, releaseOwner.lease)
    assert(released.released, 'release wrapper releases ownership')
    const snapshotAfterRelease = coordinator.snapshot(session.id)
    assert(
      snapshotAfterRelease.controls.find(
        (control) =>
          control.controlId === 'control_queue_release_persisted',
      )?.state === 'ready',
      'runner release promotes queue to ready',
    )
    assert(
      snapshotAfterRelease.controls.find(
        (control) =>
          control.controlId === 'control_steer_release_persisted',
      )?.state === 'cancelled',
      'runner release cancels unconsumed steer',
    )

    const taken = await takeNextSessionQueued(session)
    assert(
      taken.control?.controlId === 'control_queue_release_persisted' &&
        taken.control.state === 'promoted',
      'take persists queue promoted before execution',
    )
    assert(
      (await takeNextSessionQueued(session)).control === null,
      'taken queue is never returned twice',
    )

    const loaded = await loadTranscriptFile(transcript)
    assert(
      statesFor(loaded.entries, queueInput.controlId).join(',') ===
        'pending,cancelled',
      'queue request/cancel transcript order is append-only',
    )
    assert(
      statesFor(loaded.entries, 'control_steer_promote').join(',') ===
        'pending,promoted',
      'steer request/promotion transcript order is append-only',
    )
    assert(
      statesFor(loaded.entries, 'control_queue_release_persisted').join(',') ===
        'pending,ready,promoted',
      'queue request/release/take transcript order is append-only',
    )
    assert(
      statesFor(loaded.entries, 'control_steer_release_persisted').join(',') ===
        'pending,cancelled',
      'release persists terminal steer cancellation',
    )
    assert(
      statesFor(loaded.entries, queueInput.controlId).filter(
        (state) => state === 'pending',
      ).length === 1,
      'duplicate request does not append a duplicate accepted entry',
    )

    const resumed = await resumeSession({
      idOrPath: transcript,
      cwd: root,
      autoSave: {
        scope: 'project',
        filePath: transcript,
      },
      create: {
        coordinator: new SessionCoordinator(),
        systemPrompt: false,
      },
    })
    assert(
      resumed.session.durableControls.find(
        (control) =>
          control.controlId === 'control_queue_release_persisted',
      )?.state === 'promoted',
      'resume restores durableControls projection',
    )
    assert(
      resumed.session.coordinator.snapshot(resumed.session.id).controls.length ===
        0,
      'resume does not automatically requeue durable controls',
    )

    const blocker = path.join(root, 'not-a-directory')
    await fs.writeFile(blocker, 'block transcript writes', 'utf8')
    const failingCoordinator = new SessionCoordinator()
    const failingSession = await createSession({
      cwd: root,
      sessionId: 'control_persistence_failure',
      coordinator: failingCoordinator,
      systemPrompt: false,
    })
    setSessionPersistMeta(failingSession, {
      autoSave: true,
      scope: 'project',
      filePath: path.join(blocker, 'failure.jsonl'),
    })
    const failingOwner = failingCoordinator.tryAcquire({
      sessionId: failingSession.id,
      turnId: 'turn_failure',
    })
    assert(failingOwner.ok, 'failure fixture acquires owner')

    const failedQueue = await requestSessionControl(failingSession, {
      controlId: 'control_failed_queue',
      kind: 'queue',
      sessionId: failingSession.id,
      expectedTurnId: failingOwner.lease.turnId,
      turnId: 'turn_failed_queue',
      prompt: 'must not execute',
    })
    assert(
      !failedQueue.ok &&
        failedQueue.code === 'control_persistence_failed' &&
        failingCoordinator
          .snapshot(failingSession.id)
          .controls.find(
            (control) => control.controlId === 'control_failed_queue',
          )?.state === 'cancelled',
      'queue admission write failure cancels intent fail-closed',
    )
    const failedSteer = await requestSessionControl(failingSession, {
      controlId: 'control_failed_steer',
      kind: 'steer',
      sessionId: failingSession.id,
      expectedTurnId: failingOwner.lease.turnId,
      prompt: 'must not inject',
    })
    assert(
      !failedSteer.ok &&
        failedSteer.code === 'control_persistence_failed',
      'steer admission write failure is rejected fail-closed',
    )
    const failedInterrupt = await requestSessionControl(failingSession, {
      controlId: 'control_failed_interrupt',
      kind: 'interrupt',
      sessionId: failingSession.id,
      expectedTurnId: failingOwner.lease.turnId,
    })
    assert(
      failedInterrupt.ok &&
        Boolean(failedInterrupt.persistenceWarning) &&
        failingOwner.lease.signal.aborted,
      'interrupt write failure reports warning but never denies applied signal',
    )
    await releaseSessionRunner(failingSession, failingOwner.lease)

    const failingPromoteOwner = failingCoordinator.tryAcquire({
      sessionId: failingSession.id,
      turnId: 'turn_failed_promote',
    })
    assert(failingPromoteOwner.ok, 'promotion failure fixture acquires owner')
    const rawSteer = failingCoordinator.requestControl({
      controlId: 'control_raw_failed_promote',
      kind: 'steer',
      sessionId: failingSession.id,
      expectedTurnId: failingPromoteOwner.lease.turnId,
      prompt: 'raw pending steer',
    })
    assert(rawSteer.ok, 'raw steer fixture accepted in memory')
    const failedPromotion = await promoteSessionControls(failingSession, {
      turnId: failingPromoteOwner.lease.turnId,
      boundary: 'after_tools',
    })
    assert(
      failedPromotion.ok &&
        failedPromotion.controls.length === 0 &&
        Boolean(failedPromotion.persistenceWarning),
      'promotion write failure never returns steer for message injection',
    )

    const rawReleaseQueue = failingCoordinator.requestControl({
      controlId: 'control_raw_failed_release',
      kind: 'queue',
      sessionId: failingSession.id,
      expectedTurnId: failingPromoteOwner.lease.turnId,
      turnId: 'turn_raw_failed_release',
      prompt: 'must not become executable',
    })
    assert(rawReleaseQueue.ok, 'raw release queue fixture accepted')
    const failedRelease = await releaseSessionRunner(
      failingSession,
      failingPromoteOwner.lease,
    )
    assert(
      failedRelease.released &&
        Boolean(failedRelease.persistenceWarning) &&
        failingCoordinator.snapshot(failingSession.id).state === 'idle' &&
        failingCoordinator
          .snapshot(failingSession.id)
          .controls.find(
            (control) =>
              control.controlId === 'control_raw_failed_release',
          )?.state === 'cancelled',
      'release persistence failure frees owner and cancels executable queue',
    )

    const rawIdleQueue = failingCoordinator.requestControl({
      controlId: 'control_raw_failed_take',
      kind: 'queue',
      sessionId: failingSession.id,
      turnId: 'turn_raw_failed_take',
      prompt: 'must not run after failed take write',
    })
    assert(rawIdleQueue.ok, 'raw idle queue fixture accepted')
    const failedTake = await takeNextSessionQueued(failingSession)
    assert(
      failedTake.control === null &&
        Boolean(failedTake.persistenceWarning),
      'take write failure withholds queued prompt from caller',
    )

    console.log('PASS: test-session-control-persistence')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
