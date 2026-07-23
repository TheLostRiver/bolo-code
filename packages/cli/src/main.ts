/**
 * bolo CLI 入口
 */
import { formatHelp, isResumePicker, parseArgs } from './parseArgs.ts'
import { ResumePickerError, runResumeCli } from './resumeCli.ts'

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

  if (args.help || (!args.resume && process.argv.slice(2).length === 0)) {
    process.stdout.write(formatHelp())
    process.exit(0)
  }

  if (!args.resume) {
    process.stderr.write(
      'error: currently only --resume is supported. See --help.\n',
    )
    process.exit(2)
  }

  let prompt = args.prompt
  // 无显式 prompt 时，非 TTY 可从管道读入（有 id 时）
  if (!prompt && !isResumePicker(args.resume)) {
    prompt = await readStdinIfPiped()
  }

  try {
    await runResumeCli({
      idOrPath: isResumePicker(args.resume) ? true : args.resume,
      cwd: args.cwd ?? process.cwd(),
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
}

main()