/**
 * AR-T2 回归：后台 shell 落盘流出错不得拖垮整个进程
 *
 * 背景：后台 shell 的输出写进 .bolo-tmp 下的日志文件。若该流 emit 'error'
 * （磁盘满 ENOSPC，或 kill 后排空窗口里的 write-after-end），而没有 'error'
 * 监听器，Node 会抛未捕获异常。本仓库**没有任何** process 级兜底
 * （uncaughtException / unhandledRejection 命中数为 0），所以那等于：
 * 前台会话、其它后台 shell、未落盘的在途 turn 一起死。
 *
 * 契约：一个后台作业自身的 I/O 失败只降级该作业，监督者存活。
 *
 * 运行：npx tsx scripts/test-bash-background-stream-error.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _getShellOutputStreamForTest,
  isProcessAlive,
  killAllBackgroundShells,
  spawnBackgroundShell,
} from '../packages/tools/src/index.ts'
import {
  createBackgroundShellStore,
  getBackgroundShell,
  isTerminalShellStatus,
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
const LONG = isWin ? 'ping -n 600 127.0.0.1 >nul' : 'sleep 600'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

async function main() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-bgerr-'))

  // 若本测试因未捕获异常挂掉，说明回归重现——给出可读诊断而不是裸栈
  let sawUncaught = false
  process.on('uncaughtException', (e) => {
    sawUncaught = true
    console.error('FAIL: stream error escaped as an uncaught exception:', e)
    process.exit(1)
  })

  const store = createBackgroundShellStore()

  // 受害者：一个与出错 shell 无关的后台作业，必须毫发无伤
  const bystander = await spawnBackgroundShell({
    store,
    command: LONG,
    cwd,
    file: sh,
    args: shArgs(LONG),
    sessionId: 'sess_bgerr',
  })
  assert(bystander.ok === true, 'bystander shell spawned')
  if (!bystander.ok) return

  // 目标：注入真实的流错误
  const victim = await spawnBackgroundShell({
    store,
    command: LONG,
    cwd,
    file: sh,
    args: shArgs(LONG),
    sessionId: 'sess_bgerr',
  })
  assert(victim.ok === true, 'victim shell spawned')
  if (!victim.ok) return

  const victimId = victim.record.shellId
  const victimPid = victim.record.pid
  assert(typeof victimPid === 'number', 'victim pid captured')
  assert(isProcessAlive(victimPid!), 'victim process alive before injection')

  const stream = _getShellOutputStreamForTest(store, victimId)
  assert(stream !== undefined, 'victim output stream reachable for injection')

  // 真实 I/O 失败（等价于 ENOSPC 一类的写入失败）
  stream!.destroy(new Error('ENOSPC: simulated disk full'))

  // 事件循环转几圈，让 'error' 有机会派发
  await sleep(300)

  assert(!sawUncaught, 'no uncaught exception escaped')

  // ── 降级语义：出错的作业进终态，且不是「正常完成」 ──
  const reachedTerminal = await waitFor(() => {
    const rec = getBackgroundShell(store, victimId)
    return rec !== undefined && isTerminalShellStatus(rec.status)
  })
  assert(reachedTerminal, 'victim shell reaches a terminal state after I/O failure')
  const victimRec = getBackgroundShell(store, victimId)!
  assert(
    victimRec.status === 'failed',
    `I/O failure must not look like success, got ${victimRec.status}`,
  )
  assert(victimRec.endedAt !== undefined, 'victim end time recorded')

  // 关键：只标终态不杀进程就是孤儿 —— 输出已无人接收，而 KillShell 见终态会
  // no-op，这个进程将再也杀不掉。sink 失败必须连带收进程树。
  const victimReaped = await waitFor(() => !isProcessAlive(victimPid!), 15_000)
  assert(
    victimReaped,
    'sink failure must also reap the process, not orphan it',
  )

  // ── 隔离语义：监督者与旁观作业存活 ──
  const bystanderRec = getBackgroundShell(store, bystander.record.shellId)!
  assert(
    bystanderRec.status === 'running',
    `bystander must be unaffected, got ${bystanderRec.status}`,
  )
  assert(
    typeof bystanderRec.pid === 'number' && isProcessAlive(bystanderRec.pid),
    'bystander process still alive',
  )

  // ── 幂等：再次注入错误不得改写已定终态 ──
  const before = JSON.stringify(getBackgroundShell(store, victimId))
  stream!.emit('error', new Error('second failure'))
  await sleep(150)
  assert(!sawUncaught, 'repeat stream error still contained')
  assert(
    JSON.stringify(getBackgroundShell(store, victimId)) === before,
    'terminal record not rewritten by a second stream error',
  )

  // ── 收尾仍然可用 ──
  await killAllBackgroundShells(store)
  const allDead = await waitFor(
    () =>
      [bystanderRec.pid!].every((p) => !isProcessAlive(p)),
    15_000,
  )
  assert(allDead, 'teardown still works after a stream failure')

  // Windows 上刚被杀的进程可能仍短暂持有日志句柄；临时目录清理失败不影响结论
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: background shell stream error containment')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
