/**
 * DR2B3c：最小 /turn 控制面与 CLI queue drain。
 * 运行：npx tsx scripts/test-turn-cli.ts
 */
import {
  SessionCoordinator,
  createSession,
  submitUserInput,
} from '../packages/core/src/index.ts'
import {
  runOnePrompt,
  takeNextQueuedReplPrompt,
} from '../packages/cli/src/resumeCli.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

async function main() {
  const coordinator = new SessionCoordinator()
  const provider: LlmProvider = {
    id: 'turn-cli',
    async *completeStream() {
      yield { type: 'text_delta', text: 'queued answer' }
      yield { type: 'done' }
    },
  }
  const session = await createSession({
    cwd: process.cwd(),
    sessionId: 'turn_cli_session',
    coordinator,
    provider,
    systemPrompt: false,
  })

  const owner = coordinator.tryAcquire({
    sessionId: session.id,
    turnId: 'turn_cli_active',
    querySource: 'turn_cli_test',
  })
  assert(owner.ok, 'fixture acquires active runner')

  const status = await submitUserInput(session, '/turn status')
  assert(
    status.type === 'slash' &&
      status.message.includes('turn_cli_active') &&
      status.message.includes('running'),
    '/turn status shows active turn',
  )

  const steer = await submitUserInput(session, '/turn steer clarify this')
  assert(steer.type === 'slash' && steer.message.includes('pending'), 'steer accepted')
  const steerRecord = coordinator
    .snapshot(session.id)
    .controls.find((control) => control.kind === 'steer')
  assert(
    steerRecord?.expectedTurnId === 'turn_cli_active' &&
      steerRecord.prompt === 'clarify this',
    '/turn steer targets current active turn',
  )

  const queued = await submitUserInput(session, '/turn queue queued prompt')
  assert(queued.type === 'slash' && queued.message.includes('pending'), 'queue accepted')
  const queueRecord = coordinator
    .snapshot(session.id)
    .controls.find((control) => control.kind === 'queue')
  assert(queueRecord?.turnId, '/turn queue allocates stable turn id')

  const cancelled = await submitUserInput(
    session,
    `/turn cancel ${queueRecord.controlId}`,
  )
  assert(
    cancelled.type === 'slash' && cancelled.message.includes('cancelled'),
    '/turn cancel removes pending queue',
  )

  const interrupted = await submitUserInput(session, '/turn interrupt')
  assert(
    interrupted.type === 'slash' && interrupted.message.includes('promoted'),
    '/turn interrupt reports promoted signal',
  )
  assert(owner.lease.signal.aborted, '/turn interrupt aborts active runner')
  owner.lease.release()

  const idleQueue = await submitUserInput(
    session,
    '/turn queue run this from the repl',
  )
  assert(
    idleQueue.type === 'slash' && idleQueue.message.includes('ready'),
    'idle /turn queue is ready',
  )
  const idleQueueRecord = coordinator
    .snapshot(session.id)
    .controls.find(
      (control) =>
        control.kind === 'queue' &&
        control.prompt === 'run this from the repl',
    )
  assert(idleQueueRecord?.turnId, 'idle queue keeps generated turn id')

  const next = await takeNextQueuedReplPrompt(session)
  assert(next?.prompt === 'run this from the repl', 'CLI drains ready queue')
  assert(next.turnId === idleQueueRecord.turnId, 'CLI preserves queued turn id')
  assert(
    (await takeNextQueuedReplPrompt(session)) === null,
    'CLI never drains the same queue twice',
  )

  await runOnePrompt(session, next.prompt, {
    isTty: false,
    writeOut: () => undefined,
    writeErr: () => undefined,
    turnId: next.turnId,
    querySource: next.querySource,
  })
  assert(
    session.durableTurns.some(
      (turn) =>
        turn.turnId === next.turnId && turn.state === 'completed',
    ),
    'queued CLI prompt executes under its admitted turn id',
  )

  const idleStatus = await submitUserInput(session, '/turn status')
  assert(
    idleStatus.type === 'slash' &&
      idleStatus.message.includes('idle') &&
      idleStatus.message.includes('cancelled') &&
      idleStatus.message.includes('promoted'),
    '/turn status shows idle runner and control history',
  )

  console.log('PASS: test-turn-cli')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
