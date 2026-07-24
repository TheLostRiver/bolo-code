/**
 * resume 接线：load/resumeSession + 摘要 + 可选单轮 submit / 极简 REPL
 * 无 id 时 listProjectSessions → TTY 选择 / 非 TTY 列表
 * T4 流式 text/tool 行；T5 TTY 权限 y/N；T6 slash 经 submitUserInput
 */

import * as readline from 'node:readline'
import {
  listProjectSessions,
  resumeSession,
  submitUserInput,
  type BoloSession,
  type SessionEvent,
  type SessionListItem,
  type SessionSnapshot,
} from '../../core/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import { createCliProvider } from './provider.ts'
import { createTtyAskPermission } from './tui/askPermissionTty.ts'
import { renderWelcomeBanner } from './tui/banner.ts'
import {
  createSessionEventPrinter,
  type SessionEventPrinter,
} from './tui/formatSessionEvent.ts'
import { formatSessionStatusLine } from './tui/statusLine.ts'

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
    ' #  id                          msgs  updated              preview'
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
    const prev = (it.preview || '(no user message)').slice(0, 52)
    const model = it.model ? `  [${it.model}]` : ''
    return `${n}  ${id}  ${msgs}  ${when}  ${prev}${model}`
  })
  return [header, ...rows].join('\n')
}

/**
 * RS8：按 id 子串或 preview 过滤（大小写不敏感）。
 * 空 query → 原列表。
 */
export function filterSessionListItems(
  items: SessionListItem[],
  query: string,
): SessionListItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((it) => {
    const hay = `${it.id} ${it.preview} ${it.model ?? ''}`.toLowerCase()
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
 * `--continue` / `-c`：取 listProjectSessions 第一条（已按 mtime/updatedAt 降序）。
 * 空列表 → exit 1（与 picker 一致）。
 */
export async function resolveContinueSessionId(opts: {
  cwd: string
  sessionsDir?: string
}): Promise<string> {
  const items = await listProjectSessions({
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
    limit: 1,
  })
  if (items.length === 0) {
    throw new ResumePickerError(
      'No sessions in this project. Start a new session with: bolo',
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
}): Promise<string> {
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))
  let items = await listProjectSessions({
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
  })

  if (items.length === 0) {
    throw new ResumePickerError(
      'No sessions in this project. Start a new session with: bolo',
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
    // 过滤多命中：展示缩小列表再选
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

/**
 * 组装 CLI onEvent：T4 打印机 + 可选测试钩子
 */
export function createCliOnEvent(opts: {
  writeOut: (s: string) => void
  writeErr: (s: string) => void
  onSessionEvent?: (e: SessionEvent) => void
  onEvent?: (line: string) => void
}): {
  printer: SessionEventPrinter
  onEvent: (e: SessionEvent) => void
} {
  const printer = createSessionEventPrinter({
    writeOut: opts.writeOut,
    writeErr: opts.writeErr,
  })
  return {
    printer,
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
  const { provider, missingKey, kind, model } = createCliProvider({
    forceMock: opts.forceMock,
  })
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))
  const isTty = opts.isTty ?? process.stdin.isTTY === true

  const { printer, onEvent } = createCliOnEvent({
    writeOut,
    writeErr,
    onSessionEvent: opts.onSessionEvent,
    onEvent: opts.onEvent,
  })

  const askPermission = createTtyAskPermission({
    isTty,
    readAnswer: opts.readPermissionAnswer,
    nonTtyDecision: opts.nonTtyPermission ?? 'deny',
  })

  const { session, snapshot, path: filePath } = await resumeSession({
    idOrPath: opts.idOrPath,
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
    provider,
    reassembleSystem: opts.reassembleSystem,
    systemPrompt: opts.systemPrompt,
    create: model ? { model } : undefined,
    autoSave: true,
    onEvent,
    askPermission,
  })

  attachSessionEventPrinter(session, printer)

  // 快照加载成功后再提示无 key（callModel 时才会失败）
  if (missingKey) {
    writeErr(
      `warn: no API key (provider=${kind}); snapshot loaded OK, callModel will fail until keys are set.\n`,
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
  },
): Promise<{ terminalReason: string; assistantText: string }> {
  const writeOut = options?.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = options?.writeErr ?? ((s) => process.stderr.write(s))
  const printer = getSessionEventPrinter(session)
  printer?.beginTurn()
  const before = session.messages.length
  try {
    const result = await submitUserInput(session, prompt)

    if (result.type === 'empty') {
      return { terminalReason: 'empty', assistantText: '' }
    }

    if (result.type === 'slash') {
      const msg = result.message
      writeOut(msg.endsWith('\n') ? msg : `${msg}\n`)
      return { terminalReason: 'slash', assistantText: msg }
    }

    const terminal = result.terminal
    const assistantText = lastAssistantText(session.messages, before)
    // T4：已流式打印 text 则不再整段回放；未流式则整段输出
    if (assistantText && !printer?.didStreamText()) {
      writeOut(
        assistantText.endsWith('\n') ? assistantText : `${assistantText}\n`,
      )
    }
    if (terminal.reason !== 'completed') {
      const detail = terminal.detail ? `: ${terminal.detail}` : ''
      writeErr(`warn: turn ended with ${terminal.reason}${detail}\n`)
    }
    return { terminalReason: terminal.reason, assistantText }
  } finally {
    printer?.endTurn()
  }
}

/**
 * 极简 REPL：一行输入 → submitUserInput（含 slash）→ 流式/工具行
 * 每次 prompt 前打印 T3 状态行；权限 ask 共用同一 readline。
 */
export async function runRepl(
  session: BoloSession,
  options?: {
    writeOut?: (s: string) => void
    writeErr?: (s: string) => void
    isTty?: boolean
  },
): Promise<void> {
  const writeOut = options?.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = options?.writeErr ?? ((s) => process.stderr.write(s))
  writeOut(
    'Interactive mode (empty line or /exit to quit). Type /help for commands.\n',
  )

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  const question = (q: string) =>
    new Promise<string>((resolve) => {
      rl.question(q, resolve)
    })

  // T5：REPL 内权限与输入共用 readline，避免双 Interface 抢 stdin
  const isTty = options?.isTty ?? process.stdin.isTTY === true
  session.askPermission = createTtyAskPermission({
    isTty,
    readAnswer: question,
    nonTtyDecision: 'deny',
  })

  try {
    for (;;) {
      writeOut(`${formatSessionStatusLine(session)}\n`)
      const line = await question('bolo> ')
      const text = line.trim()
      if (!text || text === '/exit' || text === '/quit') break
      try {
        await runOnePrompt(session, text, { writeOut, writeErr })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        writeErr(`error: ${msg}\n`)
      }
    }
  } finally {
    rl.close()
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

  // T7：resume 后缩略一行 BOLO + id
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

  const prompt = opts.prompt?.trim()
  const print = opts.print === true
  const interactive =
    !print && !prompt && process.stdin.isTTY === true

  if (prompt) {
    const turn = await runOnePrompt(result.session, prompt, {
      writeOut,
      writeErr,
    })
    result.terminalReason = turn.terminalReason
    return result
  }

  if (interactive) {
    await runRepl(result.session, { writeOut, writeErr })
    return result
  }

  // --print 且无 prompt：仅摘要
  return result
}