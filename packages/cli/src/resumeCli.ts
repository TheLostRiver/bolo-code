/**
 * resume 接线：load/resumeSession + 摘要 + 可选单轮 submit / 极简 REPL
 * 无 id 时 listWorkspaceSessions → TTY 选择 / 非 TTY 列表
 * T4 流式 text/tool 行；T5 TTY 权限 y/N；T6 slash 经 submitUserInput
 */

import { randomUUID } from 'node:crypto'
import * as readline from 'node:readline'
import {
  listWorkspaceSessions,
  productionDeps,
  resumeSessionFromWorkspace,
  requestSessionControl,
  submitUserInput,
  switchSessionProvider,
  takeNextSessionQueued,
  buildProviderPickerItems,
  activeProviderPickerIndex,
  type BoloSession,
  type SessionEvent,
  type SessionListItem,
  type SessionSnapshot,
} from '../../core/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import {
  runAsyncCleanupSteps,
  runWithAsyncCleanup,
} from './cleanup.ts'
import { createCliProvider, isExplicitMockProvider } from './provider.ts'
import { createSessionErrorExplainer } from './explainSessionError.ts'
import { createTtyAskPermission } from './tui/askPermissionTty.ts'
import { createTtyAskUserQuestion } from './tui/askUserQuestionTty.ts'
import { applyToolSpecsToSession, type ToolSpecCliArgs } from './applyToolSpecs.ts'
import { renderWelcomeBanner } from './tui/banner.ts'
import { renderInkLayout } from './tui/inkLayout.ts'
import {
  createSessionEventPrinter,
  type SessionEventPrinter,
} from './tui/formatSessionEvent.ts'
import {
  createTuiInputState,
  readTuiInput,
  renderTuiInputBox,
  shouldUseDynamicTui,
} from './tui/inputBox.ts'
import {
  createTurnActivityIndicator,
  type TurnActivityIndicator,
} from './tui/turnActivity.ts'
import { formatSessionStatusLine } from './tui/statusLine.ts'
import {
  runArrowPicker,
  type ArrowPickItem,
  type ArrowPickResult,
} from './tui/arrowPicker.ts'
import { getCliSlashCommandCandidates } from './slashCandidates.ts'
import {
  createTerminalSurface,
  type TerminalSurface,
} from './tui/terminalSurface.ts'
import {
  createRetainedTuiController,
  type CliTuiController,
} from './tui/retainedTui.ts'
import {
  resolveCliTuiEngine,
  type CliTuiEngine,
} from './tui/tuiEngine.ts'
import type {
  BoloTerminalInput,
  BoloTerminalOutput,
} from './tui/boloTerminalAdapter.ts'
import { renderContextDashboard } from './tui/contextDashboard.ts'
import {
  prefixTuiContentBlock,
  resolveTuiContentColumns,
} from './tui/contentLayout.ts'

export type ResumeCliOptions = {
  /** session id / 路径；省略或 true 时进入项目列表选择 */
  idOrPath?: string | true
  cwd?: string
  /** 单轮 prompt；有则 submit 后结束（除非 interactive） */
  prompt?: string
  /** 非交互：有 prompt 跑一轮，无则只摘要 */
  print?: boolean
  /** 强制 mock provider（测试） */
  forceMock?: boolean
  /** 关闭 system 重建（测试更快） */
  reassembleSystem?: boolean
  systemPrompt?: boolean
  /** 覆盖 sessionsDir（测试） */
  sessionsDir?: string
  /** 原始 SessionEvent（测试钩子；默认已走 T4 打印机） */
  onSessionEvent?: (e: SessionEvent) => void
  /** @deprecated 用 onSessionEvent；text 事件时回调 e.text */
  onEvent?: (line: string) => void
  /** 注入 stdout 便于测试 */
  writeOut?: (s: string) => void
  writeErr?: (s: string) => void
  /**
   * 是否 TTY（选择器 / 权限 ask）。默认 process.stdin.isTTY。
   * 测试可强制 false。
   */
  isTty?: boolean
  /**
   * 注入选择器输入（测试用，返回 1-based 编号字符串）。
   * 未注入时用 readline。
   */
  readChoice?: (prompt: string) => Promise<string>
  /**
   * 注入权限问答（测试）；默认 TTY readline / 非 TTY deny
   */
  readPermissionAnswer?: (prompt: string) => Promise<string>
  /**
   * 非 TTY 权限决策；默认 deny
   */
  nonTtyPermission?: 'allow' | 'deny'
  /** 单轮或 REPL 的外部取消信号 */
  /** --allowed-tools / --disallowed-tools 原文；并入快照恢复出来的规则之上 */
  toolSpecs?: ToolSpecCliArgs
  signal?: AbortSignal
}

export type ResumeCliResult = {
  session: BoloSession
  snapshot: SessionSnapshot
  path: string
  summary: SessionSummary
  terminalReason?: string
}

export type SessionSummary = {
  id: string
  cwd: string
  path: string
  messageCount: number
  permissionMode: string
  model?: string
  lastMessage?: { role: string; preview: string }
}

/** 选择器失败时抛出，带建议 exit code */
export class ResumePickerError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'ResumePickerError'
    this.exitCode = exitCode
  }
}

function previewText(content: string, max = 120): string {
  const one = content.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return `${one.slice(0, max - 1)}…`
}

export function buildSessionSummary(
  session: BoloSession,
  filePath: string,
): SessionSummary {
  const last = session.messages[session.messages.length - 1]
  return {
    id: session.id,
    cwd: session.cwd,
    path: filePath,
    messageCount: session.messages.length,
    permissionMode: session.permissionMode,
    model: session.model,
    lastMessage: last
      ? { role: last.role, preview: previewText(last.content || '(empty)') }
      : undefined,
  }
}

export function formatSessionSummary(s: SessionSummary): string {
  const lines = [
    `session: ${s.id}`,
    `cwd:     ${s.cwd}`,
    `file:    ${s.path}`,
    `messages:${s.messageCount}`,
    `mode:    ${s.permissionMode}`,
  ]
  if (s.model) lines.push(`model:   ${s.model}`)
  if (s.lastMessage) {
    lines.push(`last:    [${s.lastMessage.role}] ${s.lastMessage.preview}`)
  }
  return lines.join('\n')
}

/** 编号列表（stdout）— 表格行便于扫读 */
export function formatSessionList(items: SessionListItem[]): string {
  if (!items.length) return '(no sessions)'
  const header =
    ' #  id                          msgs  updated              title/preview'
  const rows = items.map((it, i) => {
    const n = String(i + 1).padStart(2, ' ')
    const id =
      it.id.length > 28 ? `${it.id.slice(0, 27)}…` : it.id.padEnd(28)
    const msgs = String(it.messageCount).padStart(4)
    const when = it.updatedAt
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, 'Z')
      .slice(0, 19)
      .padEnd(19)
    const label = it.title?.trim()
      ? it.title.trim()
      : it.preview || '(no user message)'
    const prev = label.slice(0, 52)
    const model = it.model ? `  [${it.model}]` : ''
    return `${n}  ${id}  ${msgs}  ${when}  ${prev}${model}`
  })
  return [header, ...rows].join('\n')
}

/**
 * RS8：按 id 子串、title 或 preview 过滤（大小写不敏感）。
 * 空 query → 原列表。
 */
export function filterSessionListItems(
  items: SessionListItem[],
  query: string,
): SessionListItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((it) => {
    const hay =
      `${it.id} ${it.title ?? ''} ${it.preview} ${it.model ?? ''}`.toLowerCase()
    return hay.includes(q)
  })
}

/**
 * RS8：解析用户输入 → 选中 id。
 * - 纯数字：1-based 索引
 * - q / quit / exit：取消
 * - 其它：当 id 精确匹配或唯一前缀 / 过滤唯一命中
 */
export function resolveSessionPickerChoice(
  items: SessionListItem[],
  raw: string,
):
  | { ok: true; id: string }
  | { ok: false; reason: 'cancel' | 'empty' | 'invalid' | 'ambiguous'; message: string } {
  const s = raw.trim()
  if (!s) {
    return { ok: false, reason: 'empty', message: 'Please enter a number, id, or filter.' }
  }
  const lower = s.toLowerCase()
  if (lower === 'q' || lower === 'quit' || lower === 'exit') {
    return { ok: false, reason: 'cancel', message: 'Cancelled.' }
  }
  if (/^\d+$/.test(s)) {
    const n = Number.parseInt(s, 10)
    if (!Number.isFinite(n) || n < 1 || n > items.length) {
      return {
        ok: false,
        reason: 'invalid',
        message: `Invalid choice. Enter 1–${items.length}, an id, filter text, or q.`,
      }
    }
    return { ok: true, id: items[n - 1]!.id }
  }
  const exact = items.find((it) => it.id === s)
  if (exact) return { ok: true, id: exact.id }
  const filtered = filterSessionListItems(items, s)
  if (filtered.length === 1) return { ok: true, id: filtered[0]!.id }
  if (filtered.length === 0) {
    return {
      ok: false,
      reason: 'invalid',
      message: `No session matches "${s}". Try number, id fragment, or q.`,
    }
  }
  return {
    ok: false,
    reason: 'ambiguous',
    message: `Ambiguous filter "${s}" (${filtered.length} matches). Narrow it or use a number.`,
  }
}

/**
 * `--continue` / `-c`：取 listWorkspaceSessions 第一条（已按 updatedAt 降序）。
 * 空列表 → exit 1（与 picker 一致）。
 */
export async function resolveContinueSessionId(opts: {
  cwd: string
  sessionsDir?: string
}): Promise<string> {
  const items = await listWorkspaceSessions({
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
    limit: 1,
  })
  if (items.length === 0) {
    throw new ResumePickerError(
      'No sessions in this workspace. Start a new session with: bolo',
      1,
    )
  }
  return items[0]!.id
}

/**
 * 无 id：列项目会话并选 id（RS8 增强）。
 * - 空列表 → exit 1
 * - 非 TTY → 打印列表，要求 --resume <id>，exit 2
 * - TTY → 编号 / id / 过滤 / q 取消
 */
export async function pickProjectSessionId(opts: {
  cwd: string
  sessionsDir?: string
  isTty?: boolean
  writeOut?: (s: string) => void
  writeErr?: (s: string) => void
  readChoice?: (prompt: string) => Promise<string>
  /** F-T8-PICKER：优先箭头键；false 强制编号 */
  arrowPicker?: boolean
  readKey?: () => Promise<string>
}): Promise<string> {
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))
  let items = await listWorkspaceSessions({
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
  })

  if (items.length === 0) {
    throw new ResumePickerError(
      'No sessions in this workspace. Start a new session with: bolo',
      1,
    )
  }

  const isTty = opts.isTty ?? process.stdin.isTTY === true
  if (!isTty) {
    writeOut(`${formatSessionList(items)}\n`)
    writeErr(
      'Non-interactive terminal: pick a session with --resume <id> (see list above).\n',
    )
    throw new ResumePickerError(
      'non-interactive resume requires --resume <id>',
      2,
    )
  }

  const useArrow =
    opts.arrowPicker !== false &&
    process.env.BOLO_ARROW_PICKER !== '0' &&
    (opts.readKey != null || process.stdin.isTTY === true)

  if (useArrow) {
    const pickItems: ArrowPickItem[] = items.map((it) => ({
      id: it.id,
      label:
        `${it.id.slice(0, 12)}  ${(it.title ?? it.preview ?? '').slice(0, 40)}  n=${it.messageCount}`.trim(),
    }))
    const ar = await runArrowPicker({
      items: pickItems,
      writeOut,
      readKey: opts.readKey,
      isTty: true,
    })
    if (ar.ok) return ar.id
    if (ar.reason === 'cancel') {
      throw new ResumePickerError(ar.message || 'cancelled', 1)
    }
    // unsupported → fall through to number picker
  }

  const readChoice =
    opts.readChoice ??
    (async (q: string) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      })
      try {
        return await new Promise<string>((resolve) => {
          rl.question(q, resolve)
        })
      } finally {
        rl.close()
      }
    })

  writeOut(`${formatSessionList(items)}\n`)
  writeOut(
    'Enter number, session id, filter text (unique match), or q to cancel.\n',
  )

  for (;;) {
    const raw = await readChoice(`Select session [1-${items.length}]: `)
    const resolved = resolveSessionPickerChoice(items, raw)
    if (resolved.ok) return resolved.id
    if (resolved.reason === 'cancel') {
      throw new ResumePickerError(resolved.message, 1)
    }
    if (resolved.reason === 'ambiguous') {
      const filtered = filterSessionListItems(items, raw.trim())
      writeOut(`${formatSessionList(filtered)}\n`)
      items = filtered
      writeErr(`${resolved.message}\n`)
      continue
    }
    writeErr(`${resolved.message}\n`)
  }
}

/** 取本轮新增的助手可见文本（从 messages 末尾向前） */
export function lastAssistantText(
  messages: ChatMessage[],
  beforeCount: number,
): string {
  const added = messages.slice(beforeCount)
  const parts: string[] = []
  for (const m of added) {
    if (m.role === 'assistant' && m.content.trim()) {
      parts.push(m.content.trim())
    }
  }
  if (parts.length) return parts.join('\n\n')
  // 回退：最后一条 assistant
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.content.trim()) return m.content.trim()
  }
  return ''
}

/** 挂 session 上的 T4 打印机（CLI 内部） */
const EVENT_PRINTER = Symbol.for('bolo.cli.eventPrinter')
const TERMINAL_SURFACE = Symbol.for('bolo.cli.terminalSurface')
const TUI_CONTROLLER = Symbol.for('bolo.cli.tuiController')

export function getSessionEventPrinter(
  session: BoloSession,
): SessionEventPrinter | undefined {
  return (session as BoloSession & { [EVENT_PRINTER]?: SessionEventPrinter })[
    EVENT_PRINTER
  ]
}

export function attachSessionEventPrinter(
  session: BoloSession,
  printer: SessionEventPrinter,
): void {
  ;(session as BoloSession & { [EVENT_PRINTER]?: SessionEventPrinter })[
    EVENT_PRINTER
  ] = printer
}

export function getSessionTerminalSurface(
  session: BoloSession,
): TerminalSurface | undefined {
  return (
    session as BoloSession & { [TERMINAL_SURFACE]?: TerminalSurface }
  )[TERMINAL_SURFACE]
}

export function attachSessionTerminalSurface(
  session: BoloSession,
  surface: TerminalSurface,
): void {
  ;(
    session as BoloSession & { [TERMINAL_SURFACE]?: TerminalSurface }
  )[TERMINAL_SURFACE] = surface
}

export function getSessionTuiController(
  session: BoloSession,
): CliTuiController | undefined {
  return (
    session as BoloSession & { [TUI_CONTROLLER]?: CliTuiController }
  )[TUI_CONTROLLER]
}

export function attachSessionTuiController(
  session: BoloSession,
  controller: CliTuiController,
): void {
  ;(
    session as BoloSession & { [TUI_CONTROLLER]?: CliTuiController }
  )[TUI_CONTROLLER] = controller
}

export function configureSessionComposer(
  controller: CliTuiController,
  session: BoloSession,
  history: readonly string[] = [],
): void {
  controller.configureComposer({
    history,
    slashCandidates: getCliSlashCommandCandidates(session),
    status: {
      permissionMode: session.permissionMode,
      providerId: session.providerId,
      providerKind: session.provider?.id,
      model: session.model,
      effortLevel: session.effortLevel,
      ...(session.usage ? { usage: session.usage } : {}),
    },
  })
}

/**
 * 组装 CLI onEvent：T4 打印机 + 可选测试钩子
 */
export function createCliOnEvent(opts: {
  writeOut: (s: string) => void
  writeErr: (s: string) => void
  onSessionEvent?: (e: SessionEvent) => void
  onEvent?: (line: string) => void
  /**
   * 是否渲染 thinking；默认 true。
   * 可传函数以绑定 session.showThinking（/thinking off）。
   */
  showThinking?: boolean | (() => boolean)
  timeline?: boolean
  color?: boolean
  columns?: number
  activity?: TurnActivityIndicator
  engine?: CliTuiEngine
  terminalInput?: BoloTerminalInput
  terminalOutput?: BoloTerminalOutput
  env?: NodeJS.ProcessEnv
  /** 把 provider 原始错误变成「怎么了 + 下一步」（晚绑定到活跃 session） */
  explainError?: (message: string) => string
}): {
  printer: SessionEventPrinter
  onEvent: (e: SessionEvent) => void
  surface?: TerminalSurface
  controller?: CliTuiController
} {
  const controller =
    opts.timeline === true && opts.engine === 'retained'
      ? createRetainedTuiController({
          writeOut: opts.writeOut,
          writeErr: opts.writeErr,
          ...(opts.terminalInput ? { input: opts.terminalInput } : {}),
          output: opts.terminalOutput ?? { columns: opts.columns },
          env: opts.env,
          fallbackColumns: opts.columns,
          showThinking: opts.showThinking,
          ...(opts.explainError ? { explainError: opts.explainError } : {}),
        })
      : undefined
  const surface =
    opts.timeline === true && !controller
      ? createTerminalSurface({
          writeOut: opts.writeOut,
          writeErr: opts.writeErr,
        })
      : undefined
  const printerOut =
    controller?.writeOutput ?? surface?.writeOutput ?? opts.writeOut
  const printerErr =
    controller?.writeError ?? surface?.writeError ?? opts.writeErr
  const activity =
    opts.timeline === true && !controller
      ? (opts.activity ??
        createTurnActivityIndicator({
          writeOut: printerOut,
          color: opts.color,
          columns: () => process.stdout.columns ?? opts.columns,
          ...(surface
            ? {
                renderFrame: (line: string) => surface.setActivity(line),
                clearFrame: () => surface.clearActivity(),
              }
            : {}),
        }))
      : undefined
  const printer =
    controller?.printer ??
    createSessionEventPrinter({
      writeOut: printerOut,
      writeErr: printerErr,
      showThinking: opts.showThinking,
      timeline: opts.timeline,
      color: opts.color,
      columns: opts.columns,
      activity,
      ...(opts.explainError ? { explainError: opts.explainError } : {}),
    })
  return {
    printer,
    ...(surface ? { surface } : {}),
    ...(controller ? { controller } : {}),
    onEvent: (e) => {
      printer.onEvent(e)
      opts.onSessionEvent?.(e)
      if (e.type === 'text' && e.text) opts.onEvent?.(e.text)
    },
  }
}

/**
 * 仅加载并 resume（不跑 prompt）— 测试与 CLI 共用
 */
export async function resumeFromIdOrPath(
  opts: ResumeCliOptions & { idOrPath: string },
): Promise<ResumeCliResult> {
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))
  const isTty = opts.isTty ?? process.stdin.isTTY === true
  const dynamicTui =
    opts.print !== true && shouldUseDynamicTui({ isTty })
  const engine = resolveCliTuiEngine({
    dynamicTui,
    env: process.env,
  })
  const color =
    process.env.NO_COLOR === undefined &&
    process.env.BOLO_THEME?.trim().toLowerCase() !== 'plain'

  // 打印机创建早于 session；绑定后读 session.showThinking（/thinking）
  const thinkingGate: { session: BoloSession | null } = { session: null }
  const { printer, onEvent, surface, controller } = createCliOnEvent({
    writeOut,
    writeErr,
    onSessionEvent: opts.onSessionEvent,
    onEvent: opts.onEvent,
    showThinking: () => thinkingGate.session?.showThinking !== false,
    timeline: dynamicTui,
    engine,
    terminalInput: process.stdin,
    terminalOutput: process.stdout,
    env: process.env,
    color,
    columns: process.stdout.columns,
    explainError: createSessionErrorExplainer(thinkingGate),
  })

  const askPermission = createTtyAskPermission({
    isTty,
    readAnswer: opts.readPermissionAnswer,
    nonTtyDecision: opts.nonTtyPermission ?? 'deny',
    writeOut: controller?.writeOutput ?? writeOut,
    ...(controller
      ? {
          runPermissionOverlay: controller.runPermissionOverlay,
          runDiffOverlay: controller.runDiffOverlay,
        }
      : {}),
    signal: opts.signal,
  })
  const askUserQuestion = createTtyAskUserQuestion({
    isTty,
    writeOut: controller?.writeOutput ?? writeOut,
    ...(controller
      ? {
          runQuestionOverlay: controller.runQuestionOverlay,
        }
      : {}),
    signal: opts.signal,
  })

  const forced = opts.forceMock
    ? createCliProvider({ forceMock: true })
    : undefined
  const {
    session,
    snapshot,
    path: filePath,
    workspace,
    recovered,
  } = await resumeSessionFromWorkspace({
    idOrPath: opts.idOrPath,
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
    ...(forced ? { provider: forced.provider } : {}),
    reassembleSystem: opts.reassembleSystem,
    systemPrompt: opts.systemPrompt,
    create: forced?.model ? { model: forced.model } : undefined,
    autoSave: true,
    onEvent,
    askPermission,
  })

  thinkingGate.session = session
  if (opts.toolSpecs) applyToolSpecsToSession(session, opts.toolSpecs)
  session.askUserQuestion = askUserQuestion
  attachSessionEventPrinter(session, printer)
  if (surface) attachSessionTerminalSurface(session, surface)
  if (controller) {
    controller.restoreMessages(session.messages)
    configureSessionComposer(controller, session)
    attachSessionTuiController(session, controller)
  }

  // 快照读不了但从 append-only transcript 救回来了。
  // 静默恢复等于隐瞒损坏——说清楚发生了什么、坏文件在哪、我们没动它。
  if (recovered) {
    writeErr(
      `warn: session snapshot was unreadable (${recovered.reason}); ` +
        `recovered the conversation from the transcript. ` +
        `The unreadable file was left untouched at ${recovered.corruptPath}
`,
    )
  }

  // 快照加载成功后再提示无 key；判定以 workspace active profile 为准。
  // 配置解析失败必须先说——否则用户会把「配置没生效」误当成别的问题排查
  for (const w of workspace.configWarnings ?? []) {
    writeErr(`warn: ${w}\n`)
  }

  if (!forced && workspace.providerMissingKey && !isExplicitMockProvider()) {
    const delayedFailure = createCliProvider()
    session.provider = delayedFailure.provider
    session.deps = productionDeps(delayedFailure.provider)
    const keyHint =
      workspace.providerProfile?.apiKeyEnv ??
      'BOLO_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY'
    writeErr(
      `warn: no API key (provider=${workspace.providerId}; set ${keyHint}); snapshot loaded OK, callModel will fail until keys are set.\n`,
    )
  }

  const summary = buildSessionSummary(session, filePath)
  return { session, snapshot, path: filePath, summary }
}

export async function runOnePrompt(
  session: BoloSession,
  prompt: string,
  options?: {
    writeOut?: (s: string) => void
    writeErr?: (s: string) => void
    isTty?: boolean
    columns?: number
    color?: boolean
    /** REPL：打开 raw 面板前暂停 readline */
    pauseInput?: () => unknown | Promise<unknown>
    resumeInput?: () => unknown | Promise<unknown>
    /** 当前 turn 取消信号 */
    signal?: AbortSignal
    /** queued control 已分配的 durable turn id。 */
    turnId?: string
    /** queued/programmatic 输入来源。 */
    querySource?: string
  },
): Promise<{ terminalReason: string; assistantText: string }> {
  const writeOut = options?.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = options?.writeErr ?? ((s) => process.stderr.write(s))
  const isTty = options?.isTty ?? process.stdin.isTTY === true
  const columns = options?.columns ?? process.stdout.columns ?? 80
  const controller = getSessionTuiController(session)
  const pauseInput = options?.pauseInput
  const resumeInput = options?.resumeInput
  const withContentLayout = (text: string): string =>
    isTty && !controller
      ? prefixTuiContentBlock(text, { columns })
      : text
  const writeSlashOutput = (text: string) => {
    const line = text.endsWith('\n') ? text : `${text}\n`
    writeOut(withContentLayout(line))
  }
  const runInteractivePicker = async (picker: {
    mode: 'provider' | 'effort'
    items: ArrowPickItem[]
    title: string
    initialIndex?: number
  }): Promise<ArrowPickResult> => {
    if (controller) {
      return await controller.runPickerOverlay({
        ...picker,
        ...(options?.signal ? { signal: options.signal } : {}),
      })
    }
    await pauseInput?.()
    try {
      return await runArrowPicker({
        items: picker.items,
        writeOut,
        isTty: true,
        title: picker.title,
        initialIndex: picker.initialIndex,
      })
    } finally {
      await resumeInput?.()
    }
  }
  const printer = getSessionEventPrinter(session)
  let terminalReason = 'failed'
  printer?.beginTurn({
    prompt,
    echoUser: true,
    activity: !prompt.trimStart().startsWith('/'),
  })
  const before = session.messages.length
  try {
    const result = await submitUserInput(session, prompt, {
      signal: options?.signal,
      turnId: options?.turnId,
      querySource: options?.querySource,
    })

    if (result.type === 'empty') {
      terminalReason = 'empty'
      return { terminalReason: 'empty', assistantText: '' }
    }

    if (result.type === 'slash') {
      terminalReason = 'slash'
      if (
        result.contextView &&
        isTty
      ) {
        const rendered = renderContextDashboard({
          view: result.contextView,
          columns: resolveTuiContentColumns(columns),
          color:
            options?.color ??
            (process.env.NO_COLOR === undefined &&
              process.env.BOLO_THEME?.trim().toLowerCase() !== 'plain'),
        })
        writeSlashOutput(rendered.text)
        return {
          terminalReason: 'slash',
          assistantText: result.message,
        }
      }
      // U1：TTY 且 /diff 请求面板 → 交互 diffPane；失败回落文本
      if (
        result.interactiveDiff &&
        isTty &&
        process.env.BOLO_DIFF_PANEL !== '0'
      ) {
        try {
          const { buildDiffViewModelFromLog } = await import(
            '../../core/src/diffViewModel.ts'
          )
          const vm = buildDiffViewModelFromLog(session.fileDiffLog, {
            lastTurn: result.interactiveDiff.mode === 'last',
            pathFilter: result.interactiveDiff.pathFilter,
          })
          if (vm.files.length) {
            const pane = controller
              ? await controller.runDiffOverlay({
                  mode: 'browse',
                  model: vm,
                  ...(options?.signal ? { signal: options.signal } : {}),
                })
              : await (async () => {
                  const { runDiffPane } = await import('./tui/diffPane.ts')
                  await pauseInput?.()
                  try {
                    return await runDiffPane({
                      model: vm,
                      writeOut,
                      isTty: true,
                      signal: options?.signal,
                    })
                  } finally {
                    await resumeInput?.()
                  }
                })()
            if (pane.ok) {
              return {
                terminalReason: 'slash',
                assistantText: '(diff panel closed)',
              }
            }
          }
        } catch {
          /* fall through to text dump */
        }
      }

      // P 轨 UX：TTY 且 /provider 无参 → 箭头选后端并热切
      if (
        result.interactiveProvider?.mode === 'pick' &&
        isTty &&
        process.env.BOLO_PROVIDER_PANEL !== '0' &&
        process.env.BOLO_ARROW_PICKER !== '0'
      ) {
        try {
          const items = buildProviderPickerItems(session)
          if (items.length) {
            const ar = await runInteractivePicker({
              mode: 'provider',
              items,
              title: 'Select provider (↑/↓ · Enter · q cancel)',
              initialIndex: activeProviderPickerIndex(session),
            })
            if (ar.ok) {
              const sw = switchSessionProvider(session, ar.id)
              const out = sw.ok ? sw.message : sw.reason
              writeSlashOutput(out)
              return { terminalReason: 'slash', assistantText: out }
            }
            if (ar.reason === 'cancel') {
              const msg = 'provider pick cancelled'
              writeSlashOutput(msg)
              return { terminalReason: 'slash', assistantText: msg }
            }
            // unsupported → fall through to text list
          }
        } catch {
          /* fall through to text dump */
        }
      }

      // E8：TTY 且 /effort 无参 → 箭头选推理强度
      if (
        result.interactiveEffort?.mode === 'pick' &&
        isTty &&
        process.env.BOLO_EFFORT_PANEL !== '0' &&
        process.env.BOLO_ARROW_PICKER !== '0'
      ) {
        try {
          const {
            buildEffortPickerItems,
            activeEffortPickerIndex,
            detectEffortDialectId,
            formatEffortCapabilityStatus,
          } = await import('../../providers/src/effortDialect.ts')
          const dialect =
            session.effortDialect ??
            session.providerProfile?.effortDialect ??
            detectEffortDialectId({
              kind: session.provider?.id,
              baseUrl: session.providerProfile?.baseUrl,
              model: session.model ?? session.providerProfile?.model,
            })
          const model = session.model ?? session.providerProfile?.model
          const items = buildEffortPickerItems({
            dialect: dialect as string | undefined,
            model,
            isAgent: true,
            effortLevel: session.effortLevel,
          })
          if (items.length) {
            const ar = await runInteractivePicker({
              mode: 'effort',
              items,
              title: 'Select effort (↑/↓ · Enter · q cancel)',
              initialIndex: activeEffortPickerIndex({
                dialect: dialect as string | undefined,
                model,
                isAgent: true,
                effortLevel: session.effortLevel,
              }),
            })
            if (ar.ok) {
              if (ar.id === 'auto') {
                session.effortLevel = undefined
              } else {
                session.effortLevel = ar.id
              }
              const out =
                (ar.id === 'auto'
                  ? 'effort set to auto\n'
                  : `effort set to ${ar.id}\n`) +
                formatEffortCapabilityStatus({
                  effortLevel: ar.id === 'auto' ? 'auto' : ar.id,
                  dialect: dialect as string | undefined,
                  isAgent: true,
                  model,
                })
              writeSlashOutput(out)
              return { terminalReason: 'slash', assistantText: out }
            }
            if (ar.reason === 'cancel') {
              const msg = 'effort pick cancelled'
              writeSlashOutput(msg)
              return { terminalReason: 'slash', assistantText: msg }
            }
          }
        } catch {
          /* fall through to text dump */
        }
      }

      const msg = result.message
      writeSlashOutput(msg)
      return { terminalReason: 'slash', assistantText: msg }
    }

    const terminal = result.terminal
    terminalReason = terminal.reason
    const assistantText = lastAssistantText(session.messages, before)
    // T4：已流式打印 text 则不再整段回放；未流式则整段输出
    if (assistantText && !printer?.didStreamText()) {
      const output = assistantText.endsWith('\n')
        ? assistantText
        : `${assistantText}\n`
      writeOut(withContentLayout(output))
    }
    if (terminal.reason !== 'completed') {
      const detail = terminal.detail ? `: ${terminal.detail}` : ''
      writeErr(
        withContentLayout(
          `warn: turn ended with ${terminal.reason}${detail}\n`,
        ),
      )
    }
    return { terminalReason: terminal.reason, assistantText }
  } finally {
    printer?.endTurn({ terminalReason })
    if (controller) {
      try {
        await controller.flush()
      } catch (error) {
        if (
          terminalReason === 'completed' ||
          terminalReason === 'slash' ||
          terminalReason === 'empty'
        ) {
          throw error
        }
      }
    }
  }
}

export type QueuedReplPrompt = {
  controlId: string
  prompt: string
  turnId: string
  querySource: string
}

/**
 * 只在 runner idle 时取一条 ready queue；取出即 promoted，绝不重放。
 */
export async function takeNextQueuedReplPrompt(
  session: BoloSession,
): Promise<QueuedReplPrompt | null> {
  const taken = await takeNextSessionQueued(session)
  if (taken.persistenceWarning) {
    session.onEvent({
      type: 'error',
      message: taken.persistenceWarning,
    })
  }
  const control = taken.control
  if (
    !control ||
    control.kind !== 'queue' ||
    !control.prompt ||
    !control.turnId
  ) {
    return null
  }
  return {
    controlId: control.controlId,
    prompt: control.prompt,
    turnId: control.turnId,
    querySource: control.querySource ?? 'cli_turn_queue',
  }
}

/** Interactive REPL with a real TTY input surface and a plain fallback. */
export async function runRepl(
  session: BoloSession,
  options?: {
    writeOut?: (s: string) => void
    writeErr?: (s: string) => void
    isTty?: boolean
    /** 外部关闭信号；active turn 时取消，idle 时退出 REPL */
    signal?: AbortSignal
  },
): Promise<void> {
  const writeOut = options?.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = options?.writeErr ?? ((s) => process.stderr.write(s))
  const isTty = options?.isTty ?? process.stdin.isTTY === true
  const dynamicTui = shouldUseDynamicTui({ isTty })
  const controller = dynamicTui
    ? getSessionTuiController(session)
    : undefined
  const surface = dynamicTui && !controller
    ? getSessionTerminalSurface(session)
    : undefined
  const runtimeOut =
    controller?.writeOutput ?? surface?.writeOutput ?? writeOut
  const runtimeErr =
    controller?.writeError ?? surface?.writeError ?? writeErr
  const color =
    process.env.NO_COLOR === undefined &&
    process.env.BOLO_THEME?.trim().toLowerCase() !== 'plain'
  const history: string[] = []
  const rl = dynamicTui
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: isTty,
      })
  if (!dynamicTui) {
    writeOut(
      'Interactive mode (/exit to quit). Type /help for commands.\n',
    )
  } else if (!controller) {
    writeOut('\n')
  }

  let replClosed = false
  const question = (
    q: string,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    if (!rl || replClosed || signal?.aborted) return Promise.resolve(null)
    return new Promise<string | null>((resolve, reject) => {
      let settled = false
      const finish = (answer: string | null) => {
        if (settled) return
        settled = true
        rl.removeListener('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onClose = () => finish(null)
      const onAbort = () => finish(null)
      rl.once('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal) {
          rl.question(q, { signal }, (answer) => finish(answer))
        } else {
          rl.question(q, (answer) => finish(answer))
        }
      } catch (error) {
        rl.removeListener('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted || replClosed) {
          finish(null)
        } else {
          reject(error)
        }
      }
    })
  }

  // Plain fallback shares readline with permission prompts. Dynamic input is
  // short-lived and has already released stdin before a turn starts.
  const pauseRl = () => {
    if (!rl) return
    try {
      rl.pause()
    } catch {
      /* ignore */
    }
  }
  const resumeRl = () => {
    if (!rl) return
    try {
      rl.resume()
    } catch {
      /* ignore */
    }
  }
  const pauseInteractiveSurface: () => void | Promise<void> = dynamicTui
    ? controller
      ? () => undefined
      : () => surface?.suspend()
    : pauseRl
  const resumeInteractiveSurface: () => void | Promise<void> = dynamicTui
    ? controller
      ? () => undefined
      : () => surface?.resume()
    : resumeRl
  let activeTurn: AbortController | null = null
  const interrupt = async () => {
    if (activeTurn && !activeTurn.signal.aborted) {
      const snapshot = session.coordinator.snapshot(session.id)
      if (snapshot.state === 'running') {
        const result = await requestSessionControl(session, {
          controlId: `control_${randomUUID().replaceAll('-', '')}`,
          kind: 'interrupt',
          sessionId: session.id,
          expectedTurnId: snapshot.active.turnId,
        })
        if (result.ok) {
          runtimeErr(`^C turn interrupt requested (${snapshot.active.turnId})\n`)
          if (result.persistenceWarning) {
            runtimeErr(`warning: ${result.persistenceWarning}\n`)
          }
          return
        }
      }
      // ownership 前的极短窗口或本地 slash 面板：回退本地 signal。
      activeTurn.abort('interrupt')
      runtimeErr('^C turn cancelled\n')
      return
    }
    replClosed = true
    runtimeOut('^C\n')
    rl?.close()
  }
  const onSigint = () => {
    void interrupt()
  }
  if (dynamicTui) process.on('SIGINT', onSigint)
  else rl?.on('SIGINT', onSigint)
  const onExternalAbort = () => {
    void interrupt()
  }
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true })

  let bodyFailed = false
  try {
    while (!replClosed) {
      if (controller) configureSessionComposer(controller, session, history)
      const queued = await takeNextQueuedReplPrompt(session)
      let text: string
      if (queued) {
        text = queued.prompt
        if (!dynamicTui) {
          writeOut(`[queued ${queued.controlId}] ${text}\n`)
        }
      } else if (controller) {
        const input = await controller.readInput({
          ...(options?.signal ? { signal: options.signal } : {}),
        })
        if (input.type !== 'submit') {
          replClosed = true
          runtimeOut(input.type === 'exit' ? '^C\n' : '\n')
          break
        }
        text = input.value.trim()
        if (!text) continue
        if (text === '/exit' || text === '/quit') {
          replClosed = true
          runtimeOut('Session closed.\n')
          break
        }
        if (history[history.length - 1] !== text) history.push(text)
        if (history.length > 100) history.shift()
      } else if (dynamicTui) {
        await pauseInteractiveSurface()
        let input
        try {
          input = await readTuiInput({
            writeOut: runtimeOut,
            columns: process.stdout.columns,
            color,
            history,
            slashCandidates: getCliSlashCommandCandidates(session),
            signal: options?.signal,
            status: {
              permissionMode: session.permissionMode,
              providerId: session.providerId,
              providerKind: session.provider?.id,
              model: session.model,
              effortLevel: session.effortLevel,
              ...(session.usage ? { usage: session.usage } : {}),
            },
          })
        } finally {
          await resumeInteractiveSurface()
        }
        if (input.type !== 'submit') {
          replClosed = true
          runtimeOut(input.type === 'exit' ? '^C\n' : '\n')
          break
        }
        text = input.value.trim()
        if (!text) continue
        if (text === '/exit' || text === '/quit') {
          replClosed = true
          runtimeOut('Session closed.\n')
          break
        }
        if (history[history.length - 1] !== text) history.push(text)
        if (history.length > 100) history.shift()
      } else {
        const line = await question('bolo> ', options?.signal)
        if (line == null) break
        text = line.trim()
        if (!text) continue
        if (text === '/exit' || text === '/quit') break
      }
      const turnController = new AbortController()
      activeTurn = turnController
      const onParentAbort = () => turnController.abort('parent')
      options?.signal?.addEventListener('abort', onParentAbort, { once: true })
      if (surface) {
        const runningComposer = renderTuiInputBox({
          state: createTuiInputState(),
          columns: process.stdout.columns,
          color,
          mode: 'running',
          status: {
            permissionMode: session.permissionMode,
            providerId: session.providerId,
            providerKind: session.provider?.id,
            model: session.model,
            effortLevel: session.effortLevel,
            ...(session.usage ? { usage: session.usage } : {}),
          },
        })
        surface.setDock({
          lines: runningComposer.lines,
          cursorRow: runningComposer.cursorRow,
          cursorColumn: runningComposer.cursorColumn,
          showCursor: false,
        })
      }
      session.askPermission = createTtyAskPermission({
        isTty,
        ...(dynamicTui
          ? {}
          : {
              readAnswer: async (prompt: string) =>
                (await question(prompt, turnController.signal)) ?? '',
            }),
        nonTtyDecision: 'deny',
        writeOut: runtimeOut,
        ...(controller
          ? {
              runPermissionOverlay: controller.runPermissionOverlay,
              runDiffOverlay: controller.runDiffOverlay,
            }
          : {}),
        ...(!controller
          ? {
              pauseInput: pauseInteractiveSurface,
              resumeInput: resumeInteractiveSurface,
              suspendTextPrompt: dynamicTui,
            }
          : {}),
        signal: turnController.signal,
        onInterrupt: () => turnController.abort('interrupt'),
      })
      try {
        await runOnePrompt(session, text, {
          writeOut: runtimeOut,
          writeErr: runtimeErr,
          isTty,
          columns: process.stdout.columns,
          color,
          ...(!controller
            ? {
                pauseInput: pauseInteractiveSurface,
                resumeInput: resumeInteractiveSurface,
              }
            : {}),
          signal: turnController.signal,
          ...(queued
            ? {
                turnId: queued.turnId,
                querySource: queued.querySource,
              }
            : {}),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        runtimeErr(`error: ${msg}\n`)
      } finally {
        surface?.clearDock()
        options?.signal?.removeEventListener('abort', onParentAbort)
        if (activeTurn === turnController) activeTurn = null
      }
    }
  } catch (error) {
    bodyFailed = true
    throw error
  } finally {
    try {
      await runAsyncCleanupSteps([
        () => {
          replClosed = true
        },
        () => {
          if (activeTurn && !activeTurn.signal.aborted) {
            activeTurn.abort('repl_closed')
          }
        },
        () => {
          if (dynamicTui) process.removeListener('SIGINT', onSigint)
          else rl?.removeListener('SIGINT', onSigint)
        },
        () => options?.signal?.removeEventListener('abort', onExternalAbort),
        () => surface?.dispose(),
        () => controller?.stop(),
        () => rl?.close(),
        async () => {
          // H0：REPL 正常退出 → SessionEnd；session teardown 仍为 best effort。
          try {
            const { endSession } = await import('../../core/src/index.ts')
            await endSession(session, { reason: 'prompt_input_exit' })
          } catch {
            /* teardown 失败不抛 */
          }
        },
      ])
    } catch (cleanupError) {
      if (!bodyFailed) throw cleanupError
    }
  }
}

/**
 * CLI 主流程：可选 picker → resume → 摘要 → prompt / print / repl
 */
export async function runResumeCli(
  opts: ResumeCliOptions,
): Promise<ResumeCliResult> {
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))
  const cwd = opts.cwd ?? process.cwd()

  let idOrPath: string
  if (opts.idOrPath === undefined || opts.idOrPath === true) {
    idOrPath = await pickProjectSessionId({
      cwd,
      sessionsDir: opts.sessionsDir,
      isTty: opts.isTty,
      writeOut,
      writeErr,
      readChoice: opts.readChoice,
    })
  } else {
    idOrPath = opts.idOrPath
  }

  const result = await resumeFromIdOrPath({
    ...opts,
    idOrPath,
    cwd,
    writeErr,
  })

  const prompt = opts.prompt?.trim()
  const print = opts.print === true
  const isTty = opts.isTty ?? process.stdin.isTTY === true
  const interactive =
    !print && !prompt && isTty
  const dynamicTui = interactive && shouldUseDynamicTui({ isTty })
  const controller = getSessionTuiController(result.session)

  if (controller) {
    const active =
      result.session.providerId != null
        ? `${result.session.providerId}/${result.session.model ?? result.session.provider?.id ?? '?'}`
        : result.session.model
    controller.configureWelcome({
      version: '0.0.1',
      headline: 'Welcome back.',
      cwd: result.session.cwd,
      model: active,
      sessionId: result.session.id,
      messagePreview: result.summary.lastMessage
        ? [
            `resumed ${result.summary.messageCount} messages · ${result.summary.lastMessage.preview}`,
          ]
        : [`resumed ${result.summary.messageCount} messages`],
      hint: '/help commands · /provider model',
    })
    await controller.start()
  } else if (dynamicTui) {
    const active =
      result.session.providerId != null
        ? `${result.session.providerId}/${result.session.model ?? result.session.provider?.id ?? '?'}`
        : result.session.model
    const layout = renderInkLayout({
      version: '0.0.1',
      headline: 'Welcome back.',
      cwd: result.session.cwd,
      model: active,
      sessionId: result.session.id,
      messagePreview: result.summary.lastMessage
        ? [
            `resumed ${result.summary.messageCount} messages · ${result.summary.lastMessage.preview}`,
          ]
        : [`resumed ${result.summary.messageCount} messages`],
      hint: '/help commands · /provider model',
    })
    writeOut(layout.endsWith('\n') ? layout : `${layout}\n`)
  } else {
    // Non-interactive output remains stable and machine-readable line by line.
    writeOut(
      `${renderWelcomeBanner({
        condensed: true,
        sessionId: result.session.id,
        model: result.session.model,
        version: '0.0.1',
      })}\n`,
    )
    writeOut(`${formatSessionSummary(result.summary)}\n`)
    writeOut(`${formatSessionStatusLine(result.session)}\n`)
  }

  if (prompt) {
    return runWithAsyncCleanup(
      async () => {
        const turn = await runOnePrompt(result.session, prompt, {
          writeOut: controller?.writeOutput ?? writeOut,
          writeErr: controller?.writeError ?? writeErr,
          isTty,
          columns: process.stdout.columns,
          signal: opts.signal,
        })
        result.terminalReason = turn.terminalReason
        return result
      },
      [
        () => controller?.stop(),
        async () => {
          try {
            const { endSession } = await import('../../core/src/index.ts')
            await endSession(result.session, { reason: 'other' })
          } catch {
            /* ignore */
          }
        },
      ],
    )
  }

  if (interactive) {
    await runRepl(result.session, {
      writeOut,
      writeErr,
      signal: opts.signal,
    })
    return result
  }

  // --print 且无 prompt：仅摘要后结束
  return runWithAsyncCleanup(
    async () => result,
    [
      () => controller?.stop(),
      async () => {
        try {
          const { endSession } = await import('../../core/src/index.ts')
          await endSession(result.session, { reason: 'other' })
        } catch {
          /* ignore */
        }
      },
    ],
  )
}
