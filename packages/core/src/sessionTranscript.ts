/**
 * 会话 JSONL transcript（T3：默认主路径只写 jsonl）
 *
 * 对照 HelsincyCode sessionStorage 的 JSONL 追加语义；无遥测。
 * T1 曾双写 JSON+jsonl；J-C+/J-D：resume messages 优先 jsonl；
 * T3：save 默认停写 JSON，meta 承载配置切片，旧 JSON 只读兼容。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { nowIso, type ChatMessage } from '../../shared/src/index.ts'
import type {
  PermissionMode,
  SessionPermissionRules,
} from '../../permissions/src/index.ts'
import type { PersistableSession } from './sessionPersist.ts'
import type { SessionUsage } from './sessionUsage.ts'

/** 公共头字段（线性 transcript，不强制 parentUuid） */
export type TranscriptEntryBase = {
  sessionId: string
  timestamp: string
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

export type TranscriptEntry =
  | TranscriptMetaEntry
  | TranscriptMessageEntry
  | TranscriptCompactBoundaryEntry

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
  return out
}

function cloneUsage(usage: SessionUsage | undefined): SessionUsage | undefined {
  if (!usage) return undefined
  const out: SessionUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    calls: usage.calls,
  }
  if (usage.estimated) out.estimated = true
  return out
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
    ...(usage ? { usage } : {}),
  }
}

/** UTF-8 一行 JSON + `\n`；确保目录存在 */
export async function appendTranscriptLine(
  file: string,
  entry: TranscriptEntry,
): Promise<void> {
  const filePath = path.resolve(file)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const line = JSON.stringify(entry) + '\n'
  await fs.appendFile(filePath, line, 'utf8')
}

/**
 * 若文件不存在则写首行 `meta`；已存在则不改动。
 * @returns 是否新建了文件
 */
export async function ensureTranscriptFile(
  file: string,
  meta: TranscriptMetaInput,
): Promise<boolean> {
  const filePath = path.resolve(file)
  try {
    await fs.access(filePath)
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') throw err
  }

  await appendTranscriptLine(filePath, buildMetaEntry(meta))
  return true
}

/** 将 messages 编成 `message` entry 依次追加 */
export async function recordSessionMessages(
  file: string,
  messages: ChatMessage[],
  opts?: { sessionId?: string },
): Promise<number> {
  if (!messages.length) return 0
  const sessionId = opts?.sessionId ?? ''
  let n = 0
  for (const m of messages) {
    const entry: TranscriptMessageEntry = {
      type: 'message',
      sessionId,
      timestamp: nowIso(),
      message: cloneMessage(m),
    }
    await appendTranscriptLine(file, entry)
    n++
  }
  return n
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
 * 从 messages 全量重建 jsonl（meta + 可选 compact_boundary + 全部 message）。
 * 用于 compact 后 messages 变短等无法纯 append 的情况。
 */
export async function rewriteTranscriptFromMessages(
  file: string,
  session: PersistableSession,
  opts?: { createdAt?: string; compactBoundarySummary?: string },
): Promise<void> {
  const filePath = path.resolve(file)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
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
      if (o.type === 'compact_boundary') {
        entries.push({
          type: 'compact_boundary',
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          timestamp:
            typeof o.timestamp === 'string' ? o.timestamp : nowIso(),
          summary: typeof o.summary === 'string' ? o.summary : undefined,
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
 * compact 后 rewrite 的 jsonl 为 meta+boundary+压缩后 messages，与此一致。
 */
export function messagesFromTranscriptEntries(entries: TranscriptEntry[]): {
  messages: ChatMessage[]
  meta?: TranscriptMetaEntry
  /** 是否应用了 compact_boundary 截断 */
  usedCompactBoundary: boolean
} {
  let meta: TranscriptMetaEntry | undefined
  let lastBoundary = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.type === 'meta' && !meta) meta = e
    if (e.type === 'compact_boundary') lastBoundary = i
  }
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
}> {
  const { entries, path: filePath } = await loadTranscriptFile(file, opts)
  const { messages, meta, usedCompactBoundary } =
    messagesFromTranscriptEntries(entries)
  return {
    messages,
    meta,
    path: filePath,
    entryCount: entries.length,
    usedCompactBoundary,
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