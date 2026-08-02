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
  /** ROB-3：上次会话遗留（进程未走 endSession 就退出时 resume 投影） */
  'interrupted',
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
 * ROB-3：resume 投影——上次会话遗留的 running 任务标记为 interrupted。
 * 进程是否还活着无法跨进程证明，因此不宣称 killed/completed；对已终态是 no-op。
 */
export function markShellInterrupted(
  record: BackgroundShellRecord,
  opts: { endedAt: string },
): BackgroundShellRecord {
  if (isTerminalShellStatus(record.status)) return record
  return {
    ...record,
    status: 'interrupted',
    endedAt: opts.endedAt,
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
  const leftover = record.status === 'interrupted' ? ' [leftover]' : ''
  const label = record.description?.trim() || record.command
  return `${record.shellId} ${record.status}${code}${sizeNote}${leftover} · ${label}`
}

/**
 * ROB-3：manifest 序列化（会话保存点落盘，供崩溃/重启后恢复提醒）。
 * 只保留可恢复字段，不序列化运行时句柄。
 */
export function serializeBackgroundShellManifest(
  store: BackgroundShellStore,
): string {
  return JSON.stringify({
    order: store.order,
    shells: store.shells,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSafeShellId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

/**
 * ROB-3：manifest 反序列化（fail-closed）。
 * 任何字段不合法都整体返回 undefined，不投影部分记录。
 */
export function parseBackgroundShellManifest(
  text: string,
): BackgroundShellStore | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.order)) return undefined
  if (!isRecord(parsed.shells)) return undefined
  const shells: Record<string, BackgroundShellRecord> = {}
  for (const id of parsed.order) {
    if (!isSafeShellId(id)) return undefined
    const raw = parsed.shells[id]
    if (!isRecord(raw)) return undefined
    if (!isSafeShellId(raw.shellId) || raw.shellId !== id) return undefined
    if (typeof raw.command !== 'string' || !raw.command) return undefined
    if (typeof raw.status !== 'string') return undefined
    if (!BACKGROUND_SHELL_STATUSES.includes(raw.status as BackgroundShellStatus)) {
      return undefined
    }
    if (typeof raw.outputPath !== 'string' || !raw.outputPath) return undefined
    if (typeof raw.startedAt !== 'string' || !raw.startedAt) return undefined
    if (typeof raw.readOffset !== 'number' || !Number.isFinite(raw.readOffset)) {
      return undefined
    }
    if (typeof raw.bytesWritten !== 'number' || !Number.isFinite(raw.bytesWritten)) {
      return undefined
    }
    const record: BackgroundShellRecord = {
      shellId: raw.shellId,
      command: raw.command,
      status: raw.status as BackgroundShellStatus,
      outputPath: raw.outputPath,
      startedAt: raw.startedAt,
      readOffset: Math.max(0, Math.floor(raw.readOffset)),
      bytesWritten: Math.max(0, Math.floor(raw.bytesWritten)),
      ...(typeof raw.description === 'string' && raw.description
        ? { description: raw.description }
        : {}),
      ...(typeof raw.pid === 'number' && Number.isFinite(raw.pid)
        ? { pid: raw.pid }
        : {}),
      ...(typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode)
        ? { exitCode: raw.exitCode }
        : {}),
      ...(typeof raw.endedAt === 'string' && raw.endedAt
        ? { endedAt: raw.endedAt }
        : {}),
      ...(typeof raw.killedForSize === 'boolean'
        ? { killedForSize: raw.killedForSize }
        : {}),
    }
    shells[id] = record
  }
  const order = parsed.order.filter(
    (id): id is string => isSafeShellId(id) && Boolean(shells[id]),
  )
  return { order, shells }
}
