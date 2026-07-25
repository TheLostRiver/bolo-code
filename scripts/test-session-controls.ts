/**
 * DR2B1：SessionCoordinator control intents。
 * 运行：npx tsx scripts/test-session-controls.ts
 */
import { SessionCoordinator } from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function activeCoordinator() {
  const coordinator = new SessionCoordinator()
  const acquired = coordinator.tryAcquire({
    sessionId: 'control_session',
    turnId: 'turn_active',
    querySource: 'test',
  })
  assert(acquired.ok, 'fixture acquires active turn')
  return { coordinator, lease: acquired.lease }
}

async function main() {
  const { coordinator, lease } = activeCoordinator()

  const missingExpected = coordinator.requestControl({
    controlId: 'ctrl_steer_missing_expected',
    kind: 'steer',
    sessionId: 'control_session',
    prompt: 'missing expected turn',
  })
  assert(!missingExpected.ok, 'steer requires expected active turn')
  assert(
    missingExpected.code === 'expected_turn_required',
    'missing expected turn has stable code',
  )

  const wrongExpected = coordinator.requestControl({
    controlId: 'ctrl_steer_wrong_expected',
    kind: 'steer',
    sessionId: 'control_session',
    expectedTurnId: 'turn_stale',
    prompt: 'stale steer',
  })
  assert(!wrongExpected.ok, 'stale steer is rejected')
  assert(
    wrongExpected.code === 'active_turn_mismatch',
    'stale steer has stable mismatch code',
  )
  assert(
    wrongExpected.activeTurnId === 'turn_active',
    'mismatch reports actual active turn',
  )

  const steer = coordinator.requestControl({
    controlId: 'ctrl_steer',
    kind: 'steer',
    sessionId: 'control_session',
    expectedTurnId: 'turn_active',
    prompt: 'steer this turn',
  })
  assert(steer.ok, 'matching steer is accepted')
  assert(steer.control.state === 'pending', 'steer starts pending')

  const steerDuplicate = coordinator.requestControl({
    controlId: 'ctrl_steer',
    kind: 'steer',
    sessionId: 'control_session',
    expectedTurnId: 'turn_active',
    prompt: 'steer this turn',
  })
  assert(steerDuplicate.ok, 'identical control retry is accepted')
  assert(steerDuplicate.duplicate === true, 'retry is marked duplicate')
  assert(
    coordinator
      .snapshot('control_session')
      .controls.filter((control) => control.controlId === 'ctrl_steer')
      .length === 1,
    'idempotent retry does not enqueue twice',
  )

  const steerConflict = coordinator.requestControl({
    controlId: 'ctrl_steer',
    kind: 'steer',
    sessionId: 'control_session',
    expectedTurnId: 'turn_active',
    prompt: 'different payload',
  })
  assert(!steerConflict.ok, 'same control id with new payload is rejected')
  assert(
    steerConflict.code === 'control_id_conflict',
    'control id conflict has stable code',
  )

  const unsafePromotion = coordinator.promoteControls({
    sessionId: 'control_session',
    turnId: 'turn_active',
    boundary: 'after_provider',
  })
  assert(unsafePromotion.ok, 'after-provider boundary is observed')
  assert(
    unsafePromotion.controls.length === 0,
    'steer is not injected between assistant tool calls and results',
  )

  const safePromotion = coordinator.promoteControls({
    sessionId: 'control_session',
    turnId: 'turn_active',
    boundary: 'after_tools',
  })
  assert(safePromotion.ok, 'after-tools boundary is accepted')
  assert(safePromotion.controls.length === 1, 'pending steer is promoted once')
  assert(
    safePromotion.controls[0]?.controlId === 'ctrl_steer' &&
      safePromotion.controls[0]?.state === 'promoted',
    'promoted steer retains identity and state',
  )
  const repeatedPromotion = coordinator.promoteControls({
    sessionId: 'control_session',
    turnId: 'turn_active',
    boundary: 'before_provider',
  })
  assert(
    repeatedPromotion.ok && repeatedPromotion.controls.length === 0,
    'promoted steer is never replayed',
  )

  const queuedFirst = coordinator.requestControl({
    controlId: 'ctrl_queue_first',
    kind: 'queue',
    sessionId: 'control_session',
    expectedTurnId: 'turn_active',
    turnId: 'turn_queued_first',
    prompt: 'queued first',
    querySource: 'test_queue',
  })
  const queuedSecond = coordinator.requestControl({
    controlId: 'ctrl_queue_second',
    kind: 'queue',
    sessionId: 'control_session',
    expectedTurnId: 'turn_active',
    turnId: 'turn_queued_second',
    prompt: 'queued second',
  })
  assert(
    queuedFirst.ok &&
      queuedFirst.control.state === 'pending' &&
      queuedSecond.ok &&
      queuedSecond.control.state === 'pending',
    'queue waits behind active turn',
  )
  const cancelled = coordinator.cancelControl({
    sessionId: 'control_session',
    controlId: 'ctrl_queue_second',
  })
  assert(cancelled.ok, 'queued prompt can be removed before execution')
  assert(cancelled.control.state === 'cancelled', 'cancel state is visible')

  assert(lease.release(), 'active lease releases')
  const releasedSnapshot = coordinator.snapshot('control_session')
  assert(releasedSnapshot.state === 'idle', 'released session is idle')
  assert(
    releasedSnapshot.controls.find(
      (control) => control.controlId === 'ctrl_queue_first',
    )?.state === 'ready',
    'pending queue becomes ready only after active release',
  )
  assert(
    releasedSnapshot.controls.find(
      (control) => control.controlId === 'ctrl_queue_second',
    )?.state === 'cancelled',
    'cancelled queue stays cancelled',
  )

  const nextQueued = coordinator.takeNextQueued('control_session')
  assert(nextQueued?.controlId === 'ctrl_queue_first', 'FIFO queue is taken')
  assert(nextQueued.state === 'promoted', 'taken queue is promoted')
  assert(
    coordinator.takeNextQueued('control_session') === null,
    'queue entry is never returned twice',
  )

  const idleQueue = coordinator.requestControl({
    controlId: 'ctrl_queue_idle',
    kind: 'queue',
    sessionId: 'control_session',
    turnId: 'turn_queue_idle',
    prompt: 'ready immediately',
  })
  assert(
    idleQueue.ok && idleQueue.control.state === 'ready',
    'queue submitted while idle is immediately ready',
  )
  assert(
    coordinator.takeNextQueued('control_session')?.controlId ===
      'ctrl_queue_idle',
    'idle queue is consumable between turns',
  )

  const interruptOwner = coordinator.tryAcquire({
    sessionId: 'control_interrupt',
    turnId: 'turn_interrupt',
  })
  assert(interruptOwner.ok, 'interrupt fixture acquires')
  const staleInterrupt = coordinator.requestControl({
    controlId: 'ctrl_interrupt_stale',
    kind: 'interrupt',
    sessionId: 'control_interrupt',
    expectedTurnId: 'turn_other',
  })
  assert(!staleInterrupt.ok, 'interrupt rejects stale expected turn')
  assert(!interruptOwner.lease.signal.aborted, 'stale interrupt does not abort')

  const interrupt = coordinator.requestControl({
    controlId: 'ctrl_interrupt',
    kind: 'interrupt',
    sessionId: 'control_interrupt',
    expectedTurnId: 'turn_interrupt',
  })
  assert(interrupt.ok, 'matching interrupt is accepted')
  assert(interrupt.control.state === 'promoted', 'interrupt promotes to signal')
  assert(interruptOwner.lease.signal.aborted, 'interrupt aborts owner signal')
  assert(
    interruptOwner.lease.signal.reason === 'session_control_interrupt',
    'interrupt uses stable abort reason',
  )
  const interruptDuplicate = coordinator.requestControl({
    controlId: 'ctrl_interrupt',
    kind: 'interrupt',
    sessionId: 'control_interrupt',
    expectedTurnId: 'turn_interrupt',
  })
  assert(
    interruptDuplicate.ok && interruptDuplicate.duplicate === true,
    'interrupt retry is idempotent',
  )
  interruptOwner.lease.release()

  const abandonedOwner = coordinator.tryAcquire({
    sessionId: 'control_abandoned',
    turnId: 'turn_abandoned',
  })
  assert(abandonedOwner.ok, 'abandoned steer fixture acquires')
  const abandoned = coordinator.requestControl({
    controlId: 'ctrl_abandoned_steer',
    kind: 'steer',
    sessionId: 'control_abandoned',
    expectedTurnId: 'turn_abandoned',
    prompt: 'must not become a later turn',
  })
  assert(abandoned.ok, 'abandoned steer starts pending')
  abandonedOwner.lease.release()
  assert(
    coordinator
      .snapshot('control_abandoned')
      .controls.find(
        (control) => control.controlId === 'ctrl_abandoned_steer',
      )?.state === 'cancelled',
    'unpromoted steer is cancelled at terminal release',
  )

  const noActiveSteer = coordinator.requestControl({
    controlId: 'ctrl_no_active',
    kind: 'steer',
    sessionId: 'control_none',
    expectedTurnId: 'turn_none',
    prompt: 'no owner',
  })
  assert(!noActiveSteer.ok, 'steer without active turn is rejected')
  assert(
    noActiveSteer.code === 'no_active_turn',
    'no active turn has stable code',
  )

  console.log('PASS: test-session-controls')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
