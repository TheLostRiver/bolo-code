/**
 * resume 接线：load/resumeSession + 摘要 + 可选单轮 submit / 极简 REPL
 * 无 id 时 listProjectSessions → TTY 选择 / 非 TTY 列表
 */

import * as readline from 'node:readline'
import {
  listProjectSessions,
  resumeSession,
  submitUserInput,
  type BoloSession,
  type SessionListItem,
  type SessionSnapshot,
} from '../../core/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import { createCliProvider } from './provider.ts'
import { renderWelcomeBanner } from './tui/banner.ts'

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
  onEvent?: (line: string) => void
  /** 注入 stdout 便于测试 */
  writeOut?: (s: string) => void
  writeErr?: (s: string) => void
  /**
   * 是否 TTY（选择器）。默认 process.stdin.isTTY。
   * 测试可强制 false。
   */
  isTty?: boolean
  /**
   * 注入选择器输入（测试用，返回 1-based 编号字符串）。
   * 未注入时用 readline。
   */
  readChoice?: (prompt: string) => Promise<string>
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

/** 编号列表（stdout） */
export function formatSessionList(items: SessionListItem[]): string {
  if (!items.length) return '(no sessions)'
  return items
    .map((it, i) => {
      const n = String(i + 1).padStart(2, ' ')
      const when = it.updatedAt.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
      const model = it.model ? `  model=${it.model}` : ''
      const prev = it.preview || '(no user message)'
      return `${n}. ${it.id}  msgs=${it.messageCount}  ${when}${model}\n    ${prev}`
    })
    .join('\n')
}

/**
 * 无 id：列项目会话并选 id。
 * - 空列表 → exit 1
 * - 非 TTY → 打印列表，要求 --resume <id>，exit 2
 * - TTY → 问编号，返回选中 id
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
  const items = await listProjectSessions({
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
  })

  if (items.length === 0) {
    throw new ResumePickerError(
      'No sessions in this project. Start a new session with: bolo',
      1,
    )
  }

  const listText = formatSessionList(items)
  writeOut(`${listText}\n`)

  const isTty = opts.isTty ?? process.stdin.isTTY === true
  if (!isTty) {
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

  for (;;) {
    const raw = (await readChoice(`Select session [1-${items.length}]: `)).trim()
    if (!raw) {
      writeErr('Please enter a number.\n')
      continue
    }
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 1 || n > items.length) {
      writeErr(`Invalid choice. Enter 1–${items.length}.\n`)
      continue
    }
    return items[n - 1]!.id
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

/**
 * 仅加载并 resume（不跑 prompt）— 测试与 CLI 共用
 */
export async function resumeFromIdOrPath(
  opts: ResumeCliOptions & { idOrPath: string },
): Promise<ResumeCliResult> {
  const { provider, missingKey, kind, model } = createCliProvider({
    forceMock: opts.forceMock,
  })
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))

  const { session, snapshot, path: filePath } = await resumeSession({
    idOrPath: opts.idOrPath,
    cwd: opts.cwd,
    sessionsDir: opts.sessionsDir,
    provider,
    reassembleSystem: opts.reassembleSystem,
    systemPrompt: opts.systemPrompt,
    create: model ? { model } : undefined,
    autoSave: true,
    onEvent: (e) => {
      if (e.type === 'text' && e.text) {
        opts.onEvent?.(e.text)
      }
      if (e.type === 'error') {
        writeErr(`error: ${e.message}\n`)
      }
    },
    askPermission: async () => 'allow',
  })

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
  const before = session.messages.length
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
  if (assistantText) {
    writeOut(assistantText.endsWith('\n') ? assistantText : `${assistantText}\n`)
  }
  if (terminal.reason !== 'completed') {
    const detail = terminal.detail ? `: ${terminal.detail}` : ''
    writeErr(`warn: turn ended with ${terminal.reason}${detail}\n`)
  }
  return { terminalReason: terminal.reason, assistantText }
}

/**
 * 极简 REPL：一行输入 → submit → 打印
 */
export async function runRepl(
  session: BoloSession,
  options?: {
    writeOut?: (s: string) => void
    writeErr?: (s: string) => void
  },
): Promise<void> {
  const writeOut = options?.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = options?.writeErr ?? ((s) => process.stderr.write(s))
  writeOut('Interactive mode (empty line or /exit to quit). Type /help for commands.\n')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  const question = (q: string) =>
    new Promise<string>((resolve) => {
      rl.question(q, resolve)
    })

  try {
    for (;;) {
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