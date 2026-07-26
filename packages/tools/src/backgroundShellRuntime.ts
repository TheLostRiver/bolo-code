/**
 * AR-T2：后台 shell 运行时（spawn / 落盘 / 增量读 / 进程树 kill）
 *
 * 三条硬约束：
 * 1. **零运行时依赖** —— 不引入 tree-kill 之流。进程树用原生手段收：
 *      POSIX  spawn detached → 独立进程组 → kill(-pid) 两级升级
 *      Windows taskkill /T /F
 *    （与 codex `process_group(0)` + terminate→kill 升级同构）
 * 2. **输出落盘不驻内存** —— 长跑命令的 stdout 可能是 GB 级；只记字节数与偏移，
 *    读取时按游标切片。超过体积上限熔断杀进程，避免打满磁盘。
 * 3. **不被单轮 abort 杀掉** —— 后台进程的意义就是跨 turn 存活；
 *    只在 session 结束 / 显式 kill / 进程退出时收尸。
 */

import { spawn, execFile } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  advanceShellReadOffset,
  applyShellExit,
  createBackgroundShellRecord,
  getBackgroundShell,
  isTerminalShellStatus,
  listBackgroundShells,
  markShellKilled,
  registerBackgroundShell,
  shouldKillForOutputSize,
  DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES,
  type BackgroundShellRecord,
  type BackgroundShellStore,
} from '../../shared/src/index.ts'

/** 单次 BashOutput 读取上限，防止一次把整个 log 灌进模型 */
export const MAX_SHELL_OUTPUT_READ_BYTES = 200_000

/** 进程组 SIGTERM 之后等多久升级 SIGKILL */
const KILL_ESCALATION_MS = 2_000

type ShellRuntime = {
  pid?: number
  /** 进程是否已经退出（避免对已回收 pid 发信号） */
  exited: boolean
  stream?: WriteStream
  /** spawn 时的沙箱临时文件清理器；进程退出后才可调用 */
  cleanup?: () => Promise<void>
}

/**
 * 运行时句柄不放进纯数据 store（store 要能被序列化/投影），
 * 用 WeakMap 按 store 分桶，与 subagent 的 queue runtime 同一手法。
 */
const runtimes = new WeakMap<
  BackgroundShellStore,
  Map<string, ShellRuntime>
>()

function runtimeMap(store: BackgroundShellStore): Map<string, ShellRuntime> {
  let m = runtimes.get(store)
  if (!m) {
    m = new Map()
    runtimes.set(store, m)
  }
  return m
}

export function resolveShellOutputDir(cwd: string, sessionId?: string): string {
  return path.join(
    cwd,
    '.bolo-tmp',
    'shells',
    sessionId && sessionId.trim() ? sessionId.trim() : 'default',
  )
}

let shellSeq = 0
function nextShellId(): string {
  shellSeq += 1
  return `bash_${Date.now().toString(36)}_${shellSeq}`
}

export type SpawnBackgroundShellOptions = {
  store: BackgroundShellStore
  command: string
  cwd: string
  file: string
  args: string[]
  sessionId?: string
  description?: string
  env?: NodeJS.ProcessEnv
  outputCapBytes?: number
  cleanup?: () => Promise<void>
  /** 进程退出/被杀后回调（供 core 落盘或发事件） */
  onExit?: (record: BackgroundShellRecord) => void
}

export type SpawnBackgroundShellResult =
  | { ok: true; record: BackgroundShellRecord }
  | { ok: false; error: string }

/**
 * 启动后台进程。返回后立刻可用，不等待退出。
 */
export async function spawnBackgroundShell(
  opts: SpawnBackgroundShellOptions,
): Promise<SpawnBackgroundShellResult> {
  const shellId = nextShellId()
  const outDir = resolveShellOutputDir(opts.cwd, opts.sessionId)
  const outputPath = path.join(outDir, `${shellId}.log`)
  const cap = opts.outputCapBytes ?? DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES

  try {
    await fs.mkdir(outDir, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      error: `cannot create background shell output dir: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }

  let stream: WriteStream
  try {
    stream = createWriteStream(outputPath, { flags: 'a' })
  } catch (e) {
    return {
      ok: false,
      error: `cannot open background shell log: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(opts.file, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      // POSIX：独立进程组，kill(-pid) 才能收整棵树
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    stream.end()
    return {
      ok: false,
      error: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const record = createBackgroundShellRecord({
    shellId,
    command: opts.command,
    outputPath,
    startedAt: new Date().toISOString(),
    ...(opts.description ? { description: opts.description } : {}),
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  })
  registerBackgroundShell(opts.store, record)

  const rt: ShellRuntime = {
    exited: false,
    stream,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    ...(opts.cleanup ? { cleanup: opts.cleanup } : {}),
  }
  runtimeMap(opts.store).set(shellId, rt)

  const bump = (chunk: Buffer | string) => {
    const len = Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(String(chunk))
    const cur = getBackgroundShell(opts.store, shellId)
    if (!cur) return
    const next = { ...cur, bytesWritten: cur.bytesWritten + len }
    registerBackgroundShell(opts.store, next)
    if (shouldKillForOutputSize(next, cap)) {
      void killBackgroundShell(opts.store, shellId, { forSize: true })
    }
  }

  // rt.exited 之后流已经 end；kill→SIGKILL 的排空窗口里仍会来 late data，
  // 不守卫就是 write-after-end。
  const sink = (c: Buffer) => {
    if (rt.exited) return
    bump(c)
    stream.write(c)
  }
  child.stdout?.on('data', sink)
  child.stderr?.on('data', sink)

  const finish = (code: number | null) => {
    if (rt.exited) return
    rt.exited = true
    try {
      stream.end()
    } catch {
      /* ignore */
    }
    const cur = getBackgroundShell(opts.store, shellId)
    if (cur) {
      const next = applyShellExit(cur, {
        code,
        endedAt: new Date().toISOString(),
      })
      registerBackgroundShell(opts.store, next)
      opts.onExit?.(next)
    }
    void rt.cleanup?.().catch(() => {})
  }

  /**
   * 落盘 sink 失败（ENOSPC / write-after-end / 句柄被回收）。
   *
   * 两件事都必须做，只做一件都是 bug：
   * 1. 接住 'error'。没有监听器它就是未捕获异常，而全仓没有 process 级兜底 ——
   *    那等于杀掉整个会话、其它后台 shell 与未落盘的在途 turn。
   * 2. 连带杀掉进程。只标终态不杀进程会留下孤儿：输出已经没人接，
   *    而 killBackgroundShell 见到终态会 no-op，于是这个进程再也杀不掉。
   *
   * 顺序：先 finish 定终态（status=failed，表明是 I/O 故障而非用户 kill），
   * 再按捕获的 pid 收进程树。
   */
  const failOnSinkError = () => {
    if (rt.exited) return
    const pid = rt.pid
    finish(null)
    if (pid !== undefined) void killProcessTree(pid).catch(() => {})
  }

  // 挂在 finish 定义之后：createWriteStream 到这里没有 await，
  // 流的异步 error 只可能在监听器就位后触发，不存在预注册窗口。
  stream.on('error', failOnSinkError)

  child.on('error', () => finish(null))
  child.on('exit', (code) => finish(code))

  // detached 进程默认会让 Node 等它；不 unref 的话 CLI 退不出去
  if (process.platform !== 'win32') child.unref()

  return { ok: true, record }
}

/** 原生进程树 kill：POSIX 杀进程组并两级升级；Windows 用 taskkill /T /F */
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => resolve(),
      )
    })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }
  }
  await new Promise((r) => setTimeout(r, KILL_ESCALATION_MS))
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
}

export type KillBackgroundShellResult =
  | { ok: true; record: BackgroundShellRecord; alreadyTerminal: boolean }
  | { ok: false; error: string }

/** 杀掉后台 shell。对已终态记录是幂等 no-op。 */
export async function killBackgroundShell(
  store: BackgroundShellStore,
  shellId: string,
  opts?: { forSize?: boolean },
): Promise<KillBackgroundShellResult> {
  const cur = getBackgroundShell(store, shellId)
  if (!cur) return { ok: false, error: `unknown shell id: ${shellId}` }
  if (isTerminalShellStatus(cur.status)) {
    return { ok: true, record: cur, alreadyTerminal: true }
  }

  const rt = runtimeMap(store).get(shellId)
  const next = markShellKilled(cur, {
    endedAt: new Date().toISOString(),
    ...(opts?.forSize ? { forSize: true } : {}),
  })
  registerBackgroundShell(store, next)

  if (rt && !rt.exited && rt.pid !== undefined) {
    await killProcessTree(rt.pid)
  }
  if (rt) {
    rt.exited = true
    try {
      rt.stream?.end()
    } catch {
      /* ignore */
    }
    void rt.cleanup?.().catch(() => {})
  }
  return { ok: true, record: next, alreadyTerminal: false }
}

/**
 * 收尸：杀掉本 store 里所有还在跑的 shell。
 * 由 SessionEnd 与 process exit 调用 —— 后台进程绝不能活过启动它的会话。
 */
export async function killAllBackgroundShells(
  store: BackgroundShellStore,
): Promise<number> {
  let killed = 0
  for (const rec of listBackgroundShells(store)) {
    if (isTerminalShellStatus(rec.status)) continue
    const r = await killBackgroundShell(store, rec.shellId)
    if (r.ok && !r.alreadyTerminal) killed += 1
  }
  return killed
}

export type ReadShellOutputResult =
  | {
      ok: true
      record: BackgroundShellRecord
      content: string
      bytesRead: number
      /** 读完这次之后是否还有剩余（文件在读期间又长了也算） */
      hasMore: boolean
    }
  | { ok: false; error: string }

/**
 * 从上次游标读增量。读到的字节数推进游标，保证不重不漏。
 */
export async function readBackgroundShellOutput(
  store: BackgroundShellStore,
  shellId: string,
  opts?: { maxBytes?: number },
): Promise<ReadShellOutputResult> {
  const cur = getBackgroundShell(store, shellId)
  if (!cur) return { ok: false, error: `unknown shell id: ${shellId}` }

  const maxBytes = Math.max(
    1,
    Math.min(opts?.maxBytes ?? MAX_SHELL_OUTPUT_READ_BYTES, MAX_SHELL_OUTPUT_READ_BYTES),
  )

  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(cur.outputPath, 'r')
    const stat = await handle.stat()
    const available = Math.max(0, stat.size - cur.readOffset)
    if (available === 0) {
      return {
        ok: true,
        record: cur,
        content: '',
        bytesRead: 0,
        hasMore: false,
      }
    }
    const toRead = Math.min(available, maxBytes)
    const buf = Buffer.alloc(toRead)
    const { bytesRead } = await handle.read(buf, 0, toRead, cur.readOffset)
    const next = advanceShellReadOffset(cur, bytesRead)
    registerBackgroundShell(store, next)
    return {
      ok: true,
      record: next,
      content: buf.subarray(0, bytesRead).toString('utf8'),
      bytesRead,
      hasMore: available > bytesRead,
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      // 日志还没落地（进程刚起）或已被清理
      return { ok: true, record: cur, content: '', bytesRead: 0, hasMore: false }
    }
    return {
      ok: false,
      error: `cannot read shell output: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** 删除本 session 的 shell 日志目录（SessionEnd 之后调用） */
export async function cleanupShellOutputDir(
  cwd: string,
  sessionId?: string,
): Promise<void> {
  const dir = resolveShellOutputDir(cwd, sessionId)
  // 只删我们自己造的目录，且必须在 .bolo-tmp 之下
  if (!dir.includes(`${path.sep}.bolo-tmp${path.sep}`)) return
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/**
 * 测试用：拿到某个 shell 的落盘流，用来注入真实的 I/O 失败。
 * 产品代码不得使用——运行时句柄故意不放进纯数据 store。
 */
export function _getShellOutputStreamForTest(
  store: BackgroundShellStore,
  shellId: string,
): WriteStream | undefined {
  return runtimeMap(store).get(shellId)?.stream
}

/** 测试用：确认某 pid 是否还活着 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
