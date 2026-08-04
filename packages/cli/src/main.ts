/**
 * bolo CLI 入口
 */
import { formatHelp, isResumePicker, parseArgs } from './parseArgs.ts'
import { hasToolSpecs, validateToolSpecs } from './applyToolSpecs.ts'

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
  const argv = process.argv.slice(2)

  // Explicit scaffolding must never fall through as a model prompt.
  if (argv[0] === 'init') {
    const { runInitCli } = await import('./initCli.ts')
    const result = await runInitCli(argv.slice(1))
    process.exitCode = result.exitCode
    return
  }

  // `search` owns its subcommand argv, including doctor `--json`. Dispatch it
  // before the generic runtime parser so flags cannot be stolen by another
  // command family. A network probe must also exit gracefully: `process.exit`
  // can tear down Windows fetch/libuv handles while they are still closing.
  if (argv[0] === 'search') {
    const { runSearchCli } = await import('./searchCli.ts')
    process.exitCode = await runSearchCli(argv.slice(1))
    return
  }

  // REN-3：渲染 worker 子命令（self re-exec 隔离不可信内容渲染）。
  if (argv[0] === 'render-worker') {
    const { runRenderWorker } = await import('./renderWorker.ts')
    await runRenderWorker()
    return
  }

  const wantsJson = argv.includes('--json')
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (wantsJson) {
      const { formatRuntimeCliFailure } = await import('./runtimeCli.ts')
      process.stdout.write(
        `${formatRuntimeCliFailure({
          ok: false,
          code: 'usage',
          detail: msg,
        })}\n`,
      )
    } else {
      process.stderr.write(`error: ${msg}\n\n${formatHelp()}`)
    }
    process.exit(2)
  }

  if (args.help) {
    process.stdout.write(formatHelp())
    process.exit(0)
  }

  // 工具规格先验后用：写错的 --disallowed-tools 若被放过，用户会以为拦住了
  // 而实际没拦。在开会话、跑轮次之前就退出，错误才对得上他手里的命令行。
  const toolSpecs = {
    ...(args.allowedTools ? { allowedTools: args.allowedTools } : {}),
    ...(args.disallowedTools ? { disallowedTools: args.disallowedTools } : {}),
  }
  if (hasToolSpecs(toolSpecs)) {
    const check = validateToolSpecs(toolSpecs)
    if (!check.ok) {
      process.stderr.write(`error: ${check.reason}
`)
      process.exit(2)
    }
  }

  const cwd = args.cwd ?? process.cwd()
  const isTty = process.stdin.isTTY === true

  // ── runtime query/recovery command：不打印 banner/summary ──
  if (args.runtimeQuery || args.runtimeAction) {
    const {
      formatRuntimeCliFailure,
      runRuntimeCommandCli,
      runRuntimeQueryCli,
    } = await import('./runtimeCli.ts')
    let idOrPath: string
    if (args.continue) {
      try {
        const { resolveContinueSessionId } = await import('./resumeCli.ts')
        idOrPath = await resolveContinueSessionId({ cwd })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (args.json) {
          process.stdout.write(
            `${formatRuntimeCliFailure({
              ok: false,
              code: 'load_failed',
              detail: msg,
            })}\n`,
          )
        } else {
          process.stderr.write(`error: ${msg}\n`)
        }
        process.exit(1)
      }
    } else if (typeof args.resume === 'string') {
      idOrPath = args.resume
    } else {
      const detail = `runtime ${args.runtimeQuery ? 'query' : 'command'} requires --resume <id|path> or --continue`
      if (args.json) {
        process.stdout.write(
          `${formatRuntimeCliFailure({
            ok: false,
            code: 'usage',
            detail,
          })}\n`,
        )
      } else {
        process.stderr.write(`error: ${detail}\n`)
      }
      process.exit(2)
    }

    const result = args.runtimeQuery
      ? await runRuntimeQueryCli({
          idOrPath,
          cwd,
          query: args.runtimeQuery,
          json: args.json,
          isTty: isTty && process.stdout.isTTY === true,
          columns: process.stdout.columns,
          rows: process.stdout.rows,
          env: process.env,
        })
      : await runRuntimeCommandCli({
          idOrPath,
          cwd,
          action: args.runtimeAction!,
          requestId: args.runtimeRequestId,
          json: args.json,
        })
    process.exit(result.exitCode)
  }

  // ── --list / -l：非交互列项目会话 ──
  if (args.list) {
    try {
      const [{ listWorkspaceSessions }, { formatSessionList }] =
        await Promise.all([
          import('../../core/src/index.ts'),
          import('./resumeCli.ts'),
        ])
      const items = await listWorkspaceSessions({ cwd, limit: 50 })
      if (!items.length) {
        process.stdout.write('(no sessions for this workspace)\n')
        process.exit(0)
      }
      process.stdout.write(`${formatSessionList(items)}\n`)
      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${msg}\n`)
      process.exit(1)
    }
  }

  // ── --migrate-session / migrate-session：JSON → jsonl ──
  if (args.migrateSession) {
    try {
      const { migrateSessionToJsonl } =
        await import('../../core/src/index.ts')
      const r = await migrateSessionToJsonl(args.migrateSession, {
        cwd,
        force: args.force === true,
        deleteJson: args.deleteJson === true,
      })
      const status = r.wrote
        ? 'wrote'
        : 'skipped (jsonl already has messages; use --force)'
      process.stdout.write(
        [
          `migrate-session: ${status}`,
          `  id/path:  ${args.migrateSession}`,
          `  json:     ${r.jsonPath}`,
          `  jsonl:    ${r.transcriptPath}`,
          `  messages: ${r.messageCount}`,
          `  deletedJson: ${r.deletedJson}`,
        ].join('\n') + '\n',
      )
      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${msg}\n`)
      process.exit(1)
    }
  }

  // ── --continue / -c：最新一条 ──
  if (args.continue) {
    const {
      resolveContinueSessionId,
      ResumePickerError,
      runResumeCli,
    } = await import('./resumeCli.ts')
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
        toolSpecs,
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
    const { ResumePickerError, runResumeCli } =
      await import('./resumeCli.ts')
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
        toolSpecs,
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
      const { runNewSessionCli } = await import('./newSessionCli.ts')
      await runNewSessionCli({ cwd, toolSpecs })
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
      const { runNewSessionCli } = await import('./newSessionCli.ts')
      await runNewSessionCli({
        cwd,
        prompt,
        print: true,
        isTty: false,
        toolSpecs,
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
    'error: bolo with no args requires a TTY. Use --help, --list, --resume, or pass a prompt.\n',
  )
  process.stdout.write(formatHelp())
  process.exit(2)
}

main()
