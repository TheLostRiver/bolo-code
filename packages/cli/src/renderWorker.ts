/**
 * REN-3 · 子进程隔离渲染不可信内容
 *
 * 渲染 worker 子命令（self re-exec）+ 墙钟超时 kill + 结果回传；
 * 失败时主进程降级（原样输出/提示），不因渲染 panic 退出。
 *
 * 协议（stdin/stdout 单行 JSON）：
 *   输入  {"text": string, "mode": "terminal"|"markdown", "width": number}
 *   输出  {"ok": true, "lines": string[]}
 *         {"ok": false, "error": string}
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrapTerminalText } from './tui/terminalText.ts'

export type RenderWorkerRequest = {
  text: string
  mode: 'terminal' | 'markdown'
  width: number
}

export type RenderWorkerResult =
  | { ok: true; lines: string[] }
  | { ok: false; error: string }

/** 墙钟超时（毫秒）：worker 超时 kill，主进程降级 */
export const RENDER_WORKER_TIMEOUT_MS = 2_000
/** kill 后宽限（毫秒）：SIGTERM 未退再 SIGKILL */
export const RENDER_WORKER_KILL_GRACE_MS = 500

/** worker 进程主逻辑：读 stdin JSON → 渲染 → stdout JSON */
export async function runRenderWorker(): Promise<void> {
  let raw = ''
  for await (const chunk of process.stdin) {
    raw += chunk
    // 有界：超大输入拒绝（防恶意输入拖垮 worker）
    if (raw.length > 2_000_000) {
      respond({ ok: false, error: 'render worker input too large' })
      return
    }
  }
  let req: RenderWorkerRequest
  try {
    req = JSON.parse(raw) as RenderWorkerRequest
  } catch {
    respond({ ok: false, error: 'render worker: invalid JSON input' })
    return
  }
  if (typeof req.text !== 'string' || typeof req.width !== 'number') {
    respond({ ok: false, error: 'render worker: malformed request' })
    return
  }
  try {
    const width = Math.max(1, Math.floor(req.width))
    const lines =
      req.mode === 'markdown'
        ? renderMarkdownLines(req.text, width)
        : wrapTerminalText(req.text, width)
    respond({ ok: true, lines })
  } catch (err) {
    respond({
      ok: false,
      error: `render worker failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    })
  }
}

/** markdown 简易渲染（纯文本降级——行折叠；与主进程 markdown 渲染等价性见测试） */
function renderMarkdownLines(text: string, width: number): string[] {
  return wrapTerminalText(text, width)
}

function respond(result: RenderWorkerResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

/** 主进程调用方：spawn worker → 超时 kill → 结果回传；失败降级原样直出 */
export async function renderTextInWorker(
  request: RenderWorkerRequest,
  opts?: { timeoutMs?: number; command?: string[] },
): Promise<RenderWorkerResult> {
  const timeoutMs = opts?.timeoutMs ?? RENDER_WORKER_TIMEOUT_MS
  const command = opts?.command ?? defaultWorkerCommand()
  return new Promise<RenderWorkerResult>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    let settled = false
    const finish = (result: RenderWorkerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      child.kill('SIGKILL')
      resolve(result)
    }
    const timer = setTimeout(() => {
      // 超时：kill（SIGTERM → SIGKILL 宽限）→ 降级
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), RENDER_WORKER_KILL_GRACE_MS)
      finish({ ok: false, error: 'render worker timed out' })
    }, timeoutMs)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', (e) => {
      finish({ ok: false, error: `render worker spawn failed: ${e.message}` })
    })
    // EPIPE/EOF：worker 提前退出时 stdin 写失败无害（exit 分支已处理结果）
    child.stdin.on('error', () => {})
    child.on('exit', (code) => {
      if (settled) return
      const line = out.trim().split('\n').filter(Boolean).at(-1)
      if (line) {
        try {
          const parsed = JSON.parse(line) as RenderWorkerResult
          finish(parsed)
          return
        } catch {
          /* 非 JSON → 降级 */
        }
      }
      finish({
        ok: false,
        error: `render worker exited (${code ?? 'signal'}): ${err.trim().slice(0, 200) || 'no output'}`,
      })
    })
    child.stdin.end(JSON.stringify(request))
  })
}

/** 默认 worker 命令：当前进程同入口（dev=tsx main.ts；dist=bolo.mjs） */
function defaultWorkerCommand(): string[] {
  const entry = process.argv[1]
  if (entry) {
    // dev（tsx）下入口是 main.ts——需要 tsx loader；dist 下是单文件可执行
    const isTs = entry.endsWith('.ts')
    if (isTs) {
      const tsxCli = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../node_modules/tsx/dist/cli.mjs',
      )
      // 轻量独立入口（renderWorkerCli.ts）——避免加载 main.ts 全树
      const workerEntry = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        './renderWorkerCli.ts',
      )
      return [process.execPath, tsxCli, workerEntry]
    }
    return [process.execPath, entry, 'render-worker']
  }
  throw new Error('render worker: no entry point (argv[1] empty)')
}
