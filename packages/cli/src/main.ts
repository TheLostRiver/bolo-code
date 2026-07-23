/**
 * bolo CLI 入口
 */
import { formatHelp, isResumePicker, parseArgs } from './parseArgs.ts'
import { runNewSessionCli } from './newSessionCli.ts'
import {
  resolveContinueSessionId,
  ResumePickerError,
  runResumeCli,
} from './resumeCli.ts'

/**
 * 非 TTY 时尝试读 stdin。
 * 若在 idle 内无数据则放弃（避免宿主把 stdin 当成 pipe 却永不 end 而挂死）。
 * 一旦收到数据则等到 end。
 */
async function readStdinIfPiped(idleMs = 80): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined

  const chunks: Buffer[] = []
  let gotData = false

  return await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.pause()
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onEnd)
      const text = Buffer.concat(chunks).toString('utf8').trim()
      resolve(text || undefined)
    }

    const onData = (c: string | Buffer) => {
      gotData = true
      clearTimeout(timer)
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    }
    const onEnd = () => finish()

    const timer = setTimeout(() => {
      if (!gotData) finish()
    }, idleMs)

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onEnd)
    process.stdin.resume()
  })
}

async function main(): Promise<void> {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`error: ${msg}\n\n${formatHelp()}`)
    process.exit(2)
  }

  if (args.help) {
    process.stdout.write(formatHelp())
    process.exit(0)
  }

  const cwd = args.cwd ?? process.cwd()
  const isTty = process.stdin.isTTY === true

  // ── --continue / -c：最新一条 ──
  if (args.continue) {
    let prompt = args.prompt
    if (!prompt) {
      prompt = await readStdinIfPiped()
    }
    try {
      const id = await resolveContinueSessionId({ cwd })
      await runResumeCli({
        idOrPath: id,
        cwd,
        prompt,
        print: args.print || Boolean(prompt),
      })
    } catch (err) {
      if (err instanceof ResumePickerError) {
        process.stderr.write(`error: ${err.message}\n`)
        process.exit(err.exitCode)
      }
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${msg}\n`)
      process.exit(1)
    }
    return
  }

  // ── --resume 路径 ──
  if (args.resume) {
    let prompt = args.prompt
    if (!prompt && !isResumePicker(args.resume)) {
      prompt = await readStdinIfPiped()
    }
    try {
      await runResumeCli({
        idOrPath: isResumePicker(args.resume) ? true : args.resume,
        cwd,
        prompt,
        print: args.print || Boolean(prompt),
      })
    } catch (err) {
      if (err instanceof ResumePickerError) {
        process.stderr.write(`error: ${err.message}\n`)
        process.exit(err.exitCode)
      }
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${msg}\n`)
      process.exit(1)
    }
    return
  }

  // ── 新会话路径（无 --resume）──
  let prompt = args.prompt
  if (!prompt && !isTty) {
    prompt = await readStdinIfPiped()
  }

  // 无参 + TTY → banner + REPL
  if (!prompt && !args.print && isTty) {
    try {
      await runNewSessionCli({ cwd })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${msg}\n`)
      process.exit(1)
    }
    return
  }

  // 有 prompt / print：单轮新会话
  if (prompt?.trim()) {
    try {
      await runNewSessionCli({
        cwd,
        prompt,
        print: true,
        isTty: false,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${msg}\n`)
      process.exit(1)
    }
    return
  }

  // 非 TTY 无参：help，勿挂起
  process.stderr.write(
    'error: bolo with no args requires a TTY. Use --help, --resume, or pass a prompt.\n',
  )
  process.stdout.write(formatHelp())
  process.exit(2)
}

main()