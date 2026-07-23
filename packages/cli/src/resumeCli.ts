/**
 * resume 接线：load/resumeSession + 摘要 + 可选单轮 submit / 极简 REPL
 */

import * as readline from 'node:readline'
import {
  resumeSession,
  submitPrompt,
  type BoloSession,
  type SessionSnapshot,
} from '../../core/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import { createCliProvider } from './provider.ts'

export type ResumeCliOptions = {
  idOrPath: string
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
  opts: ResumeCliOptions,
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
  const before = session.messages.length
  const terminal = await submitPrompt(session, prompt)
  const assistantText = lastAssistantText(session.messages, before)
  if (assistantText) {
    writeOut(assistantText.endsWith('\n') ? assistantText : `${assistantText}\n`)
  }
  if (terminal.reason !== 'completed') {
    const detail = terminal.detail ? `: ${terminal.detail}` : ''
    options?.writeErr?.(
      `warn: turn ended with ${terminal.reason}${detail}\n`,
    )
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
  writeOut('Interactive mode (empty line or /exit to quit).\n')

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
 * CLI 主流程：resume → 摘要 → prompt / print / repl
 */
export async function runResumeCli(
  opts: ResumeCliOptions,
): Promise<ResumeCliResult> {
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s))

  const result = await resumeFromIdOrPath({ ...opts, writeErr })
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