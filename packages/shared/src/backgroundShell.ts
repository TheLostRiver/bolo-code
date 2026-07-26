/**
 * AR-T2：后台 shell 纯契约
 *
 * 借鉴语义（不抄实现）：参考实现把后台命令的输出**落盘**，用字节偏移做增量读，
 * 状态机只允许 running → terminal 一次跃迁，并对「输出把磁盘写爆」设体积熔断。
 * 本文件只放**纯数据与纯函数**；真正的进程 spawn / kill 在 tools 侧。
 *
 * 状态取 4 档：running | completed | failed | killed。
 * 参考实现另有 `backgrounded` 中间态，那是给「前台命令中途转后台」用的；
 * Bolo 本轮只支持显式 run_in_background，不需要该中间态。
 */

export const BACKGROUND_SHELL_STATUSES = [
  'running',
  'completed',
  'failed',
  'killed',
] as const

export type BackgroundShellStatus = (typeof BACKGROUND_SHELL_STATUSES)[number]

export type BackgroundShellRecord = {
  shellId: string
  command: string
  /** 可选人类描述，用于状态行 */
  description?: string
  status: BackgroundShellStatus
  /** 进程组/进程 id；kill 时用 */
  pid?: number
  /** 退出码；被信号杀死时可能为 null → 记为 failed/killed */
  exitCode?: number
  startedAt: string
  endedAt?: string
  /** 输出落盘路径 */
  outputPath: string
  /** 已被 BashOutput 读走的字节偏移 */
  readOffset: number
  /** 累计写入字节；体积熔断与「还有多少没读」都看它 */
  bytesWritten: number
  /** 因输出超限被杀（与用户主动 kill 区分） */
  killedForSize?: boolean
}

/** 默认输出上限：超过即熔断杀进程，避免死循环 append 打满磁盘 */
export const DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES = 64 * 1024 * 1024

export function isTerminalShellStatus(
  status: BackgroundShellStatus,
): boolean {
  return status !== 'running'
}

export function createBackgroundShellRecord(opts: {
  shellId: string
  command: string
  outputPath: string
  startedAt: string
  description?: string
  pid?: number
}): BackgroundShellRecord {
  return {
    shellId: opts.shellId,
    command: opts.command,
    status: 'running',
    startedAt: opts.startedAt,
    outputPath: opts.outputPath,
    readOffset: 0,
    bytesWritten: 0,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.pid === undefined ? {} : { pid: opts.pid }),
  }
}

/**
 * 进程退出。terminal 记录不被改写——先到的终态是权威的：
 * kill 之后进程自然退出会再触发一次 exit，那次必须被忽略，
 * 否则「用户杀掉的」会被记成「正常完成」。
 */
export function applyShellExit(
  record: BackgroundShellRecord,
  opts: { code: number | null; endedAt: string },
): BackgroundShellRecord {
  if (isTerminalShellStatus(record.status)) return record
  const code = typeof opts.code === 'number' ? opts.code : undefined
  return {
    ...record,
    status: code === 0 ? 'completed' : 'failed',
    ...(code === undefined ? {} : { exitCode: code }),
    endedAt: opts.endedAt,
  }
}

/** 主动 kill；对已终态记录是 no-op（幂等） */
export function markShellKilled(
  record: BackgroundShellRecord,
  opts: { endedAt: string; forSize?: boolean },
): BackgroundShellRecord {
  if (isTerminalShellStatus(record.status)) return record
  return {
    ...record,
    status: 'killed',
    endedAt: opts.endedAt,
    ...(opts.forSize ? { killedForSize: true } : {}),
  }
}

/**
 * 推进读游标。
 * 允许越过 bytesWritten：stat 与 read 之间文件可能又长了，
 * 以实际读到的字节为准才不会漏读。
 */
export function advanceShellReadOffset(
  record: BackgroundShellRecord,
  bytesRead: number,
): BackgroundShellRecord {
  const delta =
    Number.isFinite(bytesRead) && bytesRead > 0 ? Math.floor(bytesRead) : 0
  if (delta === 0) return { ...record }
  return { ...record, readOffset: record.readOffset + delta }
}

export function shouldKillForOutputSize(
  record: BackgroundShellRecord,
  capBytes: number = DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES,
): boolean {
  if (isTerminalShellStatus(record.status)) return false
  return record.bytesWritten >= capBytes
}

export type BackgroundShellStore = {
  /** 注册序保持稳定，UI 与 /bg 输出可预测 */
  order: string[]
  shells: Record<string, BackgroundShellRecord>
}

export function createBackgroundShellStore(): BackgroundShellStore {
  return { order: [], shells: {} }
}

export function registerBackgroundShell(
  store: BackgroundShellStore,
  record: BackgroundShellRecord,
): void {
  if (!store.shells[record.shellId]) store.order.push(record.shellId)
  store.shells[record.shellId] = record
}

export function getBackgroundShell(
  store: BackgroundShellStore,
  shellId: string,
): BackgroundShellRecord | undefined {
  return store.shells[shellId]
}

export function listBackgroundShells(
  store: BackgroundShellStore,
): BackgroundShellRecord[] {
  const out: BackgroundShellRecord[] = []
  for (const id of store.order) {
    const rec = store.shells[id]
    if (rec) out.push(rec)
  }
  return out
}

/** `sh_1 running · npm run dev` / `sh_1 failed (3) · npm run dev` */
export function formatBackgroundShellStatusLine(
  record: BackgroundShellRecord,
): string {
  const code =
    record.status === 'failed' || record.status === 'completed'
      ? record.exitCode !== undefined
        ? ` (${record.exitCode})`
        : ''
      : ''
  const sizeNote = record.killedForSize ? ' [output cap exceeded]' : ''
  const label = record.description?.trim() || record.command
  return `${record.shellId} ${record.status}${code}${sizeNote} · ${label}`
}
