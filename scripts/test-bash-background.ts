/**
 * AR-T2a：后台 shell 纯契约
 * - 记录状态机：running → completed | failed | killed（terminal 幂等）
 * - 增量读游标：不重不漏、越界安全
 * - 输出体积熔断阈值
 * - 注册表增删查
 *
 * 运行：npx tsx scripts/test-bash-background.ts
 */
import {
  BACKGROUND_SHELL_STATUSES,
  DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES,
  advanceShellReadOffset,
  applyShellExit,
  createBackgroundShellRecord,
  createBackgroundShellStore,
  formatBackgroundShellStatusLine,
  getBackgroundShell,
  isTerminalShellStatus,
  listBackgroundShells,
  markShellKilled,
  registerBackgroundShell,
  shouldKillForOutputSize,
  type BackgroundShellRecord,
} from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function rec(overrides?: Partial<BackgroundShellRecord>): BackgroundShellRecord {
  return {
    ...createBackgroundShellRecord({
      shellId: 'sh_1',
      command: 'npm run dev',
      outputPath: '/tmp/sh_1.log',
      startedAt: '2026-07-26T00:00:00.000Z',
    }),
    ...overrides,
  }
}

async function main() {
  // ── 1) 状态枚举 ──
  assert(BACKGROUND_SHELL_STATUSES.length === 4, 'four shell statuses')
  assert(isTerminalShellStatus('running') === false, 'running is not terminal')
  assert(isTerminalShellStatus('completed') === true, 'completed is terminal')
  assert(isTerminalShellStatus('failed') === true, 'failed is terminal')
  assert(isTerminalShellStatus('killed') === true, 'killed is terminal')

  // ── 2) 初始记录 ──
  const fresh = rec()
  assert(fresh.status === 'running', 'new record starts running')
  assert(fresh.readOffset === 0, 'read cursor starts at 0')
  assert(fresh.bytesWritten === 0, 'byte counter starts at 0')
  assert(fresh.endedAt === undefined, 'no end time while running')
  assert(fresh.command === 'npm run dev', 'command retained')

  // ── 3) 退出：code 0 → completed，非 0 → failed ──
  const okExit = applyShellExit(fresh, { code: 0, endedAt: 'T1' })
  assert(okExit.status === 'completed', 'exit 0 → completed')
  assert(okExit.exitCode === 0, 'exit code recorded')
  assert(okExit.endedAt === 'T1', 'end time recorded')
  assert(fresh.status === 'running', 'applyShellExit does not mutate input')

  const badExit = applyShellExit(fresh, { code: 1, endedAt: 'T1' })
  assert(badExit.status === 'failed', 'non-zero exit → failed')
  assert(badExit.exitCode === 1, 'non-zero code recorded')

  const nullExit = applyShellExit(fresh, { code: null, endedAt: 'T1' })
  assert(nullExit.status === 'failed', 'null exit code → failed')

  // ── 4) terminal 幂等：已结束的记录不被后续事件改写 ──
  const afterKill = markShellKilled(fresh, { endedAt: 'T1' })
  assert(afterKill.status === 'killed', 'kill marks killed')
  const reExit = applyShellExit(afterKill, { code: 0, endedAt: 'T2' })
  assert(reExit.status === 'killed', 'exit after kill keeps killed')
  assert(reExit.endedAt === 'T1', 'terminal end time not overwritten')
  const reKill = markShellKilled(afterKill, { endedAt: 'T2' })
  assert(reKill.status === 'killed', 'kill is idempotent')
  assert(reKill.endedAt === 'T1', 'repeated kill keeps original end time')

  const completed = applyShellExit(fresh, { code: 0, endedAt: 'T1' })
  const killAfterDone = markShellKilled(completed, { endedAt: 'T2' })
  assert(
    killAfterDone.status === 'completed',
    'killing an already-completed shell is a no-op',
  )

  // ── 5) 因体积被杀：保留标记 ──
  const sizeKilled = markShellKilled(fresh, { endedAt: 'T1', forSize: true })
  assert(sizeKilled.killedForSize === true, 'size-kill flagged')
  assert(sizeKilled.status === 'killed', 'size-kill marks killed')

  // ── 6) 读游标：不重不漏 ──
  const withOutput = { ...fresh, bytesWritten: 100 }
  const read1 = advanceShellReadOffset(withOutput, 40)
  assert(read1.readOffset === 40, 'cursor advances by bytes read')
  const read2 = advanceShellReadOffset(read1, 60)
  assert(read2.readOffset === 100, 'cursor accumulates')
  assert(withOutput.readOffset === 0, 'advance does not mutate input')

  // 越界与负数安全
  assert(
    advanceShellReadOffset(withOutput, -5).readOffset === 0,
    'negative read is clamped',
  )
  assert(
    advanceShellReadOffset(withOutput, 999).readOffset === 999,
    'cursor may pass bytesWritten (file grew between stat and read)',
  )
  assert(
    advanceShellReadOffset(withOutput, 0).readOffset === 0,
    'zero-byte read leaves cursor put',
  )

  // ── 7) 体积熔断 ──
  assert(
    DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES > 0,
    'output cap configured',
  )
  assert(
    shouldKillForOutputSize({ ...fresh, bytesWritten: 10 }, 100) === false,
    'under cap → keep running',
  )
  assert(
    shouldKillForOutputSize({ ...fresh, bytesWritten: 100 }, 100) === true,
    'at cap → kill',
  )
  assert(
    shouldKillForOutputSize({ ...fresh, bytesWritten: 500 }, 100) === true,
    'over cap → kill',
  )
  assert(
    shouldKillForOutputSize(
      { ...completed, bytesWritten: 500 },
      100,
    ) === false,
    'already-terminal shell is never re-killed for size',
  )

  // ── 8) 注册表 ──
  const store = createBackgroundShellStore()
  assert(listBackgroundShells(store).length === 0, 'store starts empty')
  registerBackgroundShell(store, fresh)
  assert(listBackgroundShells(store).length === 1, 'shell registered')
  assert(getBackgroundShell(store, 'sh_1')?.command === 'npm run dev', 'lookup by id')
  assert(getBackgroundShell(store, 'nope') === undefined, 'unknown id → undefined')

  registerBackgroundShell(store, rec({ shellId: 'sh_2', command: 'tail -f log' }))
  assert(listBackgroundShells(store).length === 2, 'second shell registered')
  // 列表按注册序稳定，便于 UI 与 /bg 输出可预测
  assert(
    listBackgroundShells(store).map((s) => s.shellId).join(',') === 'sh_1,sh_2',
    'listing is registration-ordered',
  )

  // ── 9) 状态行文案 ──
  const line = formatBackgroundShellStatusLine(fresh)
  assert(line.includes('sh_1'), 'status line shows id')
  assert(line.includes('running'), 'status line shows status')
  const doneLine = formatBackgroundShellStatusLine(
    applyShellExit(fresh, { code: 3, endedAt: 'T1' }),
  )
  assert(doneLine.includes('failed'), 'status line shows failed')
  assert(doneLine.includes('3'), 'status line shows exit code')

  console.log('PASS: background shell contract')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
