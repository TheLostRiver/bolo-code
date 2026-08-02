/**
 * ROB-3: 后台任务 manifest — shared 纯契约、落盘/恢复投影/清理、/bg 展示。
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BACKGROUND_SHELL_STATUSES,
  createBackgroundShellRecord,
  createBackgroundShellStore,
  formatBackgroundShellStatusLine,
  listBackgroundShells,
  markShellInterrupted,
  markShellKilled,
  parseBackgroundShellManifest,
  registerBackgroundShell,
  serializeBackgroundShellManifest,
  type BackgroundShellRecord,
} from '../packages/shared/src/index.ts'
import { killBackgroundShell, spawnBackgroundShell } from '../packages/tools/src/index.ts'
import {
  persistBackgroundShellManifest,
  removeBackgroundShellManifest,
  resolveBackgroundShellManifestPath,
} from '../packages/core/src/backgroundShellManifest.ts'
import { createSession, saveSession, resumeSession } from '../packages/core/src/index.ts'

function runningRecord(shellId: string): BackgroundShellRecord {
  return createBackgroundShellRecord({
    shellId,
    command: 'npm run dev',
    outputPath: `C:\\logs\\${shellId}.log`,
    startedAt: '2026-08-02T12:00:00.000Z',
    description: 'dev server',
  })
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`FAIL: ${message}`)
}

async function main(): Promise<void> {
  // ---- shared: interrupted projection ----
  const running = runningRecord('sh_1')
  assert.equal(BACKGROUND_SHELL_STATUSES.includes('interrupted'), true)
  const interrupted = markShellInterrupted(running, {
    endedAt: '2026-08-02T13:00:00.000Z',
  })
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.endedAt, '2026-08-02T13:00:00.000Z')
  assert.equal(
    markShellInterrupted(interrupted, { endedAt: 'later' }).status,
    'interrupted',
    'interrupted records are terminal (no-op on re-mark)',
  )
  const killed = markShellKilled(running, { endedAt: 't' })
  assert.equal(
    markShellInterrupted(killed, { endedAt: 'later' }).status,
    'killed',
    'killed records are not downgraded to interrupted',
  )
  assert(
    formatBackgroundShellStatusLine(interrupted).includes('[leftover]'),
    'status line marks leftovers',
  )
  assert(
    !formatBackgroundShellStatusLine(running).includes('[leftover]'),
    'running records carry no leftover marker',
  )

  // ---- shared: manifest serialization ----
  const store = createBackgroundShellStore()
  registerBackgroundShell(store, running)
  const done = {
    ...runningRecord('sh_2'),
    status: 'completed' as const,
    exitCode: 0,
    endedAt: '2026-08-02T12:05:00.000Z',
    readOffset: 120,
    bytesWritten: 1024,
    killedForSize: false,
  }
  registerBackgroundShell(store, done)
  const text = serializeBackgroundShellManifest(store)
  const parsed = parseBackgroundShellManifest(text)
  assert(parsed, 'roundtrip parses')
  assert.deepEqual(
    parsed!.order,
    ['sh_1', 'sh_2'],
    'order is preserved',
  )
  assert.deepEqual(parsed!.shells.sh_2, done, 'terminal fields survive')

  // fail-closed cases
  for (const bad of [
    'not json',
    JSON.stringify({ order: ['sh_1'] }),
    JSON.stringify({ order: ['sh_1'], shells: { sh_1: { shellId: 'sh_1' } } }),
    JSON.stringify({
      order: ['sh_1'],
      shells: {
        sh_1: {
          ...running,
          status: 'warped',
        },
      },
    }),
    JSON.stringify({
      order: ['sh_1'],
      shells: {
        sh_1: {
          ...running,
          shellId: 'sh_1\u0001',
        },
      },
    }),
    JSON.stringify({ order: ['sh_1'], shells: { other: running } }),
  ]) {
    assert.equal(
      parseBackgroundShellManifest(bad),
      undefined,
      `malformed manifest is rejected: ${bad.slice(0, 60)}`,
    )
  }

  // ---- integration: spawn → persist → resume projection → remove ----
  const root = path.resolve('.bolo-tmp', 'test-bash-background-manifest')
  await fs.rm(root, { recursive: true, force: true })
  const cwd = path.join(root, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const sessionsDir = path.join(root, 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })

  const session = await createSession({
    cwd,
    sessionId: 'manifest-session',
    systemPrompt: false,
    permissionMode: 'bypassPermissions',
    model: 'mock-model',
  })
  const { path: jsonPath } = await saveSession(session, {
    sessionsDir,
    writeJsonSnapshot: true,
  })
  await fs.writeFile(path.join(jsonPath.replace(/\.json$/u, '') + '.jsonl'), '', 'utf8')
  const transcriptPath = jsonPath.replace(/\.json$/u, '.jsonl')

  // 真实 spawn 一个慢进程（running 状态）
  const sessionStore = session.backgroundShells!
  const spawned = await spawnBackgroundShell({
    store: sessionStore,
    command: 'node -e "setTimeout(()=>{}, 8000)"',
    cwd,
    file: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 8000)'],
    sessionId: session.id,
  })
  assert.equal(spawned.ok, true)
  if (spawned.ok) {
    assert.equal(spawned.record.status, 'running')
    await waitFor(
      () => sessionStore.shells[spawned.record.shellId] !== undefined,
      'spawned shell is registered',
    )
    await persistBackgroundShellManifest(session)
    const manifestPath = resolveBackgroundShellManifestPath(transcriptPath)
    const manifestText = await fs.readFile(manifestPath, 'utf8')
    const manifest = parseBackgroundShellManifest(manifestText)
    assert(manifest, 'manifest written at the session save point')
    assert.equal(
      manifest!.shells[spawned.record.shellId]?.status,
      'running',
      'manifest keeps the running status',
    )

    // resume 投影：running → interrupted
    const resumed = await resumeSession({
      idOrPath: jsonPath,
      cwd,
      reassembleSystem: false,
      systemPrompt: false,
    })
    const restored = resumed.session.backgroundShells
    assert(restored, 'resume restores the background shell store')
    assert.equal(
      restored!.shells[spawned.record.shellId]?.status,
      'interrupted',
      'running records project to interrupted on resume',
    )
    assert(
      listBackgroundShells(restored!).some((r) =>
        formatBackgroundShellStatusLine(r).includes('[leftover]'),
      ),
      'resumed store carries the leftover marker',
    )

    // 正常结束：manifest 被清除
    await removeBackgroundShellManifest(resumed.session)
    await assert.rejects(
      fs.access(manifestPath),
      'cleanup removes the manifest after a normal end',
    )

    // 收尾：杀遗留子进程，等其退出后再清理目录（Windows cwd 锁）
    await killBackgroundShell(sessionStore, spawned.record.shellId)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: ROB-3 background shell manifest')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
