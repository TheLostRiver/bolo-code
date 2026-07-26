/**
 * 会话 JSONL transcript（T3：默认主路径只写 jsonl）
 *
 * 对照 HelsincyCode sessionStorage 的 JSONL 追加语义；无遥测。
 * T1 曾双写 JSON+jsonl；J-C+/J-D：resume messages 优先 jsonl；
 * T3：save 默认停写 JSON，meta 承载配置切片，旧 JSON 只读兼容。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  nowIso,
  validateTodoList,
  type ChatMessage,
  type TodoItem,
} from '../../shared/src/index.ts'
import type {
  PermissionMode,
  SessionPermissionRules,
} from '../../permissions/src/index.ts'
import type { PersistableSession } from './sessionPersist.ts'
import type { SessionUsage } from './sessionUsage.ts'
import { cloneSessionUsage } from './sessionUsage.ts'
import {
  isDurableTurnState,
  normalizeDurableTurnId,
  projectDurableTurnEvents,
  type DurableTurnEvent,
  type DurableTurnRecord,
  type DurableTurnState,
} from './durableTurn.ts'
import {
  isDurableControlBoundary,
  isDurableControlState,
  isSessionControlKind,
  normalizeDurableControlId,
  normalizeDurableControlSessionId,
  projectDurableControlEvents,
  type DurableControlBoundary,
  type DurableControlEvent,
  type DurableControlRecord,
  type DurableControlState,
} from './durableControl.ts'
import type { SessionControlKind } from './sessionCoordinator.ts'
import {
  isDurableTaskIsolation,
  isDurableTaskState,
  normalizeDurableTaskId,
  normalizeDurableTaskSessionId,
  projectDurableTaskEvents,
  type DurableTaskEvent,
  type DurableTaskIsolation,
  type DurableTaskRecord,
  type DurableTaskState,
} from './durableTask.ts'
import {
  isDurableResolutionAction,
  isDurableResolutionEntityKind,
  normalizeDurableResolutionEntityId,
  normalizeDurableResolutionId,
  normalizeDurableResolutionSessionId,
  projectDurableResolutionEvents,
  type DurableResolutionAction,
  type DurableResolutionEntityKind,
  type DurableResolutionEvent,
  type DurableResolutionRecord,
} from './durableResolution.ts'

/** 公共头字段（线性 transcript；可选 parentUuid 供分叉元数据） */
export type TranscriptEntryBase = {
  type?: string
  sessionId: string
  timestamp: string
  /** F-JD-FORK：可选父消息/entry id；线性主路径可空 */
  parentUuid?: string
  uuid?: string
}

/** meta 首行：id + 配置切片（T3 无 JSON 时 resume 依赖此） */
export type TranscriptMetaEntry = TranscriptEntryBase & {
  type: 'meta'
  cwd?: string
  permissionMode?: PermissionMode | string
  model?: string
  createdAt?: string
  /** 配置切片（可选；旧 jsonl 可能无） */
  systemPromptSections?: string[]
  autoCompactEnabled?: boolean
  contextWindowTokens?: number
  maxPtlRetries?: number
  permissionRules?: SessionPermissionRules
  effortLevel?: string
  /** CX6：命名 provider id */
  providerId?: string
  /** 思考链 CLI 显示；缺省 on */
  showThinking?: boolean
  usage?: SessionUsage
  phase?: string
  updatedAt?: string
}

export type TranscriptMessageEntry = TranscriptEntryBase & {
  type: 'message'
  message: ChatMessage
}

export type TranscriptCompactBoundaryEntry = TranscriptEntryBase & {
  type: 'compact_boundary'
  /** 可选摘要说明 */
  summary?: string
}

/**
 * 会话标题（线性 append；**last-wins**）。
 * 不进模型链；list / resume 摘要可读；rewrite 时保留最后一条。
 */
export type TranscriptTitleEntry = TranscriptEntryBase & {
  type: 'title'
  title: string
}

/**
 * 系统注记（线性 append；**不进模型链**）。
 * 对照 HC 侧 metadata entry（task-summary / 内部说明类）：审计与 list 可读，
 * rewrite 时保留（compact 后仍可见）。
 */
export type TranscriptSystemNoteEntry = TranscriptEntryBase & {
  type: 'system_note'
  text: string
  /** 可选分类：ptl / compact / manual / … */
  kind?: string
}

/**
 * 文件改动摘要（D6；**不进模型链**）。
 * 仅 path/+N/−M；无 structuredPatch lines。rewrite/resume 保留。
 */
export type TranscriptFileDiffEntry = TranscriptEntryBase & {
  type: 'file_diff'
  path: string
  tool: string
  kind: string
  op?: string
  added: number
  removed: number
  turn?: number
}

/**
 * AR-T1：待办表快照（**不进模型链**）。
 * append-only：每次 TodoWrite 追加一条全量快照，resume 取最后一条。
 * 表本身很小（几行文本），全量快照比增量 patch 更抗中断。
 */
export type TranscriptTodoEntry = TranscriptEntryBase & {
  type: 'todo'
  todos: TodoItem[]
}

/** DR0：append-only turn 生命周期；不进模型 messages。 */
export type TranscriptTurnEntry = TranscriptEntryBase & {
  type: 'turn'
  turnId: string
  state: DurableTurnState
  /** 仅 admitted 写最终 hook 归约后的输入。 */
  prompt?: string
  querySource?: string
  terminalReason?: string
  detail?: string
}

/** DR2C：append-only control 生命周期；不进模型 messages。 */
export type TranscriptControlEntry = TranscriptEntryBase & {
  type: 'control'
  controlId: string
  kind: SessionControlKind
  state: DurableControlState
  expectedTurnId?: string
  turnId?: string
  prompt?: string
  querySource?: string
  boundary?: DurableControlBoundary
  detail?: string
}

/** DR3A：background/subagent task lifecycle；不进模型 messages。 */
export type TranscriptTaskEntry = TranscriptEntryBase & {
  type: 'task'
  taskId: string
  parentTurnId?: string
  agentType: string
  state: DurableTaskState
  prompt?: string
  description?: string
  isolation?: DurableTaskIsolation
  detail?: string
}

/** DR3A：task result 必须先于 completed/error terminal；不进模型 messages。 */
export type TranscriptTaskResultEntry = TranscriptEntryBase & {
  type: 'task_result'
  taskId: string
  summary: string
  isError: boolean
  agentTranscriptPath?: string
  usage?: SessionUsage
  totalDurationMs?: number
  totalToolUseCount?: number
  worktreePath?: string
  detail?: string
}

/** DR4B2：interrupted entity 的 append-only 人工处置；不删除 lifecycle。 */
export type TranscriptResolutionEntry = TranscriptEntryBase & {
  type: 'resolution'
  resolutionId: string
  entityKind: DurableResolutionEntityKind
  entityId: string
  action: DurableResolutionAction
  replacementId?: string
  detail?: string
}

export type TranscriptEntry =
  | TranscriptMetaEntry
  | TranscriptMessageEntry
  | TranscriptCompactBoundaryEntry
  | TranscriptTitleEntry
  | TranscriptSystemNoteEntry
  | TranscriptFileDiffEntry
  | TranscriptTodoEntry
  | TranscriptTurnEntry
  | TranscriptControlEntry
  | TranscriptTaskEntry
  | TranscriptTaskResultEntry
  | TranscriptResolutionEntry

export type TranscriptMetaInput = {
  sessionId: string
  cwd?: string
  permissionMode?: PermissionMode | string
  model?: string
  createdAt?: string
  systemPromptSections?: string[]
  autoCompactEnabled?: boolean
  contextWindowTokens?: number
  maxPtlRetries?: number
  permissionRules?: SessionPermissionRules
  effortLevel?: string
  providerId?: string
  showThinking?: boolean
  usage?: SessionUsage
  phase?: string
  updatedAt?: string
}

/** 由 JSON 快照路径推导同目录 `{id}.jsonl` */
export function resolveTranscriptPathFromJson(jsonFilePath: string): string {
  const resolved = path.resolve(jsonFilePath)
  if (resolved.endsWith('.json')) {
    return resolved.slice(0, -'.json'.length) + '.jsonl'
  }
  if (resolved.endsWith('.jsonl')) return resolved
  return `${resolved}.jsonl`
}

export function sessionTranscriptFileName(sessionId: string): string {
  return `${sessionId}.jsonl`
}

export function resolveTranscriptFilePath(
  sessionId: string,
  options?: { sessionsDir?: string; filePath?: string },
): string {
  if (options?.filePath) {
    return resolveTranscriptPathFromJson(options.filePath)
  }
  if (!options?.sessionsDir) {
    throw new Error('resolveTranscriptFilePath: sessionsDir or filePath required')
  }
  return path.join(
    path.resolve(options.sessionsDir),
    sessionTranscriptFileName(sessionId),
  )
}

function cloneMessage(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { role: m.role, content: m.content }
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id
  if (m.name !== undefined) out.name = m.name
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }))
  }
  return out
}

function clonePermissionRules(
  rules: SessionPermissionRules | undefined,
): SessionPermissionRules | undefined {
  if (!rules) return undefined
  const out: SessionPermissionRules = {
    alwaysAllowToolNames: [...rules.alwaysAllowToolNames],
  }
  if (rules.alwaysAllowPrefixes?.length) {
    out.alwaysAllowPrefixes = [...rules.alwaysAllowPrefixes]
  }
  if (rules.alwaysAllowPathGlobs?.length) {
    out.alwaysAllowPathGlobs = [...rules.alwaysAllowPathGlobs]
  }
  if (rules.alwaysAllowBashPrefixes?.length) {
    out.alwaysAllowBashPrefixes = [...rules.alwaysAllowBashPrefixes]
  }
  if (rules.alwaysDenyToolNames?.length) {
    out.alwaysDenyToolNames = [...rules.alwaysDenyToolNames]
  }
  if (rules.alwaysDenyPrefixes?.length) {
    out.alwaysDenyPrefixes = [...rules.alwaysDenyPrefixes]
  }
  if (rules.alwaysDenyPathGlobs?.length) {
    out.alwaysDenyPathGlobs = [...rules.alwaysDenyPathGlobs]
  }
  if (rules.alwaysDenyBashPrefixes?.length) {
    out.alwaysDenyBashPrefixes = [...rules.alwaysDenyBashPrefixes]
  }
  return out
}

function cloneUsage(usage: SessionUsage | undefined): SessionUsage | undefined {
  return cloneSessionUsage(usage)
}

/** 从 live session 构造 meta 输入（配置切片进首行，供 T3 无 JSON resume） */
export function metaInputFromSession(
  session: PersistableSession,
  opts?: { createdAt?: string; updatedAt?: string },
): TranscriptMetaInput {
  const permissionRules = clonePermissionRules(session.permissionRules)
  const usage = cloneUsage(session.usage)
  const effort =
    typeof session.effortLevel === 'string' && session.effortLevel.trim()
      ? session.effortLevel.trim()
      : undefined
  const providerId =
    typeof session.providerId === 'string' && session.providerId.trim()
      ? session.providerId.trim()
      : undefined
  const showThinkingOff = session.showThinking === false
  return {
    sessionId: session.id,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    model: session.model,
    createdAt: opts?.createdAt,
    updatedAt: opts?.updatedAt ?? nowIso(),
    systemPromptSections: [...session.systemPromptSections],
    autoCompactEnabled: session.autoCompactEnabled,
    contextWindowTokens: session.contextWindowTokens,
    maxPtlRetries: session.maxPtlRetries,
    phase: session.phase,
    ...(permissionRules ? { permissionRules } : {}),
    ...(effort ? { effortLevel: effort } : {}),
    ...(providerId ? { providerId } : {}),
    ...(showThinkingOff ? { showThinking: false } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** 将 meta 输入编成 entry（省略 undefined 字段） */
export function buildMetaEntry(meta: TranscriptMetaInput): TranscriptMetaEntry {
  const permissionRules = clonePermissionRules(meta.permissionRules)
  const usage = cloneUsage(meta.usage)
  const effort =
    typeof meta.effortLevel === 'string' && meta.effortLevel.trim()
      ? meta.effortLevel.trim()
      : undefined
  const providerId =
    typeof meta.providerId === 'string' && meta.providerId.trim()
      ? meta.providerId.trim()
      : undefined
  const showThinkingOff = meta.showThinking === false
  return {
    type: 'meta',
    sessionId: meta.sessionId,
    timestamp: nowIso(),
    cwd: meta.cwd,
    permissionMode: meta.permissionMode,
    model: meta.model,
    createdAt: meta.createdAt ?? nowIso(),
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
    ...(meta.systemPromptSections
      ? { systemPromptSections: [...meta.systemPromptSections] }
      : {}),
    ...(meta.autoCompactEnabled !== undefined
      ? { autoCompactEnabled: meta.autoCompactEnabled }
      : {}),
    ...(meta.contextWindowTokens !== undefined
      ? { contextWindowTokens: meta.contextWindowTokens }
      : {}),
    ...(meta.maxPtlRetries !== undefined
      ? { maxPtlRetries: meta.maxPtlRetries }
      : {}),
    ...(meta.phase ? { phase: meta.phase } : {}),
    ...(permissionRules ? { permissionRules } : {}),
    ...(effort ? { effortLevel: effort } : {}),
    ...(providerId ? { providerId } : {}),
    ...(showThinkingOff ? { showThinking: false } : {}),
    ...(usage ? { usage } : {}),
  }
}

/**
 * 同一 transcript 的所有 append/rewrite 共用进程内写屏障。
 * 前一写失败不会毒化后续队列；锁只按绝对路径串行，不阻塞其它 session。
 */
const transcriptWriteTails = new Map<string, Promise<void>>()

async function withTranscriptWriteBarrier<T>(
  file: string,
  operation: (filePath: string) => Promise<T>,
): Promise<T> {
  const filePath = path.resolve(file)
  const previous = transcriptWriteTails.get(filePath) ?? Promise.resolve()
  let unlock!: () => void
  const gate = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  transcriptWriteTails.set(filePath, tail)
  await previous.catch(() => undefined)
  try {
    return await operation(filePath)
  } finally {
    unlock()
    if (transcriptWriteTails.get(filePath) === tail) {
      transcriptWriteTails.delete(filePath)
    }
  }
}

async function appendTranscriptLineUnlocked(
  filePath: string,
  entry: TranscriptEntry,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const line = JSON.stringify(entry) + '\n'
  await fs.appendFile(filePath, line, 'utf8')
}

/** UTF-8 一行 JSON + `\n`；同路径串行追加。 */
export async function appendTranscriptLine(
  file: string,
  entry: TranscriptEntry,
): Promise<void> {
  await withTranscriptWriteBarrier(file, (filePath) =>
    appendTranscriptLineUnlocked(filePath, entry),
  )
}

/**
 * 若文件不存在则写首行 `meta`；已存在则不改动。
 * @returns 是否新建了文件
 */
export async function ensureTranscriptFile(
  file: string,
  meta: TranscriptMetaInput,
): Promise<boolean> {
  return await withTranscriptWriteBarrier(file, async (filePath) => {
    try {
      await fs.access(filePath)
      return false
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') throw err
    }
    await appendTranscriptLineUnlocked(filePath, buildMetaEntry(meta))
    return true
  })
}

/** 将 messages 编成 `message` entry 依次追加 */
export async function recordSessionMessages(
  file: string,
  messages: ChatMessage[],
  opts?: { sessionId?: string },
): Promise<number> {
  if (!messages.length) return 0
  return await withTranscriptWriteBarrier(file, async (filePath) => {
    const sessionId = opts?.sessionId ?? ''
    let n = 0
    for (const m of messages) {
      const entry: TranscriptMessageEntry = {
        type: 'message',
        sessionId,
        timestamp: nowIso(),
        message: cloneMessage(m),
      }
      await appendTranscriptLineUnlocked(filePath, entry)
      n++
    }
    return n
  })
}

export async function appendCompactBoundary(
  file: string,
  opts: { sessionId: string; summary?: string },
): Promise<void> {
  const entry: TranscriptCompactBoundaryEntry = {
    type: 'compact_boundary',
    sessionId: opts.sessionId,
    timestamp: nowIso(),
    summary: opts.summary,
  }
  await appendTranscriptLine(file, entry)
}

/** 规范化标题：trim + 压空白；空串返回 undefined */
export function normalizeSessionTitle(raw: string): string | undefined {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t ? t : undefined
}

export function buildTitleEntry(opts: {
  sessionId: string
  title: string
  timestamp?: string
}): TranscriptTitleEntry {
  const title = normalizeSessionTitle(opts.title)
  if (!title) {
    throw new Error('buildTitleEntry: title is empty')
  }
  return {
    type: 'title',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? nowIso(),
    title,
  }
}

/** 追加 `title` entry（不进 messages 链） */
export async function appendSessionTitle(
  file: string,
  opts: { sessionId: string; title: string },
): Promise<TranscriptTitleEntry> {
  const entry = buildTitleEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

/** 规范化 system_note 正文 */
export function normalizeSystemNoteText(raw: string): string | undefined {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t ? t : undefined
}

export function buildSystemNoteEntry(opts: {
  sessionId: string
  text: string
  kind?: string
  timestamp?: string
}): TranscriptSystemNoteEntry {
  const text = normalizeSystemNoteText(opts.text)
  if (!text) {
    throw new Error('buildSystemNoteEntry: text is empty')
  }
  const kind =
    typeof opts.kind === 'string' && opts.kind.trim()
      ? opts.kind.trim()
      : undefined
  return {
    type: 'system_note',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? nowIso(),
    text,
    ...(kind ? { kind } : {}),
  }
}

/** 追加 `system_note`（不进 messages 链） */
export async function appendSystemNote(
  file: string,
  opts: { sessionId: string; text: string; kind?: string },
): Promise<TranscriptSystemNoteEntry> {
  const entry = buildSystemNoteEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

export function buildFileDiffEntry(opts: {
  sessionId: string
  path: string
  tool: string
  kind: string
  op?: string
  added: number
  removed: number
  turn?: number
  timestamp?: string
}): TranscriptFileDiffEntry {
  const filePath = opts.path.trim()
  if (!filePath) throw new Error('buildFileDiffEntry: path is empty')
  return {
    type: 'file_diff',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? nowIso(),
    path: filePath,
    tool: opts.tool.trim() || 'unknown',
    kind: opts.kind.trim() || 'file_edit',
    added: Math.max(0, Math.floor(opts.added) || 0),
    removed: Math.max(0, Math.floor(opts.removed) || 0),
    ...(opts.op ? { op: opts.op } : {}),
    ...(opts.turn != null && Number.isFinite(opts.turn)
      ? { turn: Math.floor(opts.turn) }
      : {}),
  }
}

/** 追加 `file_diff` 摘要（不进模型链） */
export async function appendFileDiffEntry(
  file: string,
  opts: {
    sessionId: string
    path: string
    tool: string
    kind: string
    op?: string
    added: number
    removed: number
    turn?: number
  },
): Promise<TranscriptFileDiffEntry> {
  const entry = buildFileDiffEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

export function buildTodoEntry(opts: {
  sessionId: string
  todos: readonly TodoItem[]
  timestamp?: string
}): TranscriptTodoEntry {
  return {
    type: 'todo',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? nowIso(),
    todos: opts.todos.map((t) => ({ ...t })),
  }
}

/** 追加 `todo` 全量快照（不进模型链） */
export async function appendTodoEntry(
  file: string,
  opts: { sessionId: string; todos: readonly TodoItem[] },
): Promise<TranscriptTodoEntry> {
  const entry = buildTodoEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

/** 取 entries 中最后一条 todo 快照；无则空表 */
export function projectTodosFromEntries(
  entries: readonly TranscriptEntry[],
): TodoItem[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e && e.type === 'todo') return e.todos.map((t) => ({ ...t }))
  }
  return []
}

export function buildTurnEntry(opts: {
  sessionId: string
  turnId: string
  state: DurableTurnState
  prompt?: string
  querySource?: string
  terminalReason?: string
  detail?: string
  timestamp?: string
}): TranscriptTurnEntry {
  const turnId = normalizeDurableTurnId(opts.turnId)
  return {
    type: 'turn',
    sessionId: opts.sessionId,
    turnId,
    state: opts.state,
    timestamp: opts.timestamp ?? nowIso(),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    ...(opts.querySource?.trim()
      ? { querySource: opts.querySource.trim() }
      : {}),
    ...(opts.terminalReason?.trim()
      ? { terminalReason: opts.terminalReason.trim() }
      : {}),
    ...(opts.detail?.trim() ? { detail: opts.detail.trim() } : {}),
  }
}

/** 追加 DR0 turn lifecycle entry（不进模型链）。 */
export async function appendTurnEntry(
  file: string,
  opts: {
    sessionId: string
    turnId: string
    state: DurableTurnState
    prompt?: string
    querySource?: string
    terminalReason?: string
    detail?: string
  },
): Promise<TranscriptTurnEntry> {
  const entry = buildTurnEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

export function buildControlEntry(
  opts: DurableControlEvent,
): TranscriptControlEntry {
  const controlId = normalizeDurableControlId(opts.controlId)
  const sessionId = normalizeDurableControlSessionId(opts.sessionId)
  if (!isSessionControlKind(opts.kind)) {
    throw new Error(`buildControlEntry: invalid kind ${String(opts.kind)}`)
  }
  if (!isDurableControlState(opts.state)) {
    throw new Error(`buildControlEntry: invalid state ${String(opts.state)}`)
  }
  if (
    opts.boundary !== undefined &&
    !isDurableControlBoundary(opts.boundary)
  ) {
    throw new Error(
      `buildControlEntry: invalid boundary ${String(opts.boundary)}`,
    )
  }
  return {
    type: 'control',
    sessionId,
    timestamp: opts.timestamp ?? nowIso(),
    controlId,
    kind: opts.kind,
    state: opts.state,
    ...(opts.expectedTurnId?.trim()
      ? { expectedTurnId: normalizeDurableTurnId(opts.expectedTurnId) }
      : {}),
    ...(opts.turnId?.trim()
      ? { turnId: normalizeDurableTurnId(opts.turnId) }
      : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    ...(opts.querySource?.trim()
      ? { querySource: opts.querySource.trim() }
      : {}),
    ...(opts.boundary ? { boundary: opts.boundary } : {}),
    ...(opts.detail?.trim() ? { detail: opts.detail.trim() } : {}),
  }
}

/** 追加 DR2C control lifecycle entry（不进模型链）。 */
export async function appendControlEntry(
  file: string,
  event: DurableControlEvent,
): Promise<TranscriptControlEntry> {
  const entry = buildControlEntry(event)
  await appendTranscriptLine(file, entry)
  return entry
}

export function buildTaskEntry(
  opts: Omit<
    DurableTaskEvent & { type: 'state' },
    'type' | 'timestamp'
  > & {
    timestamp?: string
  },
): TranscriptTaskEntry {
  const taskId = normalizeDurableTaskId(opts.taskId)
  const sessionId = normalizeDurableTaskSessionId(opts.sessionId)
  if (!isDurableTaskState(opts.state)) {
    throw new Error(`buildTaskEntry: invalid state ${String(opts.state)}`)
  }
  if (
    opts.isolation !== undefined &&
    !isDurableTaskIsolation(opts.isolation)
  ) {
    throw new Error(
      `buildTaskEntry: invalid isolation ${String(opts.isolation)}`,
    )
  }
  const agentType = opts.agentType.trim()
  if (!agentType) throw new Error('buildTaskEntry: agentType is empty')
  return {
    type: 'task',
    sessionId,
    taskId,
    agentType,
    state: opts.state,
    timestamp: opts.timestamp ?? nowIso(),
    ...(opts.parentTurnId?.trim()
      ? { parentTurnId: normalizeDurableTurnId(opts.parentTurnId) }
      : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    ...(opts.description?.trim()
      ? { description: opts.description.trim() }
      : {}),
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    ...(opts.detail?.trim() ? { detail: opts.detail.trim() } : {}),
  }
}

export async function appendTaskEntry(
  file: string,
  opts: Omit<DurableTaskEvent & { type: 'state' }, 'type' | 'timestamp'> & {
    timestamp?: string
  },
): Promise<TranscriptTaskEntry> {
  const entry = buildTaskEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

export function buildTaskResultEntry(
  opts: Omit<
    DurableTaskEvent & { type: 'result' },
    'type' | 'timestamp'
  > & {
    timestamp?: string
  },
): TranscriptTaskResultEntry {
  const taskId = normalizeDurableTaskId(opts.taskId)
  const sessionId = normalizeDurableTaskSessionId(opts.sessionId)
  const summary = opts.summary.trim()
  if (!summary) throw new Error('buildTaskResultEntry: summary is empty')
  return {
    type: 'task_result',
    sessionId,
    taskId,
    timestamp: opts.timestamp ?? nowIso(),
    summary,
    isError: opts.isError,
    ...(opts.agentTranscriptPath?.trim()
      ? { agentTranscriptPath: opts.agentTranscriptPath.trim() }
      : {}),
    ...(opts.usage ? { usage: structuredClone(opts.usage) } : {}),
    ...(opts.totalDurationMs != null
      ? { totalDurationMs: Math.max(0, opts.totalDurationMs) }
      : {}),
    ...(opts.totalToolUseCount != null
      ? { totalToolUseCount: Math.max(0, opts.totalToolUseCount) }
      : {}),
    ...(opts.worktreePath?.trim()
      ? { worktreePath: opts.worktreePath.trim() }
      : {}),
    ...(opts.detail?.trim() ? { detail: opts.detail.trim() } : {}),
  }
}

export async function appendTaskResultEntry(
  file: string,
  opts: Omit<DurableTaskEvent & { type: 'result' }, 'type' | 'timestamp'> & {
    timestamp?: string
  },
): Promise<TranscriptTaskResultEntry> {
  const entry = buildTaskResultEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

export function buildResolutionEntry(
  opts: Omit<DurableResolutionEvent, 'timestamp'> & {
    timestamp?: string
  },
): TranscriptResolutionEntry {
  const resolutionId = normalizeDurableResolutionId(opts.resolutionId)
  const sessionId = normalizeDurableResolutionSessionId(opts.sessionId)
  const entityId = normalizeDurableResolutionEntityId(opts.entityId)
  if (!isDurableResolutionEntityKind(opts.entityKind)) {
    throw new Error(
      `buildResolutionEntry: invalid entity kind ${String(opts.entityKind)}`,
    )
  }
  if (!isDurableResolutionAction(opts.action)) {
    throw new Error(
      `buildResolutionEntry: invalid action ${String(opts.action)}`,
    )
  }
  const replacementId = opts.replacementId?.trim()
    ? normalizeDurableResolutionEntityId(opts.replacementId)
    : undefined
  if (opts.action === 'discard' && replacementId) {
    throw new Error(
      'buildResolutionEntry: discard cannot have replacementId',
    )
  }
  if (opts.action === 'retry_safe' && !replacementId) {
    throw new Error(
      'buildResolutionEntry: retry_safe requires replacementId',
    )
  }
  if (opts.detail?.includes('\0')) {
    throw new Error(
      'buildResolutionEntry: detail contains a null character',
    )
  }
  return {
    type: 'resolution',
    sessionId,
    resolutionId,
    entityKind: opts.entityKind,
    entityId,
    action: opts.action,
    timestamp: opts.timestamp ?? nowIso(),
    ...(replacementId ? { replacementId } : {}),
    ...(opts.detail?.trim() ? { detail: opts.detail.trim() } : {}),
  }
}

export async function appendResolutionEntry(
  file: string,
  opts: Omit<DurableResolutionEvent, 'timestamp'> & {
    timestamp?: string
  },
): Promise<TranscriptResolutionEntry> {
  const entry = buildResolutionEntry(opts)
  await appendTranscriptLine(file, entry)
  return entry
}

/** 从 transcript 投影 turn；默认把 admitted/running 识别为 interrupted。 */
export function projectDurableTurns(
  entries: readonly TranscriptEntry[],
  opts?: { recoverIncomplete?: boolean },
): DurableTurnRecord[] {
  const events: DurableTurnEvent[] = []
  for (const entry of entries) {
    if (entry.type !== 'turn') continue
    events.push({
      turnId: entry.turnId,
      state: entry.state,
      timestamp: entry.timestamp,
      ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
      ...(entry.querySource ? { querySource: entry.querySource } : {}),
      ...(entry.terminalReason
        ? { terminalReason: entry.terminalReason }
        : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    })
  }
  return projectDurableTurnEvents(events, opts)
}

/** 从 transcript 投影 controls；默认将 pending/ready 恢复为 interrupted。 */
export function projectDurableControls(
  entries: readonly TranscriptEntry[],
  opts?: { recoverIncomplete?: boolean },
): DurableControlRecord[] {
  const events: DurableControlEvent[] = []
  for (const entry of entries) {
    if (entry.type !== 'control') continue
    events.push({
      controlId: entry.controlId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      state: entry.state,
      timestamp: entry.timestamp,
      ...(entry.expectedTurnId
        ? { expectedTurnId: entry.expectedTurnId }
        : {}),
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
      ...(entry.querySource ? { querySource: entry.querySource } : {}),
      ...(entry.boundary ? { boundary: entry.boundary } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    })
  }
  return projectDurableControlEvents(events, opts)
}

/** 从 transcript 投影 background tasks；默认将 admitted/running 恢复为 interrupted。 */
export function projectDurableTasks(
  entries: readonly TranscriptEntry[],
  opts?: { recoverIncomplete?: boolean },
): DurableTaskRecord[] {
  const events: DurableTaskEvent[] = []
  for (const entry of entries) {
    if (entry.type === 'task') {
      events.push({
        type: 'state',
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        agentType: entry.agentType,
        state: entry.state,
        timestamp: entry.timestamp,
        ...(entry.parentTurnId
          ? { parentTurnId: entry.parentTurnId }
          : {}),
        ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
        ...(entry.description
          ? { description: entry.description }
          : {}),
        ...(entry.isolation ? { isolation: entry.isolation } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      })
    } else if (entry.type === 'task_result') {
      events.push({
        type: 'result',
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
        summary: entry.summary,
        isError: entry.isError,
        ...(entry.agentTranscriptPath
          ? { agentTranscriptPath: entry.agentTranscriptPath }
          : {}),
        ...(entry.usage ? { usage: structuredClone(entry.usage) } : {}),
        ...(entry.totalDurationMs != null
          ? { totalDurationMs: entry.totalDurationMs }
          : {}),
        ...(entry.totalToolUseCount != null
          ? { totalToolUseCount: entry.totalToolUseCount }
          : {}),
        ...(entry.worktreePath
          ? { worktreePath: entry.worktreePath }
          : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      })
    }
  }
  return projectDurableTaskEvents(events, opts)
}

/** 从 transcript 投影 append-only recovery resolutions。 */
export function projectDurableResolutions(
  entries: readonly TranscriptEntry[],
): DurableResolutionRecord[] {
  const targetKey = (
    sessionId: string,
    entityKind: DurableResolutionEntityKind,
    entityId: string,
  ): string => `${sessionId}\0${entityKind}\0${entityId}`

  // resolution 是外部 JSONL 输入。先以实际可投影的 lifecycle 建立引用表，
  // 避免 orphan/cross-session/kind-mismatch 行使整个 runtime snapshot 失效。
  const turnSessions = new Map<string, string | null>()
  for (const entry of entries) {
    if (entry.type !== 'turn') continue
    if (!turnSessions.has(entry.turnId)) {
      turnSessions.set(entry.turnId, entry.sessionId)
      continue
    }
    if (turnSessions.get(entry.turnId) !== entry.sessionId) {
      turnSessions.set(entry.turnId, null)
    }
  }

  const targets = new Map<
    string,
    DurableTurnState | DurableControlState | DurableTaskState
  >()
  const projectedTurnKeys = new Set<string>()
  for (const turn of projectDurableTurns(entries)) {
    const sessionId = turnSessions.get(turn.turnId)
    if (!sessionId) continue
    const key = targetKey(sessionId, 'turn', turn.turnId)
    projectedTurnKeys.add(key)
    targets.set(key, turn.state)
  }
  for (const control of projectDurableControls(entries)) {
    targets.set(
      targetKey(control.sessionId, 'control', control.controlId),
      control.state,
    )
  }
  for (const task of projectDurableTasks(entries)) {
    targets.set(
      targetKey(task.sessionId, 'task', task.taskId),
      task.state,
    )
  }

  const events: DurableResolutionEvent[] = []
  for (const entry of entries) {
    if (entry.type !== 'resolution') continue
    if (
      targets.get(
        targetKey(entry.sessionId, entry.entityKind, entry.entityId),
      ) !== 'interrupted'
    ) {
      continue
    }
    if (
      entry.action === 'retry_safe' &&
      (!entry.replacementId ||
        entry.replacementId === entry.entityId ||
        !projectedTurnKeys.has(
          targetKey(entry.sessionId, 'turn', entry.replacementId),
        ))
    ) {
      continue
    }
    events.push({
      resolutionId: entry.resolutionId,
      sessionId: entry.sessionId,
      entityKind: entry.entityKind,
      entityId: entry.entityId,
      action: entry.action,
      timestamp: entry.timestamp,
      ...(entry.replacementId
        ? { replacementId: entry.replacementId }
        : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    })
  }
  return projectDurableResolutionEvents(events)
}

/** entries 中全部 file_diff（保持文件顺序） */
export function fileDiffsFromTranscriptEntries(
  entries: TranscriptEntry[],
): Array<{
  path: string
  tool: string
  kind: string
  op?: string
  added: number
  removed: number
  turn?: number
  at: string
}> {
  const out: Array<{
    path: string
    tool: string
    kind: string
    op?: string
    added: number
    removed: number
    turn?: number
    at: string
  }> = []
  for (const e of entries) {
    if (e.type !== 'file_diff') continue
    if (!e.path?.trim()) continue
    out.push({
      path: e.path,
      tool: e.tool || 'unknown',
      kind: e.kind || 'file_edit',
      added: e.added ?? 0,
      removed: e.removed ?? 0,
      at: e.timestamp,
      ...(e.op ? { op: e.op } : {}),
      ...(e.turn != null ? { turn: e.turn } : {}),
    })
  }
  return out
}

/** entries 中全部 system_note（保持文件顺序） */
export function systemNotesFromTranscriptEntries(
  entries: TranscriptEntry[],
): Array<{ text: string; kind?: string; timestamp: string }> {
  const out: Array<{ text: string; kind?: string; timestamp: string }> = []
  for (const e of entries) {
    if (e.type !== 'system_note') continue
    const text = normalizeSystemNoteText(e.text)
    if (!text) continue
    out.push({
      text,
      timestamp: e.timestamp,
      ...(e.kind ? { kind: e.kind } : {}),
    })
  }
  return out
}

/** entries 中最后一条非空 title（last-wins） */
export function titleFromTranscriptEntries(
  entries: TranscriptEntry[],
): string | undefined {
  let title: string | undefined
  for (const e of entries) {
    if (e.type !== 'title') continue
    const t = normalizeSessionTitle(e.title)
    if (t) title = t
  }
  return title
}

/** 运行时：已 append 的 messages 条数（增量双写） */
type TranscriptWriteState = {
  filePath: string
  /** 已写入 transcript 的 messages 条数（不含 meta/boundary） */
  appendedMessageCount: number
}

const transcriptState = new WeakMap<object, TranscriptWriteState>()

export function getTranscriptWriteState(
  session: object,
): TranscriptWriteState | undefined {
  return transcriptState.get(session)
}

export function setTranscriptWriteState(
  session: object,
  state: Partial<TranscriptWriteState> & { filePath?: string },
): void {
  const prev = transcriptState.get(session)
  transcriptState.set(session, {
    filePath: state.filePath ?? prev?.filePath ?? '',
    appendedMessageCount:
      state.appendedMessageCount ?? prev?.appendedMessageCount ?? 0,
  })
}

/**
 * 从 messages 全量重建 jsonl（meta + 可选 compact_boundary + 全部 message + 保留 title/notes）。
 * 用于 compact 后 messages 变短等无法纯 append 的情况。
 * title / system_note：显式 opts 优先；否则读旧文件保留（title last-wins；notes 全量保留）。
 */
export type RewriteTranscriptOptions = {
  createdAt?: string
  compactBoundarySummary?: string
  /** 显式标题；省略则尽量保留磁盘上最后一条 title */
  title?: string
  /** 显式 system_notes；省略则尽量保留磁盘上已有 notes */
  systemNotes?: Array<{ text: string; kind?: string }>
}

export async function rewriteTranscriptFromMessages(
  file: string,
  session: PersistableSession,
  opts?: RewriteTranscriptOptions,
): Promise<void> {
  await withTranscriptWriteBarrier(file, (filePath) =>
    rewriteTranscriptFromMessagesUnlocked(filePath, session, opts),
  )
}

/**
 * 重写前读取旧 transcript，以便把 durable 条目接到新文件里。
 *
 * **必须区分「文件不存在」与「文件在但读不出来」。**
 *
 * 前者是首次写入的正常情形，保留列表为空是对的。后者——`loadTranscriptFile`
 * 在 `st.size > 32MiB` 时直接抛，损坏或 EACCES 同样会抛——意味着我们**不知道
 * 旧文件里有什么**。此时若继续重写，就会用一个不含 turn/control/task/resolution
 * 的新文件覆盖掉原件，造成**静默的永久丢失**：断点续跑与 recovery 全靠这些条目，
 * 而整个过程不报任何错。
 *
 * 长会话堆到 32MiB 并非极端情况（大 tool 输出很容易），所以这条路径必须
 * 中止整个 rewrite 而不是降级——原文件保持不动，报错至少能诊断。
 */
async function loadTranscriptForPreservation(
  filePath: string,
): Promise<TranscriptEntry[]> {
  try {
    const { entries } = await loadTranscriptFile(filePath)
    return entries
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(
      `refusing to rewrite ${filePath}: the existing transcript could not be read, so durable entries (turn/control/task/resolution) and the title cannot be preserved — rewriting anyway would silently destroy them. Original file left untouched. Cause: ${msg}`,
    )
  }
}

async function rewriteTranscriptFromMessagesUnlocked(
  filePath: string,
  session: PersistableSession,
  opts?: RewriteTranscriptOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })

  // 一次读取供全部保留逻辑复用（原实现对同一文件最多重复读 5 次，
  // 且每次的失败都被单独吞掉）
  const existingEntries = await loadTranscriptForPreservation(filePath)

  let preservedTitle: string | undefined
  let preservedNotes: Array<{ text: string; kind?: string }> = []
  let preservedFileDiffs: Array<{
    path: string
    tool: string
    kind: string
    op?: string
    added: number
    removed: number
    turn?: number
  }> = []
  let preservedTurns: TranscriptTurnEntry[] = []
  let preservedControls: TranscriptControlEntry[] = []
  let preservedTasks: Array<
    TranscriptTaskEntry | TranscriptTaskResultEntry
  > = []
  let preservedResolutions: TranscriptResolutionEntry[] = []
  if (opts && 'title' in opts && opts.title !== undefined) {
    preservedTitle = normalizeSessionTitle(opts.title)
  }
  if (opts && 'systemNotes' in opts && opts.systemNotes !== undefined) {
    preservedNotes = opts.systemNotes
      .map((n) => {
        const text = normalizeSystemNoteText(n.text)
        if (!text) return null
        return {
          text,
          ...(n.kind?.trim() ? { kind: n.kind.trim() } : {}),
        }
      })
      .filter((n): n is { text: string; kind?: string } => n != null)
  } else {
    {
      const entries = existingEntries
      if (!(opts && 'title' in opts && opts.title !== undefined)) {
        preservedTitle = titleFromTranscriptEntries(entries)
      }
      if (!(opts && 'systemNotes' in opts && opts.systemNotes !== undefined)) {
        preservedNotes = systemNotesFromTranscriptEntries(entries).map((n) => ({
          text: n.text,
          ...(n.kind ? { kind: n.kind } : {}),
        }))
      }
      preservedFileDiffs = fileDiffsFromTranscriptEntries(entries).map((d) => ({
        path: d.path,
        tool: d.tool,
        kind: d.kind,
        added: d.added,
        removed: d.removed,
        ...(d.op ? { op: d.op } : {}),
        ...(d.turn != null ? { turn: d.turn } : {}),
      }))
      preservedTurns = entries
        .filter((entry): entry is TranscriptTurnEntry => entry.type === 'turn')
        .map((entry) => ({ ...entry }))
      preservedControls = entries
        .filter(
          (entry): entry is TranscriptControlEntry =>
            entry.type === 'control',
        )
        .map((entry) => ({ ...entry }))
      preservedTasks = entries
        .filter(
          (
            entry,
          ): entry is TranscriptTaskEntry | TranscriptTaskResultEntry =>
            entry.type === 'task' || entry.type === 'task_result',
        )
        .map((entry) => ({ ...entry }))
      preservedResolutions = entries
        .filter(
          (entry): entry is TranscriptResolutionEntry =>
            entry.type === 'resolution',
        )
        .map((entry) => ({ ...entry }))
    }
  }
  if (preservedTurns.length === 0) {
    {
      const entries = existingEntries
      preservedTurns = entries
        .filter((entry): entry is TranscriptTurnEntry => entry.type === 'turn')
        .map((entry) => ({ ...entry }))
    }
  }
  if (preservedControls.length === 0) {
    {
      const entries = existingEntries
      preservedControls = entries
        .filter(
          (entry): entry is TranscriptControlEntry =>
            entry.type === 'control',
        )
        .map((entry) => ({ ...entry }))
    }
  }
  if (preservedTasks.length === 0) {
    {
      const entries = existingEntries
      preservedTasks = entries
        .filter(
          (
            entry,
          ): entry is TranscriptTaskEntry | TranscriptTaskResultEntry =>
            entry.type === 'task' || entry.type === 'task_result',
        )
        .map((entry) => ({ ...entry }))
    }
  }
  if (preservedResolutions.length === 0) {
    {
      const entries = existingEntries
      preservedResolutions = entries
        .filter(
          (entry): entry is TranscriptResolutionEntry =>
            entry.type === 'resolution',
        )
        .map((entry) => ({ ...entry }))
    }
  }

  const lines: string[] = []
  lines.push(
    JSON.stringify(
      buildMetaEntry(
        metaInputFromSession(session, { createdAt: opts?.createdAt }),
      ),
    ),
  )
  if (opts && 'compactBoundarySummary' in opts) {
    const boundary: TranscriptCompactBoundaryEntry = {
      type: 'compact_boundary',
      sessionId: session.id,
      timestamp: nowIso(),
      summary: opts.compactBoundarySummary,
    }
    lines.push(JSON.stringify(boundary))
  }
  for (const m of session.messages) {
    const entry: TranscriptMessageEntry = {
      type: 'message',
      sessionId: session.id,
      timestamp: nowIso(),
      message: cloneMessage(m),
    }
    lines.push(JSON.stringify(entry))
  }
  if (preservedTitle) {
    lines.push(
      JSON.stringify(
        buildTitleEntry({ sessionId: session.id, title: preservedTitle }),
      ),
    )
  }
  for (const n of preservedNotes) {
    lines.push(
      JSON.stringify(
        buildSystemNoteEntry({
          sessionId: session.id,
          text: n.text,
          kind: n.kind,
        }),
      ),
    )
  }
  for (const d of preservedFileDiffs) {
    lines.push(
      JSON.stringify(
        buildFileDiffEntry({
          sessionId: session.id,
          path: d.path,
          tool: d.tool,
          kind: d.kind,
          added: d.added,
          removed: d.removed,
          ...(d.op ? { op: d.op } : {}),
          ...(d.turn != null ? { turn: d.turn } : {}),
        }),
      ),
    )
  }
  for (const turn of preservedTurns) {
    lines.push(JSON.stringify(turn))
  }
  for (const control of preservedControls) {
    lines.push(JSON.stringify(control))
  }
  for (const task of preservedTasks) {
    lines.push(JSON.stringify(task))
  }
  for (const resolution of preservedResolutions) {
    lines.push(JSON.stringify(resolution))
  }
  const body = lines.length ? lines.join('\n') + '\n' : ''
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  await fs.writeFile(tmp, body, 'utf8')
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
      try {
        await fs.unlink(filePath)
      } catch {
        /* ignore */
      }
      await fs.rename(tmp, filePath)
    } else {
      try {
        await fs.unlink(tmp)
      } catch {
        /* ignore */
      }
      throw err
    }
  }
}

/** 粗计 jsonl 中 type=message 行数（坏行跳过；仅用于增量基线） */
export async function countTranscriptMessageEntries(
  file: string,
): Promise<number> {
  try {
    const raw = await fs.readFile(path.resolve(file), 'utf8')
    let n = 0
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as { type?: string }
        if (o?.type === 'message') n++
      } catch {
        // 损坏行跳过
      }
    }
    return n
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return 0
    throw err
  }
}

const DEFAULT_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024

function isTranscriptChatMessage(x: unknown): x is ChatMessage {
  if (!x || typeof x !== 'object') return false
  const m = x as Record<string, unknown>
  if (typeof m.role !== 'string' || typeof m.content !== 'string') return false
  return (
    m.role === 'system' ||
    m.role === 'user' ||
    m.role === 'assistant' ||
    m.role === 'tool'
  )
}

/**
 * 按行解析 jsonl → entries（坏行跳过）。
 * Phase C 最小读路径；默认上限 32MiB。
 */
export async function loadTranscriptFile(
  file: string,
  opts?: { maxBytes?: number },
): Promise<{ entries: TranscriptEntry[]; path: string }> {
  const filePath = path.resolve(file)
  const maxBytes = opts?.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES
  const st = await fs.stat(filePath)
  if (st.size > maxBytes) {
    throw new Error(
      `transcript too large: ${st.size} bytes > max ${maxBytes} (${filePath})`,
    )
  }
  const raw = await fs.readFile(filePath, 'utf8')
  const entries: TranscriptEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      if (!o || typeof o.type !== 'string') continue
      if (o.type === 'meta') {
        if (typeof o.sessionId !== 'string') continue
        const meta: TranscriptMetaEntry = {
          type: 'meta',
          sessionId: o.sessionId,
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
        }
        if (typeof o.cwd === 'string') meta.cwd = o.cwd
        if (typeof o.permissionMode === 'string') {
          meta.permissionMode = o.permissionMode
        }
        if (typeof o.model === 'string') meta.model = o.model
        if (typeof o.createdAt === 'string') meta.createdAt = o.createdAt
        if (typeof o.updatedAt === 'string') meta.updatedAt = o.updatedAt
        if (Array.isArray(o.systemPromptSections)) {
          meta.systemPromptSections = o.systemPromptSections.filter(
            (s): s is string => typeof s === 'string',
          )
        }
        if (typeof o.autoCompactEnabled === 'boolean') {
          meta.autoCompactEnabled = o.autoCompactEnabled
        }
        if (
          typeof o.contextWindowTokens === 'number' &&
          Number.isFinite(o.contextWindowTokens)
        ) {
          meta.contextWindowTokens = Math.max(
            0,
            Math.floor(o.contextWindowTokens),
          )
        }
        if (
          typeof o.maxPtlRetries === 'number' &&
          Number.isFinite(o.maxPtlRetries)
        ) {
          meta.maxPtlRetries = Math.max(0, Math.floor(o.maxPtlRetries))
        }
        if (typeof o.phase === 'string') meta.phase = o.phase
        if (typeof o.effortLevel === 'string' && o.effortLevel.trim()) {
          meta.effortLevel = o.effortLevel.trim()
        }
        if (typeof o.providerId === 'string' && o.providerId.trim()) {
          meta.providerId = o.providerId.trim()
        }
        if (o.showThinking === false) {
          meta.showThinking = false
        } else if (o.showThinking === true) {
          meta.showThinking = true
        }
        if (o.permissionRules && typeof o.permissionRules === 'object') {
          const pr = o.permissionRules as Record<string, unknown>
          if (Array.isArray(pr.alwaysAllowToolNames)) {
            const names = pr.alwaysAllowToolNames.filter(
              (n): n is string => typeof n === 'string' && n.trim().length > 0,
            )
            const rules: SessionPermissionRules = {
              alwaysAllowToolNames: names,
            }
            if (Array.isArray(pr.alwaysAllowPrefixes)) {
              const prefixes = pr.alwaysAllowPrefixes.filter(
                (p): p is string => typeof p === 'string' && p.length > 0,
              )
              if (prefixes.length) rules.alwaysAllowPrefixes = prefixes
            }
            if (Array.isArray(pr.alwaysAllowPathGlobs)) {
              const globs = pr.alwaysAllowPathGlobs.filter(
                (g): g is string => typeof g === 'string' && g.trim().length > 0,
              )
              if (globs.length) rules.alwaysAllowPathGlobs = globs
            }
            if (Array.isArray(pr.alwaysAllowBashPrefixes)) {
              const bash = pr.alwaysAllowBashPrefixes.filter(
                (p): p is string => typeof p === 'string' && p.length > 0,
              )
              if (bash.length) rules.alwaysAllowBashPrefixes = bash
            }
            if (Array.isArray(pr.alwaysDenyToolNames)) {
              const denyNames = pr.alwaysDenyToolNames.filter(
                (n): n is string => typeof n === 'string' && n.trim().length > 0,
              )
              if (denyNames.length) rules.alwaysDenyToolNames = denyNames
            }
            if (Array.isArray(pr.alwaysDenyPrefixes)) {
              const denyPref = pr.alwaysDenyPrefixes.filter(
                (p): p is string => typeof p === 'string' && p.length > 0,
              )
              if (denyPref.length) rules.alwaysDenyPrefixes = denyPref
            }
            if (Array.isArray(pr.alwaysDenyPathGlobs)) {
              const denyGlobs = pr.alwaysDenyPathGlobs.filter(
                (g): g is string => typeof g === 'string' && g.trim().length > 0,
              )
              if (denyGlobs.length) rules.alwaysDenyPathGlobs = denyGlobs
            }
            if (Array.isArray(pr.alwaysDenyBashPrefixes)) {
              const denyBash = pr.alwaysDenyBashPrefixes.filter(
                (p): p is string => typeof p === 'string' && p.length > 0,
              )
              if (denyBash.length) rules.alwaysDenyBashPrefixes = denyBash
            }
            meta.permissionRules = rules
          }
        }
        if (o.usage && typeof o.usage === 'object') {
          const u = o.usage as Record<string, unknown>
          const num = (v: unknown): number | undefined =>
            typeof v === 'number' && Number.isFinite(v)
              ? Math.max(0, Math.floor(v))
              : undefined
          const inputTokens = num(u.inputTokens)
          const outputTokens = num(u.outputTokens)
          const totalTokens = num(u.totalTokens)
          const calls = num(u.calls)
          if (
            inputTokens !== undefined ||
            outputTokens !== undefined ||
            totalTokens !== undefined ||
            calls !== undefined
          ) {
            const usage: SessionUsage = {
              inputTokens: inputTokens ?? 0,
              outputTokens: outputTokens ?? 0,
              totalTokens:
                totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
              calls: calls ?? 0,
            }
            if (u.estimated === true) usage.estimated = true
            const cr = num(u.cacheReadInputTokens)
            if (cr !== undefined && cr > 0) usage.cacheReadInputTokens = cr
            const cc = num(u.cacheCreationInputTokens)
            if (cc !== undefined && cc > 0) {
              usage.cacheCreationInputTokens = cc
            }
            if (
              u.byModel &&
              typeof u.byModel === 'object' &&
              !Array.isArray(u.byModel)
            ) {
              const by: NonNullable<SessionUsage['byModel']> = {}
              for (const [k, v] of Object.entries(
                u.byModel as Record<string, unknown>,
              )) {
                if (!v || typeof v !== 'object') continue
                const b = v as Record<string, unknown>
                const bi = num(b.inputTokens)
                const bo = num(b.outputTokens)
                const bt = num(b.totalTokens)
                const bc = num(b.calls)
                if (
                  bi === undefined &&
                  bo === undefined &&
                  bt === undefined &&
                  bc === undefined
                ) {
                  continue
                }
                const bucket: NonNullable<SessionUsage['byModel']>[string] = {
                  inputTokens: bi ?? 0,
                  outputTokens: bo ?? 0,
                  totalTokens: bt ?? (bi ?? 0) + (bo ?? 0),
                  calls: bc ?? 0,
                }
                if (b.estimated === true) bucket.estimated = true
                const bcr = num(b.cacheReadInputTokens)
                if (bcr !== undefined && bcr > 0) {
                  bucket.cacheReadInputTokens = bcr
                }
                const bcc = num(b.cacheCreationInputTokens)
                if (bcc !== undefined && bcc > 0) {
                  bucket.cacheCreationInputTokens = bcc
                }
                const bad = num(b.apiDurationMs)
                if (bad !== undefined && bad > 0) {
                  bucket.apiDurationMs = bad
                }
                by[k] = bucket
              }
              if (Object.keys(by).length > 0) usage.byModel = by
            }
            // lastCall 可选恢复
            if (u.lastCall && typeof u.lastCall === 'object') {
              const lc = u.lastCall as Record<string, unknown>
              const li = num(lc.inputTokens)
              const lo = num(lc.outputTokens)
              const lt = num(lc.totalTokens)
              if (
                li !== undefined ||
                lo !== undefined ||
                lt !== undefined
              ) {
                usage.lastCall = {
                  inputTokens: li ?? 0,
                  outputTokens: lo ?? 0,
                  totalTokens: lt ?? (li ?? 0) + (lo ?? 0),
                  at:
                    typeof lc.at === 'string' && lc.at.trim()
                      ? lc.at
                      : nowIso(),
                }
                if (lc.estimated === true) usage.lastCall.estimated = true
                if (typeof lc.model === 'string' && lc.model.trim()) {
                  usage.lastCall.model = lc.model.trim()
                }
                const lcr = num(lc.cacheReadInputTokens)
                if (lcr !== undefined && lcr > 0) {
                  usage.lastCall.cacheReadInputTokens = lcr
                }
                const lcc = num(lc.cacheCreationInputTokens)
                if (lcc !== undefined && lcc > 0) {
                  usage.lastCall.cacheCreationInputTokens = lcc
                }
                const lad = num(lc.apiDurationMs)
                if (lad !== undefined && lad > 0) {
                  usage.lastCall.apiDurationMs = lad
                }
              }
            }
            const apiDur = num(u.apiDurationMs)
            if (apiDur !== undefined && apiDur > 0) {
              usage.apiDurationMs = apiDur
            }
            meta.usage = usage
          }
        }
        if (typeof o.uuid === 'string') meta.uuid = o.uuid
        entries.push(meta)
        continue
      }
      if (o.type === 'message') {
        if (!isTranscriptChatMessage(o.message)) continue
        entries.push({
          type: 'message',
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
          message: cloneMessage(o.message),
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
        })
        continue
      }
      if (o.type === 'turn') {
        if (
          typeof o.turnId !== 'string' ||
          !o.turnId.trim() ||
          !isDurableTurnState(o.state)
        ) {
          continue
        }
        entries.push(
          buildTurnEntry({
            sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
            turnId: o.turnId,
            state: o.state,
            timestamp:
              typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
            ...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
            ...(typeof o.querySource === 'string'
              ? { querySource: o.querySource }
              : {}),
            ...(typeof o.terminalReason === 'string'
              ? { terminalReason: o.terminalReason }
              : {}),
            ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
          }),
        )
        continue
      }
      if (o.type === 'control') {
        if (
          typeof o.controlId !== 'string' ||
          typeof o.sessionId !== 'string' ||
          !isSessionControlKind(o.kind) ||
          !isDurableControlState(o.state)
        ) {
          continue
        }
        entries.push(
          buildControlEntry({
            controlId: o.controlId,
            sessionId: o.sessionId,
            kind: o.kind,
            state: o.state,
            timestamp:
              typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
            ...(typeof o.expectedTurnId === 'string'
              ? { expectedTurnId: o.expectedTurnId }
              : {}),
            ...(typeof o.turnId === 'string' ? { turnId: o.turnId } : {}),
            ...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
            ...(typeof o.querySource === 'string'
              ? { querySource: o.querySource }
              : {}),
            ...(isDurableControlBoundary(o.boundary)
              ? { boundary: o.boundary }
              : {}),
            ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
          }),
        )
        continue
      }
      if (o.type === 'task') {
        if (
          typeof o.taskId !== 'string' ||
          typeof o.sessionId !== 'string' ||
          typeof o.agentType !== 'string' ||
          !isDurableTaskState(o.state)
        ) {
          continue
        }
        entries.push(
          buildTaskEntry({
            taskId: o.taskId,
            sessionId: o.sessionId,
            agentType: o.agentType,
            state: o.state,
            timestamp:
              typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
            ...(typeof o.parentTurnId === 'string'
              ? { parentTurnId: o.parentTurnId }
              : {}),
            ...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
            ...(typeof o.description === 'string'
              ? { description: o.description }
              : {}),
            ...(isDurableTaskIsolation(o.isolation)
              ? { isolation: o.isolation }
              : {}),
            ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
          }),
        )
        continue
      }
      if (o.type === 'task_result') {
        if (
          typeof o.taskId !== 'string' ||
          typeof o.sessionId !== 'string' ||
          typeof o.summary !== 'string' ||
          typeof o.isError !== 'boolean'
        ) {
          continue
        }
        const rawUsage =
          o.usage && typeof o.usage === 'object' && !Array.isArray(o.usage)
            ? (o.usage as Partial<SessionUsage>)
            : undefined
        const usage =
          rawUsage &&
          Number.isFinite(rawUsage.inputTokens) &&
          Number.isFinite(rawUsage.outputTokens) &&
          Number.isFinite(rawUsage.totalTokens) &&
          Number.isFinite(rawUsage.calls)
            ? cloneSessionUsage(rawUsage as SessionUsage)
            : undefined
        entries.push(
          buildTaskResultEntry({
            taskId: o.taskId,
            sessionId: o.sessionId,
            timestamp:
              typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
            summary: o.summary,
            isError: o.isError,
            ...(typeof o.agentTranscriptPath === 'string'
              ? { agentTranscriptPath: o.agentTranscriptPath }
              : {}),
            ...(usage ? { usage } : {}),
            ...(typeof o.totalDurationMs === 'number' &&
            Number.isFinite(o.totalDurationMs)
              ? { totalDurationMs: o.totalDurationMs }
              : {}),
            ...(typeof o.totalToolUseCount === 'number' &&
            Number.isFinite(o.totalToolUseCount)
              ? { totalToolUseCount: o.totalToolUseCount }
              : {}),
            ...(typeof o.worktreePath === 'string'
              ? { worktreePath: o.worktreePath }
              : {}),
            ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
          }),
        )
        continue
      }
      if (o.type === 'resolution') {
        if (
          typeof o.resolutionId !== 'string' ||
          typeof o.sessionId !== 'string' ||
          typeof o.entityId !== 'string' ||
          !isDurableResolutionEntityKind(o.entityKind) ||
          !isDurableResolutionAction(o.action)
        ) {
          continue
        }
        try {
          entries.push(
            buildResolutionEntry({
              resolutionId: o.resolutionId,
              sessionId: o.sessionId,
              entityKind: o.entityKind,
              entityId: o.entityId,
              action: o.action,
              timestamp:
                typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
              ...(typeof o.replacementId === 'string'
                ? { replacementId: o.replacementId }
                : {}),
              ...(typeof o.detail === 'string'
                ? { detail: o.detail }
                : {}),
            }),
          )
        } catch {
          // 非法 resolution 行 fail-closed 跳过。
        }
        continue
      }
      if (o.type === 'compact_boundary') {
        entries.push({
          type: 'compact_boundary',
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
          summary: typeof o.summary === 'string' ? o.summary : undefined,
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
        })
        continue
      }
      if (o.type === 'title') {
        if (typeof o.title !== 'string') continue
        const title = normalizeSessionTitle(o.title)
        if (!title) continue
        entries.push({
          type: 'title',
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
          title,
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
        })
        continue
      }
      if (o.type === 'system_note') {
        if (typeof o.text !== 'string') continue
        const text = normalizeSystemNoteText(o.text)
        if (!text) continue
        const kind =
          typeof o.kind === 'string' && o.kind.trim()
            ? o.kind.trim()
            : undefined
        entries.push({
          type: 'system_note',
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
          text,
          ...(kind ? { kind } : {}),
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
        })
        continue
      }
      if (o.type === 'file_diff') {
        if (typeof o.path !== 'string' || !o.path.trim()) continue
        const added =
          typeof o.added === 'number' && Number.isFinite(o.added)
            ? Math.max(0, Math.floor(o.added))
            : 0
        const removed =
          typeof o.removed === 'number' && Number.isFinite(o.removed)
            ? Math.max(0, Math.floor(o.removed))
            : 0
        entries.push({
          type: 'file_diff',
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
          path: o.path.trim(),
          tool: typeof o.tool === 'string' && o.tool.trim() ? o.tool.trim() : 'unknown',
          kind: typeof o.kind === 'string' && o.kind.trim() ? o.kind.trim() : 'file_edit',
          added,
          removed,
          ...(typeof o.op === 'string' && o.op.trim()
            ? { op: o.op.trim() }
            : {}),
          ...(typeof o.turn === 'number' && Number.isFinite(o.turn)
            ? { turn: Math.floor(o.turn) }
            : {}),
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
        })
        continue
      }
      if (o.type === 'todo') {
        // 坏快照整条丢弃，不做部分恢复：半张待办表比没有更危险。
        const validation = validateTodoList(o.todos)
        if (!validation.ok) continue
        entries.push({
          type: 'todo',
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
          todos: validation.todos,
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
        })
      }
    } catch {
      // 损坏行跳过
    }
  }
  return { entries, path: filePath }
}

/**
 * 策略 R1：取**最后一个** `compact_boundary` 之后的 message 行作为有效模型链。
 * 无 boundary 时取全部 message。meta 仍取文件中首条 meta。
 * `title` / `system_note` 不进 messages（仅元数据）。
 * compact 后 rewrite 的 jsonl 为 meta+boundary+压缩后 messages，与此一致。
 */
export function messagesFromTranscriptEntries(entries: TranscriptEntry[]): {
  messages: ChatMessage[]
  meta?: TranscriptMetaEntry
  /** 是否应用了 compact_boundary 截断 */
  usedCompactBoundary: boolean
  /** 最后一条 title（若有） */
  title?: string
  /** 全部 system_note（文件序） */
  systemNotes?: Array<{ text: string; kind?: string; timestamp: string }>
} {
  let meta: TranscriptMetaEntry | undefined
  let lastBoundary = -1
  let title: string | undefined
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.type === 'meta' && !meta) meta = e
    if (e.type === 'compact_boundary') lastBoundary = i
    if (e.type === 'title') {
      const t = normalizeSessionTitle(e.title)
      if (t) title = t
    }
  }
  const systemNotes = systemNotesFromTranscriptEntries(entries)
  const messages: ChatMessage[] = []
  const start = lastBoundary >= 0 ? lastBoundary + 1 : 0
  for (let i = start; i < entries.length; i++) {
    const e = entries[i]!
    if (e.type === 'message') messages.push(cloneMessage(e.message))
  }
  return {
    messages,
    meta,
    usedCompactBoundary: lastBoundary >= 0,
    ...(title ? { title } : {}),
    ...(systemNotes.length ? { systemNotes } : {}),
  }
}

/**
 * 从 jsonl 重建线性 messages（R1：最后 compact_boundary 之后）。
 * J-C+ / J-D：loadSession / resumeSession 在同 id 有可用 jsonl messages 时优先用此重建。
 */
export async function loadTranscriptMessages(
  file: string,
  opts?: { maxBytes?: number },
): Promise<{
  messages: ChatMessage[]
  meta?: TranscriptMetaEntry
  path: string
  entryCount: number
  usedCompactBoundary: boolean
  title?: string
}> {
  const { entries, path: filePath } = await loadTranscriptFile(file, opts)
  const { messages, meta, usedCompactBoundary, title } =
    messagesFromTranscriptEntries(entries)
  return {
    messages,
    meta,
    path: filePath,
    entryCount: entries.length,
    usedCompactBoundary,
    ...(title ? { title } : {}),
  }
}

/** list 轻量扫描默认窗口：头/尾各 64KiB（对照 HC 有界头尾读语义） */
export const DEFAULT_LITE_SCAN_BYTES = 64 * 1024

export type TranscriptLiteScan = {
  sessionId?: string
  cwd?: string
  model?: string
  title?: string
  /** R1 后有效 message 条数 */
  messageCount: number
  /** user 预览（优先尾窗近况，否则首条 user） */
  preview: string
  lastTimestamp?: string
  noteCount: number
  /** 小文件一次读完 */
  fullScan: boolean
}

function tryParseLiteLine(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    const o = JSON.parse(t) as unknown
    if (!o || typeof o !== 'object') return null
    return o as Record<string, unknown>
  } catch {
    return null
  }
}

function extractUserPreviewFromMessageObj(
  message: unknown,
  max: number,
): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const m = message as Record<string, unknown>
  if (m.role !== 'user' || typeof m.content !== 'string') return undefined
  const one = m.content.replace(/\s+/g, ' ').trim()
  if (!one) return undefined
  if (one.length <= max) return one
  return `${one.slice(0, max - 1)}…`
}

/**
 * 有界头/尾扫描 jsonl，供 list 使用。
 * - 小文件（≤ 2×window）：一次读完
 * - 大文件：仍读全文计 message/title（list 正确性优先），但 preview 优先从尾窗取「近况」
 * 对照 HC readLiteMetadata：有界窗口取元数据；Bolo 最小版保证 list 字段正确。
 */
export async function scanTranscriptLite(
  file: string,
  opts?: { windowBytes?: number; previewMax?: number },
): Promise<TranscriptLiteScan> {
  const filePath = path.resolve(file)
  const windowBytes = opts?.windowBytes ?? DEFAULT_LITE_SCAN_BYTES
  const previewMax = opts?.previewMax ?? 80
  const st = await fs.stat(filePath)
  const size = st.size
  const fullScan = size <= windowBytes * 2

  const rawAll = await fs.readFile(filePath, 'utf8')

  let metaSessionId: string | undefined
  let cwd: string | undefined
  let model: string | undefined
  let title: string | undefined
  let lastTimestamp: string | undefined
  let lastBoundaryMsgIndex = -1
  let messageOrdinal = 0
  let noteCount = 0
  let firstUserPreview = ''
  let lastUserPreview = ''

  for (const line of rawAll.split(/\r?\n/)) {
    const o = tryParseLiteLine(line)
    if (!o || typeof o.type !== 'string') continue
    if (typeof o.timestamp === 'string' && o.timestamp.trim()) {
      lastTimestamp = o.timestamp
    }
    if (o.type === 'meta') {
      if (typeof o.sessionId === 'string' && o.sessionId.trim()) {
        metaSessionId = o.sessionId.trim()
      }
      if (typeof o.cwd === 'string') cwd = o.cwd
      if (typeof o.model === 'string') model = o.model
      continue
    }
    if (o.type === 'title' && typeof o.title === 'string') {
      const t = normalizeSessionTitle(o.title)
      if (t) title = t
      continue
    }
    if (o.type === 'system_note') {
      noteCount++
      continue
    }
    if (o.type === 'compact_boundary') {
      lastBoundaryMsgIndex = messageOrdinal
      continue
    }
    if (o.type === 'message') {
      const p = extractUserPreviewFromMessageObj(o.message, previewMax)
      if (p) {
        if (!firstUserPreview) firstUserPreview = p
        lastUserPreview = p
      }
      messageOrdinal++
    }
  }

  const messageCount =
    lastBoundaryMsgIndex >= 0
      ? Math.max(0, messageOrdinal - lastBoundaryMsgIndex)
      : messageOrdinal

  // 近况预览：有多条 user 时用最后一条（list 更贴最近对话）
  const preview = lastUserPreview || firstUserPreview

  return {
    ...(metaSessionId ? { sessionId: metaSessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(title ? { title } : {}),
    messageCount,
    preview,
    ...(lastTimestamp ? { lastTimestamp } : {}),
    noteCount,
    fullScan,
  }
}

/**
 * full compact 成功后写 jsonl：meta + compact_boundary + 当前 messages。
 * 不改 JSON 快照；同步 WeakMap 计数，避免后续 dualWrite 再 rewrite 抹掉 boundary。
 */
export async function writeTranscriptAfterCompact(
  session: PersistableSession,
  opts: {
    summary?: string
    filePath?: string
    sessionsDir?: string
    createdAt?: string
  },
): Promise<{ transcriptPath: string } | null> {
  let transcriptPath: string | undefined
  if (opts.filePath) {
    transcriptPath = resolveTranscriptPathFromJson(opts.filePath)
  } else if (opts.sessionsDir) {
    transcriptPath = resolveTranscriptFilePath(session.id, {
      sessionsDir: opts.sessionsDir,
    })
  } else {
    const prev = transcriptState.get(session)
    if (prev?.filePath) transcriptPath = prev.filePath
  }
  if (!transcriptPath) return null

  await rewriteTranscriptFromMessages(transcriptPath, session, {
    createdAt: opts.createdAt,
    compactBoundarySummary: opts.summary,
  })
  setTranscriptWriteState(session, {
    filePath: transcriptPath,
    appendedMessageCount: session.messages.length,
  })
  return { transcriptPath }
}

/**
 * T3 主写路径：只写 `{id}.jsonl`（增量 append / shrink rewrite）。
 * - 新文件：meta（含配置切片）+ 全部 messages
 * - 增量：只 append messages[lastCount..]
 * - messages 变短（compact）：全量 rewrite，并写入 compact_boundary（摘要可选）
 * - 冷启动（无 WeakMap）：按磁盘已有 message 行数作基线，避免 resume 后重复 append
 */
export async function dualWriteSessionTranscript(
  session: PersistableSession,
  jsonFilePath: string,
  opts?: { createdAt?: string; compactBoundarySummary?: string },
): Promise<{ transcriptPath: string; appended: number; rewritten: boolean }> {
  const transcriptPath = resolveTranscriptPathFromJson(jsonFilePath)
  const prev = transcriptState.get(session)
  let lastCount = prev?.appendedMessageCount
  if (lastCount === undefined) {
    lastCount = await countTranscriptMessageEntries(transcriptPath)
  }
  const total = session.messages.length
  const metaBase = metaInputFromSession(session, {
    createdAt: opts?.createdAt,
  })

  // messages 变短：全量重建（内存已是 compact 后链）；仅显式传入时写 compact_boundary
  if (lastCount > 0 && total < lastCount) {
    await rewriteTranscriptFromMessages(transcriptPath, session, {
      createdAt: opts?.createdAt,
      ...(opts && 'compactBoundarySummary' in opts
        ? { compactBoundarySummary: opts.compactBoundarySummary }
        : {}),
    })
    setTranscriptWriteState(session, {
      filePath: transcriptPath,
      appendedMessageCount: total,
    })
    return { transcriptPath, appended: total, rewritten: true }
  }

  await ensureTranscriptFile(transcriptPath, metaBase)

  // 磁盘 message 数已 ≥ 内存：视为已同步（resume 后无新消息再 save）
  if (lastCount >= total) {
    setTranscriptWriteState(session, {
      filePath: transcriptPath,
      appendedMessageCount: total,
    })
    return { transcriptPath, appended: 0, rewritten: false }
  }

  const delta = session.messages.slice(lastCount)
  const appended = await recordSessionMessages(transcriptPath, delta, {
    sessionId: session.id,
  })
  setTranscriptWriteState(session, {
    filePath: transcriptPath,
    appendedMessageCount: total,
  })
  return { transcriptPath, appended, rewritten: false }
}
