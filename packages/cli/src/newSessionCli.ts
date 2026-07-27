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
import { createCliProvider, isExplicitMockProvider } from './provider.ts'
import { createSessionErrorExplainer } from './explainSessionError.ts'
import { createTtyAskPermission } from './tui/askPermissionTty.ts'
import { applyToolSpecsToSession, type ToolSpecCliArgs } from './applyToolSpecs.ts'
import { createTtyAskUserQuestion } from './tui/askUserQuestionTty.ts'
import { renderWelcomeBanner } from './tui/banner.ts'
import { formatSessionStatusLine } from './tui/statusLine.ts'
import { renderInkLayout } from './tui/inkLayout.ts'
import { shouldUseDynamicTui } from './tui/inputBox.ts'
import {
  attachSessionEventPrinter,
  attachSessionTerminalSurface,
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
  /** --allowed-tools / --disallowed-tools 原文；会话建好后并入权限规则 */
  toolSpecs?: ToolSpecCliArgs
  /** 单轮或 REPL 的外部取消信号 */
  signal?: AbortSignal
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
  const dynamicTui =
    opts.print !== true && shouldUseDynamicTui({ isTty })
  const color =
    process.env.NO_COLOR === undefined &&
    process.env.BOLO_THEME?.trim().toLowerCase() !== 'plain'

  const thinkingGate: { session: BoloSession | null } = { session: null }
  const { printer, onEvent, surface } = createCliOnEvent({
    writeOut,
    writeErr,
    onSessionEvent: opts.onSessionEvent,
    showThinking: () => thinkingGate.session?.showThinking !== false,
    timeline: dynamicTui,
    color,
    columns: process.stdout.columns,
    explainError: createSessionErrorExplainer(thinkingGate),
  })

  const askPermission = createTtyAskPermission({
    isTty,
    readAnswer: opts.readPermissionAnswer,
    nonTtyDecision: opts.nonTtyPermission ?? 'deny',
    writeOut,
    signal: opts.signal,
  })

  // AskUserQuestion 的提问句柄。非 TTY 时它自己收口成 unavailable ——
  // 不在这里编一个默认答案。
  const askUserQuestion = createTtyAskUserQuestion({
    isTty,
    writeOut,
    signal: opts.signal,
  })

  const { session, workspace } = await createSessionFromWorkspace({
    cwd,
    materializeUserState: true,
    askPermission,
    onEvent,
  })

  thinkingGate.session = session
  if (opts.toolSpecs) applyToolSpecsToSession(session, opts.toolSpecs)
  session.askUserQuestion = askUserQuestion
  attachSessionEventPrinter(session, printer)
  if (surface) attachSessionTerminalSurface(session, surface)

  // 配置解析失败必须先说——否则用户会把「配置没生效」误当成别的问题排查
  for (const w of workspace.configWarnings ?? []) {
    writeErr(`warn: ${w}\n`)
  }

  // forceMock 是显式测试覆盖；缺 key 判定必须来自 workspace active profile，
  // 不能用通用 env 探测覆盖一个已由自定义 apiKeyEnv 正确装配的 provider。
  if (opts.forceMock) {
    const forced = createCliProvider({ forceMock: true })
    session.provider = forced.provider
    session.deps = productionDeps(forced.provider)
  } else if (workspace.providerMissingKey && !isExplicitMockProvider()) {
    const delayedFailure = createCliProvider()
    session.provider = delayedFailure.provider
    session.deps = productionDeps(delayedFailure.provider)
    const keyHint =
      workspace.providerProfile?.apiKeyEnv ??
      'BOLO_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY'
    writeErr(
      `warn: no API key (provider=${workspace.providerId}; set ${keyHint}); session starts, callModel will fail until keys are set.\n`,
    )
  }

  setSessionPersistMeta(session, {
    autoSave: true,
    scope: 'workspace',
  })

  if (!opts.skipBanner) {
    const active =
      session.providerId != null
        ? `${session.providerId}/${session.model ?? session.provider?.id ?? '?'}`
        : session.model
    const useLayout =
      process.env.BOLO_TUI_LAYOUT !== '0' &&
      process.env.BOLO_TUI_LAYOUT !== 'false' &&
      opts.plainBanner !== true
    if (useLayout) {
      const layout = renderInkLayout({
        version: '0.0.1',
        headline: 'Welcome to Bolo Code',
        cwd: session.cwd,
        model: active,
        sessionId: session.id,
        plain: opts.plainBanner,
        session: {
          permissionMode: session.permissionMode,
          model: session.model,
          effortLevel: session.effortLevel,
          messages: session.messages,
          providerId: session.providerId,
          providerKind: session.provider?.id,
        },
        hint: '/help commands · /provider model',
      })
      writeOut(layout.endsWith('\n') ? layout : `${layout}\n`)
    } else {
      const banner = renderWelcomeBanner({
        version: '0.0.1',
        cwd: session.cwd,
        model: active,
        sessionId: session.id,
        plain: opts.plainBanner,
      })
      writeOut(banner.endsWith('\n') ? banner : `${banner}\n`)
      writeOut(`${formatSessionStatusLine(session)}\n`)
      if (session.providerId) {
        writeOut(
          `provider: ${session.providerId}  kind=${session.provider?.id ?? '?'}  (/provider to list/switch)\n`,
        )
      }
    }
  }

  const prompt = opts.prompt?.trim()
  const print = opts.print === true
  const interactive = !print && !prompt && isTty

  if (prompt) {
    const turn = await runOnePrompt(session, prompt, {
      writeOut,
      writeErr,
      signal: opts.signal,
    })
    try {
      const { endSession } = await import('../../core/src/index.ts')
      await endSession(session, { reason: 'other' })
    } catch {
      /* ignore */
    }
    return { session, terminalReason: turn.terminalReason }
  }

  if (interactive) {
    await runRepl(session, {
      writeOut,
      writeErr,
      isTty,
      signal: opts.signal,
    })
    return { session }
  }

  writeErr(
    'Non-interactive terminal: pass a prompt, use --print with text, or --resume. See --help.\n',
  )
  try {
    const { endSession } = await import('../../core/src/index.ts')
    await endSession(session, { reason: 'other' })
  } catch {
    /* ignore */
  }
  return { session }
}
