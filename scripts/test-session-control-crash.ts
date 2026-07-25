/**
 * DR2C3：control crash/partial-write 与 append-vs-rewrite closeout。
 * 运行：npx tsx scripts/test-session-control-crash.ts
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
  projectDurableControls,
  rewriteTranscriptFromMessages,
} from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bolo-control-crash-'),
  )
  try {
    const session = await createSession({
      cwd: root,
      sessionId: 'control_crash_session',
      systemPrompt: false,
    })
    session.messages.push(
      { role: 'user', content: 'before rewrite race' },
      { role: 'assistant', content: 'stable answer' },
    )
    const transcript = path.join(root, `${session.id}.jsonl`)
    await ensureTranscriptFile(transcript, metaInputFromSession(session))

    // 构造确定性竞态：rewrite 已读旧文件、尚未 rename 时追加 control。
    const originalWriteFile = fs.writeFile.bind(fs)
    let pausedResolve!: () => void
    const rewritePaused = new Promise<void>((resolve) => {
      pausedResolve = resolve
    })
    let releaseRewrite!: () => void
    const rewriteRelease = new Promise<void>((resolve) => {
      releaseRewrite = resolve
    })
    let intercepted = false
    const writableFs = fs as typeof fs & {
      writeFile: typeof fs.writeFile
    }
    writableFs.writeFile = (async (
      file: Parameters<typeof fs.writeFile>[0],
      data: Parameters<typeof fs.writeFile>[1],
      options?: Parameters<typeof fs.writeFile>[2],
    ) => {
      const candidate = String(file)
      if (
        !intercepted &&
        candidate.includes(`.${path.basename(transcript)}.`) &&
        candidate.endsWith('.tmp')
      ) {
        intercepted = true
        pausedResolve()
        await rewriteRelease
      }
      return await originalWriteFile(file, data, options)
    }) as typeof fs.writeFile

    try {
      const rewrite = rewriteTranscriptFromMessages(transcript, session, {
        compactBoundarySummary: 'DR2C3 race fixture',
      })
      await rewritePaused
      const append = appendControlEntry(transcript, {
        controlId: 'control_during_rewrite',
        sessionId: session.id,
        kind: 'queue',
        state: 'pending',
        turnId: 'turn_after_rewrite',
        prompt: 'must survive rewrite race',
        timestamp: '2026-07-26T06:00:00.000Z',
      })
      const appendState = await Promise.race([
        append.then(() => 'completed' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), 25),
        ),
      ])
      releaseRewrite()
      await Promise.all([rewrite, append])
      assert(
        appendState === 'blocked',
        'append waits while rewrite owns the transcript write barrier',
      )
    } finally {
      writableFs.writeFile = originalWriteFile
      releaseRewrite()
    }

    let loaded = await loadTranscriptFile(transcript)
    assert(
      loaded.entries.some(
        (entry) =>
          entry.type === 'control' &&
          entry.controlId === 'control_during_rewrite',
      ),
      'control appended during compact rewrite is never overwritten',
    )

    // 同一路径的高并发 append 必须保持每行完整且不丢 entry。
    const concurrentEvents = Array.from({ length: 32 }, (_, index) => ({
      controlId: `control_concurrent_${index}`,
      sessionId: session.id,
      kind: 'interrupt' as const,
      state: 'promoted' as const,
      expectedTurnId: 'turn_concurrent',
      boundary: 'interrupt_signal' as const,
      timestamp: new Date(
        Date.parse('2026-07-26T06:01:00.000Z') + index,
      ).toISOString(),
    }))
    await Promise.all(
      concurrentEvents.map((event) =>
        appendControlEntry(transcript, event),
      ),
    )
    loaded = await loadTranscriptFile(transcript)
    assert(
      concurrentEvents.every((event) =>
        loaded.entries.some(
          (entry) =>
            entry.type === 'control' &&
            entry.controlId === event.controlId,
        ),
      ),
      'concurrent control appends are complete and parseable',
    )

    // 一次 append 失败不得让同路径后续写永久卡住或继承 rejection。
    const originalAppendFile = fs.appendFile.bind(fs)
    let failedOnce = false
    const appendWritableFs = fs as typeof fs & {
      appendFile: typeof fs.appendFile
    }
    appendWritableFs.appendFile = (async (
      file: Parameters<typeof fs.appendFile>[0],
      data: Parameters<typeof fs.appendFile>[1],
      options?: Parameters<typeof fs.appendFile>[2],
    ) => {
      if (
        !failedOnce &&
        String(file) === transcript &&
        String(data).includes('control_fail_once')
      ) {
        failedOnce = true
        throw Object.assign(new Error('injected transcript append failure'), {
          code: 'EIO',
        })
      }
      return await originalAppendFile(file, data, options)
    }) as typeof fs.appendFile
    let injectedFailureObserved = false
    try {
      await appendControlEntry(transcript, {
        controlId: 'control_fail_once',
        sessionId: session.id,
        kind: 'queue',
        state: 'ready',
        turnId: 'turn_fail_once',
        prompt: 'injected failure',
        timestamp: '2026-07-26T06:01:30.000Z',
      })
    } catch {
      injectedFailureObserved = true
    }
    assert(injectedFailureObserved, 'fixture observes injected append failure')
    await appendControlEntry(transcript, {
      controlId: 'control_after_failure',
      sessionId: session.id,
      kind: 'queue',
      state: 'ready',
      turnId: 'turn_after_failure',
      prompt: 'writer queue recovered',
      timestamp: '2026-07-26T06:01:31.000Z',
    })
    appendWritableFs.appendFile = originalAppendFile
    loaded = await loadTranscriptFile(transcript)
    assert(
      loaded.entries.some(
        (entry) =>
          entry.type === 'control' &&
          entry.controlId === 'control_after_failure',
      ),
      'transcript writer continues after a rejected append',
    )

    // 模拟进程在 JSON 行中途退出；坏尾行不得擦除之前已确认的 lifecycle。
    await appendControlEntry(transcript, {
      controlId: 'control_before_crash',
      sessionId: session.id,
      kind: 'steer',
      state: 'pending',
      expectedTurnId: 'turn_crashed',
      prompt: 'diagnostic only',
      timestamp: '2026-07-26T06:02:00.000Z',
    })
    await fs.appendFile(
      transcript,
      '{"type":"control","sessionId":"control_crash_session","controlId":"truncated',
      'utf8',
    )
    loaded = await loadTranscriptFile(transcript)
    const recovered = projectDurableControls(loaded.entries)
    const crashed = recovered.find(
      (control) => control.controlId === 'control_before_crash',
    )
    assert(
      crashed?.state === 'interrupted' &&
        crashed.interruptedFrom === 'pending',
      'partial tail is skipped and prior pending control recovers interrupted',
    )

    // 同 id 的冲突行 fail-closed 跳过，不能改写原始 kind/payload。
    await fs.appendFile(
      transcript,
      `\n${JSON.stringify({
        type: 'control',
        sessionId: session.id,
        timestamp: '2026-07-26T06:03:00.000Z',
        controlId: 'control_before_crash',
        kind: 'queue',
        state: 'promoted',
        turnId: 'turn_conflict',
        prompt: 'conflicting payload',
      })}\n`,
      'utf8',
    )
    const conflicted = await loadTranscriptFile(transcript)
    assert(
      conflicted.entries.some(
        (entry) =>
          entry.type === 'control' &&
          entry.controlId === 'control_before_crash' &&
          entry.kind === 'queue',
      ),
      'conflicting duplicate fixture is syntactically parsed',
    )
    const conflictProjection = projectDurableControls(conflicted.entries)
    assert(
      conflictProjection.find(
        (control) => control.controlId === 'control_before_crash',
      )?.kind === 'steer',
      'conflicting duplicate controlId cannot replace original lifecycle',
    )

    console.log('PASS: test-session-control-crash')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
