/**
 * AR-T2b：后台 shell 运行时（真实进程）
 * - spawn → 输出落盘 → 增量游标读不重不漏
 * - 自然退出捕获退出码
 * - kill 真的杀掉进程（含进程树），且幂等
 * - killAll 收尸后无存活进程
 * - 工具层：Bash(run_in_background) / BashOutput / KillShell 契约
 *
 * 运行：npx tsx scripts/test-bash-background-runtime.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBashOutputTool,
  createBashTool,
  createKillShellTool,
  isProcessAlive,
  killAllBackgroundShells,
  killBackgroundShell,
  readBackgroundShellOutput,
  spawnBackgroundShell,
} from '../packages/tools/src/index.ts'
import {
  createBackgroundShellStore,
  getBackgroundShell,
  listBackgroundShells,
} from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const isWin = process.platform === 'win32'
const sh = isWin ? 'cmd.exe' : 'sh'
const shArgs = (cmd: string) => (isWin ? ['/c', cmd] : ['-c', cmd])

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 轮询直到条件成立或超时，避免固定 sleep 造成的偶发失败 */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(stepMs)
  }
  return false
}

async function main() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-bg-'))

  // ── 1) spawn + 落盘 + 自然退出 ──
  {
    const store = createBackgroundShellStore()
    const cmd = 'echo hello-bolo'
    const spawned = await spawnBackgroundShell({
      store,
      command: cmd,
      cwd,
      file: sh,
      args: shArgs(cmd),
      sessionId: 'sess_bg_1',
    })
    assert(spawned.ok === true, 'spawn succeeds')
    if (!spawned.ok) return
    const id = spawned.record.shellId
    assert(spawned.record.status === 'running', 'record starts running')
    assert(listBackgroundShells(store).length === 1, 'shell registered in store')

    const exited = await waitFor(
      () => getBackgroundShell(store, id)?.status === 'completed',
    )
    assert(exited, 'short command reaches completed')
    assert(
      getBackgroundShell(store, id)?.exitCode === 0,
      'exit code 0 captured',
    )

    const read = await readBackgroundShellOutput(store, id)
    assert(read.ok === true, 'read succeeds')
    if (!read.ok) return
    assert(read.content.includes('hello-bolo'), 'stdout landed on disk')
    assert(read.bytesRead > 0, 'bytes read counted')

    // 游标：再读一次应为空（不重复）
    const again = await readBackgroundShellOutput(store, id)
    assert(again.ok === true && again.content === '', 'cursor prevents re-read')
  }

  // ── 2) 非零退出码 → failed ──
  {
    const store = createBackgroundShellStore()
    const cmd = isWin ? 'exit 3' : 'exit 3'
    const spawned = await spawnBackgroundShell({
      store,
      command: cmd,
      cwd,
      file: sh,
      args: shArgs(cmd),
      sessionId: 'sess_bg_2',
    })
    assert(spawned.ok === true, 'spawn (exit 3) succeeds')
    if (!spawned.ok) return
    const id = spawned.record.shellId
    const done = await waitFor(
      () => getBackgroundShell(store, id)?.status === 'failed',
    )
    assert(done, 'non-zero exit → failed')
    assert(getBackgroundShell(store, id)?.exitCode === 3, 'exit code 3 captured')
  }

  // ── 3) 增量读：长跑进程分批产出 ──
  {
    const store = createBackgroundShellStore()
    // 每 ~200ms 输出一行，跑 ~3s
    const cmd = isWin
      ? 'for /L %i in (1,1,10) do (echo tick-%i & ping -n 2 127.0.0.1 >nul)'
      : 'for i in 1 2 3 4 5 6 7 8 9 10; do echo tick-$i; sleep 0.2; done'
    const spawned = await spawnBackgroundShell({
      store,
      command: cmd,
      cwd,
      file: sh,
      args: shArgs(cmd),
      sessionId: 'sess_bg_3',
    })
    assert(spawned.ok === true, 'spawn (ticker) succeeds')
    if (!spawned.ok) return
    const id = spawned.record.shellId

    const gotSome = await waitFor(async () => {
      const r = await readBackgroundShellOutput(store, id)
      return r.ok && r.content.includes('tick-1')
    })
    assert(gotSome, 'incremental read sees early output while still running')

    // 收集剩余输出直到进程结束
    let collected = ''
    await waitFor(async () => {
      const r = await readBackgroundShellOutput(store, id)
      if (r.ok) collected += r.content
      return getBackgroundShell(store, id)?.status !== 'running'
    })
    // 结束后再排空一次
    const tail = await readBackgroundShellOutput(store, id)
    if (tail.ok) collected += tail.content
    assert(collected.includes('tick-10'), 'later output delivered without loss')
  }

  // ── 4) kill 真的杀掉进程；幂等 ──
  {
    const store = createBackgroundShellStore()
    const cmd = isWin
      ? 'ping -n 600 127.0.0.1 >nul'
      : 'sleep 600'
    const spawned = await spawnBackgroundShell({
      store,
      command: cmd,
      cwd,
      file: sh,
      args: shArgs(cmd),
      sessionId: 'sess_bg_4',
    })
    assert(spawned.ok === true, 'spawn (long sleeper) succeeds')
    if (!spawned.ok) return
    const id = spawned.record.shellId
    const pid = spawned.record.pid
    assert(typeof pid === 'number', 'pid captured')
    assert(isProcessAlive(pid!), 'process is alive before kill')

    const killed = await killBackgroundShell(store, id)
    assert(killed.ok === true, 'kill returns ok')
    assert(
      killed.ok === true && killed.alreadyTerminal === false,
      'first kill is a real kill',
    )
    assert(
      getBackgroundShell(store, id)?.status === 'killed',
      'record marked killed',
    )

    const gone = await waitFor(() => !isProcessAlive(pid!), 15_000)
    assert(gone, 'process is actually dead after kill')

    // 幂等：再杀一次不报错，也不改写终态
    const again = await killBackgroundShell(store, id)
    assert(again.ok === true, 'second kill succeeds')
    assert(
      again.ok === true && again.alreadyTerminal === true,
      'second kill is a no-op',
    )
    assert(
      getBackgroundShell(store, id)?.status === 'killed',
      'status still killed after repeat kill',
    )

    // 未知 id
    const unknown = await killBackgroundShell(store, 'nope')
    assert(unknown.ok === false, 'killing an unknown id fails cleanly')
  }

  // ── 5) killAll 收尸 ──
  {
    const store = createBackgroundShellStore()
    const cmd = isWin ? 'ping -n 600 127.0.0.1 >nul' : 'sleep 600'
    const pids: number[] = []
    for (let i = 0; i < 2; i++) {
      const s = await spawnBackgroundShell({
        store,
        command: cmd,
        cwd,
        file: sh,
        args: shArgs(cmd),
        sessionId: 'sess_bg_5',
      })
      assert(s.ok === true, `spawn #${i} succeeds`)
      if (s.ok && s.record.pid !== undefined) pids.push(s.record.pid)
    }
    assert(pids.length === 2, 'two shells running')

    const killedCount = await killAllBackgroundShells(store)
    assert(killedCount === 2, `killAll reports 2, got ${killedCount}`)

    const allDead = await waitFor(
      () => pids.every((p) => !isProcessAlive(p)),
      15_000,
    )
    assert(allDead, 'no background process survives killAll')
    assert(
      listBackgroundShells(store).every((s) => s.status === 'killed'),
      'all records marked killed',
    )

    // 再次 killAll → 0
    assert((await killAllBackgroundShells(store)) === 0, 'killAll is idempotent')
  }

  // ── 6) 工具层契约 ──
  {
    const store = createBackgroundShellStore()
    const bash = createBashTool()
    const bashOutput = createBashOutputTool()
    const killShell = createKillShellTool()
    const ctx = {
      cwd,
      sessionId: 'sess_bg_tools',
      extras: { backgroundShellStore: store },
    }

    // 无 store → 明确失败
    const noStore = await bash.call(
      { command: 'echo x', run_in_background: true },
      { cwd, sessionId: 'sess_bg_tools' },
    )
    assert(noStore.ok === false, 'run_in_background without store fails')
    assert(noStore.errorCode === 'unavailable', 'unavailable error code')

    // 启动
    const started = await bash.call(
      { command: 'echo tool-bg-output', run_in_background: true },
      ctx,
    )
    assert(started.ok === true, 'Bash run_in_background succeeds')
    const ids = listBackgroundShells(store).map((s) => s.shellId)
    assert(ids.length === 1, 'tool registered one shell')
    const id = ids[0]!
    assert(started.output.includes(id), 'tool result reports the shell id')

    // BashOutput 未知 id
    const unknownOut = await bashOutput.call({ bash_id: 'nope' }, ctx)
    assert(unknownOut.ok === false, 'BashOutput rejects unknown id')
    assert(unknownOut.errorCode === 'not_found', 'not_found error code')

    // BashOutput 读到内容
    const sawOutput = await waitFor(async () => {
      const r = await bashOutput.call({ bash_id: id }, ctx)
      return r.ok === true && r.output.includes('tool-bg-output')
    })
    assert(sawOutput, 'BashOutput returns the command output')

    // KillShell 对已结束的 shell 是安全 no-op
    await waitFor(() => getBackgroundShell(store, id)?.status !== 'running')
    const killDone = await killShell.call({ shell_id: id }, ctx)
    assert(killDone.ok === true, 'KillShell on a finished shell succeeds')
    assert(
      /already exited/.test(killDone.output),
      'KillShell reports it had already exited',
    )

    // KillShell 未知 id
    const killUnknown = await killShell.call({ shell_id: 'nope' }, ctx)
    assert(killUnknown.ok === false, 'KillShell rejects unknown id')

    // 前台路径不受影响（回归）
    const fg = await bash.call({ command: 'echo foreground-ok' }, ctx)
    assert(fg.ok === true, 'foreground Bash still works')
    assert(fg.output.includes('foreground-ok'), 'foreground output unchanged')

    await killAllBackgroundShells(store)
  }

  // ── 7) 会话收尸：endSession 后不得有存活的后台进程 ──
  {
    const { createSession, endSession } = await import(
      '../packages/core/src/index.ts'
    )
    const session = await createSession({
      cwd,
      sessionId: 'sess_bg_teardown',
      systemPrompt: false,
      permissionMode: 'acceptEdits',
      model: 'mock-model',
    })
    assert(session.backgroundShells !== undefined, 'session has a shell store')

    const bash = createBashTool()
    const ctx = {
      cwd,
      sessionId: session.id,
      extras: { backgroundShellStore: session.backgroundShells },
    }
    const cmd = isWin ? 'ping -n 600 127.0.0.1 >nul' : 'sleep 600'
    const started = await bash.call({ command: cmd, run_in_background: true }, ctx)
    assert(started.ok === true, 'background shell started inside a session')

    const shells = listBackgroundShells(session.backgroundShells!)
    assert(shells.length === 1, 'session store holds the shell')
    const pid = shells[0]!.pid
    assert(typeof pid === 'number' && isProcessAlive(pid), 'shell alive pre-teardown')

    await endSession(session)

    const dead = await waitFor(() => !isProcessAlive(pid!), 15_000)
    assert(dead, 'endSession kills background shells (no zombies)')
    assert(
      listBackgroundShells(session.backgroundShells!).every(
        (s) => s.status === 'killed',
      ),
      'teardown marks shells killed',
    )
  }

  await fs.rm(cwd, { recursive: true, force: true })
  console.log('PASS: background shell runtime')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
