/**
 * 新会话 CLI：banner + createSessionFromWorkspace + REPL
 * T4 流式事件行 · T5 TTY 权限 · T6 slash 经 REPL/submitUserInput
 */

import {
  createSessionFromWorkspace,
  productionDeps,
  setSessionPersistMeta,
  type BoloSession,
  type SessionEvent,
} from '../../core/src/index.ts'
import { createCliProvider } from './provider.ts'
import { createTtyAskPermission } from './tui/askPermissionTty.ts'
import { renderWelcomeBanner } from './tui/banner.ts'
import { formatSessionStatusLine } from './tui/statusLine.ts'
import {
  attachSessionEventPrinter,
  createCliOnEvent,
  runOnePrompt,
  runRepl,
} from './resumeCli.ts'

export type NewSessionCliOptions = {
  cwd?: string
  prompt?: string
  print?: boolean
  forceMock?: boolean
  writeOut?: (s: string) => void
  writeErr?: (s: string) => void
  isTty?: boolean
  skipBanner?: boolean
  plainBanner?: boolean
  onSessionEvent?: (e: SessionEvent) => void
  readPermissionAnswer?: (prompt: string) => Promise<string>
  nonTtyPermission?: 'allow' | 'deny'
}

export type NewSessionCliResult = {
  session: BoloSession
  terminalReason?: string
}

/**
 * 无参启动：欢迎 banner → 新会话 → 可选单轮 / REPL
 */
export async function runNewSessionCli(
  opts: NewSessionCliOptions = {},
): Promise<NewSessionCliResult> {
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))
  const cwd = opts.cwd ?? process.cwd()
  const isTty = opts.isTty ?? process.stdin.isTTY === true

  const { provider, missingKey, kind, model } = createCliProvider({
    forceMock: opts.forceMock,
  })

  if (missingKey) {
    writeErr(
      `warn: no API key (provider=${kind}); session starts, callModel will fail until keys are set.\n`,
    )
  }

  const thinkingGate: { session: BoloSession | null } = { session: null }
  const { printer, onEvent } = createCliOnEvent({
    writeOut,
    writeErr,
    onSessionEvent: opts.onSessionEvent,
    showThinking: () => thinkingGate.session?.showThinking !== false,
  })

  const askPermission = createTtyAskPermission({
    isTty,
    readAnswer: opts.readPermissionAnswer,
    nonTtyDecision: opts.nonTtyPermission ?? 'deny',
  })

  const { session } = await createSessionFromWorkspace({
    cwd,
    ensureDefaults: true,
    askPermission,
    onEvent,
  })

  thinkingGate.session = session
  attachSessionEventPrinter(session, printer)

  // CLI 控制 provider：forceMock / 无 key 时覆盖 workspace 装配结果
  if (opts.forceMock || missingKey) {
    session.provider = provider
    session.deps = productionDeps(provider)
  }
  if (model && !session.model) session.model = model

  setSessionPersistMeta(session, {
    autoSave: true,
    scope: 'project',
  })

  if (!opts.skipBanner) {
    const banner = renderWelcomeBanner({
      version: '0.0.1',
      cwd: session.cwd,
      model: session.model,
      sessionId: session.id,
      plain: opts.plainBanner,
    })
    writeOut(banner.endsWith('\n') ? banner : `${banner}\n`)
    writeOut(`${formatSessionStatusLine(session)}\n`)
  }

  const prompt = opts.prompt?.trim()
  const print = opts.print === true
  const interactive = !print && !prompt && isTty

  if (prompt) {
    const turn = await runOnePrompt(session, prompt, { writeOut, writeErr })
    return { session, terminalReason: turn.terminalReason }
  }

  if (interactive) {
    await runRepl(session, { writeOut, writeErr, isTty })
    return { session }
  }

  writeErr(
    'Non-interactive terminal: pass a prompt, use --print with text, or --resume. See --help.\n',
  )
  return { session }
}