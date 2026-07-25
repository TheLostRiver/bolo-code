/**
 * DR2C1：durable control transcript schema、恢复投影与 rewrite 保留。
 * 运行：npx tsx scripts/test-session-control-recovery.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendControlEntry,
  createSession,
  ensureTranscriptFile,
  loadTranscriptFile,
  metaInputFromSession,
  projectDurableControlEvents,
  projectDurableControls,
  rewriteTranscriptFromMessages,
  type DurableControlEvent,
} from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

async function main() {
  const events: DurableControlEvent[] = [
    {
      controlId: 'ctrl_pending',
      sessionId: 'control_recovery_session',
      kind: 'steer',
      state: 'pending',
      expectedTurnId: 'turn_active',
      prompt: 'steer after restart',
      timestamp: '2026-07-26T00:00:00.000Z',
    },
    {
      controlId: 'ctrl_queue',
      sessionId: 'control_recovery_session',
      kind: 'queue',
      state: 'pending',
      expectedTurnId: 'turn_active',
      turnId: 'turn_queued',
      prompt: 'queued after restart',
      querySource: 'test',
      timestamp: '2026-07-26T00:00:01.000Z',
    },
    {
      controlId: 'ctrl_queue',
      sessionId: 'control_recovery_session',
      kind: 'queue',
      state: 'ready',
      boundary: 'turn_terminal',
      timestamp: '2026-07-26T00:00:02.000Z',
    },
    {
      controlId: 'ctrl_interrupt',
      sessionId: 'control_recovery_session',
      kind: 'interrupt',
      state: 'promoted',
      expectedTurnId: 'turn_active',
      boundary: 'interrupt_signal',
      timestamp: '2026-07-26T00:00:03.000Z',
    },
    {
      controlId: 'ctrl_cancelled',
      sessionId: 'control_recovery_session',
      kind: 'queue',
      state: 'cancelled',
      turnId: 'turn_cancelled',
      prompt: 'cancel me',
      timestamp: '2026-07-26T00:00:04.000Z',
    },
  ]

  const liveProjection = projectDurableControlEvents(events, {
    recoverIncomplete: false,
  })
  const liveQueue = liveProjection.find(
    (control) => control.controlId === 'ctrl_queue',
  )
  assert(liveQueue?.state === 'ready', 'last control state wins')
  assert(liveQueue.turnId === 'turn_queued', 'later state preserves queue turnId')
  assert(
    liveQueue.prompt === 'queued after restart' &&
      liveQueue.requestedAt === '2026-07-26T00:00:01.000Z',
    'later state preserves admission payload and requestedAt',
  )

  const recovered = projectDurableControlEvents(events)
  const recoveredSteer = recovered.find(
    (control) => control.controlId === 'ctrl_pending',
  )
  const recoveredQueue = recovered.find(
    (control) => control.controlId === 'ctrl_queue',
  )
  assert(
    recoveredSteer?.state === 'interrupted' &&
      recoveredSteer.interruptedFrom === 'pending' &&
      recoveredSteer.recovered === true,
    'pending steer becomes interrupted on restart',
  )
  assert(
    recoveredQueue?.state === 'interrupted' &&
      recoveredQueue.interruptedFrom === 'ready' &&
      recoveredQueue.turnId === 'turn_queued',
    'ready queue becomes diagnostic interrupted and is not auto-replayed',
  )
  assert(
    recovered.find((control) => control.controlId === 'ctrl_interrupt')
      ?.state === 'promoted',
    'promoted interrupt remains a recorded action',
  )
  assert(
    recovered.find((control) => control.controlId === 'ctrl_cancelled')
      ?.state === 'cancelled',
    'cancelled control remains terminal',
  )

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bolo-control-recovery-'),
  )
  const transcript = path.join(root, 'control_recovery_session.jsonl')
  const session = await createSession({
    cwd: root,
    sessionId: 'control_recovery_session',
    systemPrompt: false,
  })
  await ensureTranscriptFile(transcript, metaInputFromSession(session))
  for (const event of events) {
    await appendControlEntry(transcript, event)
  }
  await fs.appendFile(
    transcript,
    '{"type":"control","controlId":"","state":"pending"}\n',
    'utf8',
  )

  const loaded = await loadTranscriptFile(transcript)
  const controlEntries = loaded.entries.filter(
    (entry) => entry.type === 'control',
  )
  assert(
    controlEntries.length === events.length,
    'parser keeps valid control entries and skips malformed rows',
  )
  const transcriptProjection = projectDurableControls(loaded.entries)
  assert(
    transcriptProjection.find(
      (control) => control.controlId === 'ctrl_queue',
    )?.state === 'interrupted',
    'transcript projection applies fail-closed recovery',
  )

  session.messages.push(
    { role: 'user', content: 'before compact rewrite' },
    { role: 'assistant', content: 'after compact rewrite' },
  )
  await rewriteTranscriptFromMessages(transcript, session, {
    compactBoundarySummary: 'DR2C rewrite fixture',
  })
  const rewritten = await loadTranscriptFile(transcript)
  assert(
    rewritten.entries.filter((entry) => entry.type === 'control').length ===
      events.length,
    'compact/shrink rewrite preserves full control lifecycle',
  )
  assert(
    projectDurableControls(rewritten.entries).find(
      (control) => control.controlId === 'ctrl_interrupt',
    )?.state === 'promoted',
    'rewritten transcript keeps control projection',
  )

  const oldTranscript = path.join(root, 'old-session.jsonl')
  await fs.writeFile(
    oldTranscript,
    `${JSON.stringify({
      type: 'meta',
      sessionId: 'old-session',
      timestamp: '2026-07-26T00:00:00.000Z',
    })}\n`,
    'utf8',
  )
  const oldLoaded = await loadTranscriptFile(oldTranscript)
  assert(
    projectDurableControls(oldLoaded.entries).length === 0,
    'old transcript without controls remains readable',
  )

  await fs.rm(root, { recursive: true, force: true })
  console.log('PASS: test-session-control-recovery')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
