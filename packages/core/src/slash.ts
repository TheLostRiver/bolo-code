/**
 * 斜杠命令总线（最小）
 * 对照 HC：行首 `/` 为命令；`//` 不当命令；不调 LLM。
 * 无遥测。不依赖 core/index 顶层导入（避免循环）。
 */

import {
  isPermissionMode,
  PERMISSION_MODES,
  PERMISSION_MODE_META,
  type PermissionMode,
} from '../../permissions/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { CompactSummarizer } from '../../compact/src/index.ts'
import type { Terminal } from './queryLoop.ts'

/** slash 需要的会话切片（与 BoloSession 兼容） */
export type SlashSession = {
  id: string
  cwd: string
  messages: ChatMessage[]
  systemPromptSections: string[]
  permissionMode: PermissionMode
  model?: string
  effortLevel?: string
  compactSummarizer?: CompactSummarizer
}

export type ParseSlashResult =
  | { kind: 'command'; name: string; args: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'empty' }

export type SlashDispatchResult = {
  message: string
  ok: boolean
}

export type SubmitUserInputResult =
  | { type: 'slash'; message: string }
  | { type: 'prompt'; terminal: Terminal }
  | { type: 'empty' }

export type SlashCommandDef = {
  name: string
  summary: string
  usage?: string
  run: (
    session: SlashSession,
    args: string,
  ) => Promise<SlashDispatchResult> | SlashDispatchResult
}

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
  'auto',
] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v)
}

/**
 * 解析一行用户输入。
 * - 空 → empty
 * - 行首 `/` 且非 `//` → command
 * - 其余 → prompt（含 `//` 前缀）
 */
export function parseSlashLine(text: string): ParseSlashResult {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'empty' }

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    const body = trimmed.slice(1)
    const m = /^([^\s]+)(?:\s+(.*))?$/s.exec(body)
    if (!m || !m[1]) {
      return { kind: 'prompt', text: text }
    }
    const name = m[1].toLowerCase()
    const args = (m[2] ?? '').trim()
    return { kind: 'command', name, args }
  }

  return { kind: 'prompt', text: text }
}

function approxChars(session: SlashSession): number {
  let n = 0
  for (const msg of session.messages) {
    n += (msg.content ?? '').length
  }
  for (const s of session.systemPromptSections) {
    n += s.length
  }
  return n
}

function formatHelp(): string {
  const lines = ['Slash commands:', '']
  for (const c of SLASH_COMMANDS) {
    const usage = c.usage ? ` ${c.usage}` : ''
    lines.push(`  /${c.name}${usage}`)
    lines.push(`    ${c.summary}`)
  }
  lines.push('')
  lines.push('Tip: lines starting with // are normal prompts, not commands.')
  return lines.join('\n')
}

async function cmdHelp(
  _session: SlashSession,
  _args: string,
): Promise<SlashDispatchResult> {
  return { ok: true, message: formatHelp() }
}

function cmdClear(session: SlashSession, _args: string): SlashDispatchResult {
  const n = session.messages.length
  session.messages.length = 0
  return {
    ok: true,
    message: `Cleared ${n} conversation message(s). Session id/cwd/config and system prompt sections kept.`,
  }
}

async function cmdCompact(
  session: SlashSession,
  args: string,
): Promise<SlashDispatchResult> {
  if (!session.compactSummarizer) {
    return {
      ok: false,
      message:
        'compact failed: no summarizer on session (inject CompactSummarizer; see docs/COMPACTION.md).',
    }
  }
  // 延迟导入，避免与 core/index 循环依赖
  const { compactSession } = await import('./index.ts')
  const note = args.trim() || undefined
  const r = await compactSession(session as Parameters<typeof compactSession>[0], {
    trigger: 'manual',
    customInstructions: note,
  })
  if (!r.ok) {
    return {
      ok: false,
      message: `compact failed: ${r.reason ?? 'unknown'}`,
    }
  }
  return {
    ok: true,
    message: note
      ? `Compacted conversation (note: ${note}).`
      : 'Compacted conversation.',
  }
}

function cmdContext(session: SlashSession, _args: string): SlashDispatchResult {
  const lines = [
    `id:              ${session.id}`,
    `cwd:             ${session.cwd}`,
    `messages:        ${session.messages.length}`,
    `chars (approx):  ${approxChars(session)}`,
    `permissionMode:  ${session.permissionMode}`,
    `model:           ${session.model ?? '(unset)'}`,
    `effort:          ${session.effortLevel ?? 'auto'}`,
    `system sections: ${session.systemPromptSections.length}`,
  ]
  return { ok: true, message: lines.join('\n') }
}

function cmdModel(session: SlashSession, args: string): SlashDispatchResult {
  const name = args.trim()
  if (!name) {
    return {
      ok: true,
      message: `model: ${session.model ?? '(unset)'}`,
    }
  }
  session.model = name
  return { ok: true, message: `model set to ${name}` }
}

function cmdEffort(session: SlashSession, args: string): SlashDispatchResult {
  const raw = args.trim().toLowerCase()
  if (!raw) {
    return {
      ok: true,
      message: `effort: ${session.effortLevel ?? 'auto'} (session field; no provider mapping yet)`,
    }
  }
  if (!isEffortLevel(raw)) {
    return {
      ok: false,
      message: `unknown effort "${args.trim()}". Use: ${EFFORT_LEVELS.join('|')}`,
    }
  }
  if (raw === 'auto') {
    session.effortLevel = undefined
    return { ok: true, message: 'effort set to auto (cleared session override)' }
  }
  session.effortLevel = raw
  return { ok: true, message: `effort set to ${raw}` }
}

function cmdPlan(session: SlashSession, _args: string): SlashDispatchResult {
  session.permissionMode = 'plan'
  return { ok: true, message: 'permissionMode set to plan' }
}

function cmdPermissions(
  session: SlashSession,
  args: string,
): SlashDispatchResult {
  const raw = args.trim()
  if (!raw) {
    const list = PERMISSION_MODES.map((m) => {
      const meta = PERMISSION_MODE_META[m]
      const mark = m === session.permissionMode ? ' *' : ''
      return `  ${m}${mark} — ${meta.userLabel}`
    }).join('\n')
    return {
      ok: true,
      message: `permissionMode: ${session.permissionMode}\nmodes:\n${list}`,
    }
  }
  if (!isPermissionMode(raw)) {
    return {
      ok: false,
      message: `unknown mode "${raw}". Use: ${PERMISSION_MODES.join('|')}`,
    }
  }
  session.permissionMode = raw
  return { ok: true, message: `permissionMode set to ${raw}` }
}

/** 内置注册表（顺序即 /help 列表顺序） */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'help',
    summary: 'List slash commands',
    run: cmdHelp,
  },
  {
    name: 'clear',
    summary: 'Clear conversation messages (keep id/cwd/system)',
    run: cmdClear,
  },
  {
    name: 'compact',
    summary: 'Summarize conversation (needs CompactSummarizer)',
    usage: '[note]',
    run: cmdCompact,
  },
  {
    name: 'context',
    summary: 'Show message count, chars, mode, model, cwd, id',
    run: cmdContext,
  },
  {
    name: 'model',
    summary: 'Show or set session.model',
    usage: '[name]',
    run: cmdModel,
  },
  {
    name: 'effort',
    summary: 'Show or set session effortLevel',
    usage: '[low|medium|high|max|auto]',
    run: cmdEffort,
  },
  {
    name: 'plan',
    summary: 'Set permissionMode to plan',
    run: cmdPlan,
  },
  {
    name: 'permissions',
    summary: 'Show or set permission mode (four tiers)',
    usage: '[mode]',
    run: cmdPermissions,
  },
]

const COMMAND_MAP = new Map(SLASH_COMMANDS.map((c) => [c.name, c]))

export function getSlashCommand(name: string): SlashCommandDef | undefined {
  return COMMAND_MAP.get(name.toLowerCase())
}

export async function dispatchSlashCommand(
  session: SlashSession,
  name: string,
  args: string,
): Promise<SlashDispatchResult> {
  const cmd = getSlashCommand(name)
  if (!cmd) {
    return {
      ok: false,
      message: `Unknown command /${name}. Type /help for list.`,
    }
  }
  return await cmd.run(session, args)
}

/**
 * 用户输入入口：slash → 本地执行；否则 submitPrompt。
 */
export async function submitUserInput(
  session: SlashSession,
  text: string,
  options?: { maxTurns?: number; querySource?: string },
): Promise<SubmitUserInputResult> {
  const parsed = parseSlashLine(text)
  if (parsed.kind === 'empty') return { type: 'empty' }

  if (parsed.kind === 'command') {
    const r = await dispatchSlashCommand(session, parsed.name, parsed.args)
    return { type: 'slash', message: r.message }
  }

  const { submitPrompt } = await import('./index.ts')
  const terminal = await submitPrompt(
    session as Parameters<typeof submitPrompt>[0],
    parsed.text,
    options,
  )
  return { type: 'prompt', terminal }
}