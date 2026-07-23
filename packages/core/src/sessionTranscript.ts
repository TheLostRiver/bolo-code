/**
 * 会话 JSONL transcript（T1 双写：append-only）
 *
 * 对照 HelsincyCode sessionStorage 的 JSONL 追加语义；无遥测。
 * T1：与 JSON 快照并行写入；resume 仍读 JSON（见 docs/SESSIONS.md）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { nowIso, type ChatMessage } from '../../shared/src/index.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'
import type { PersistableSession } from './sessionPersist.ts'

/** 公共头字段（线性 transcript，不强制 parentUuid） */
export type TranscriptEntryBase = {
  sessionId: string
  timestamp: string
  uuid?: string
}

export type TranscriptMetaEntry = TranscriptEntryBase & {
  type: 'meta'
  cwd?: string
  permissionMode?: PermissionMode | string
  model?: string
  createdAt?: string
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

  const entry: TranscriptMetaEntry = {
    type: 'meta',
    sessionId: meta.sessionId,
    timestamp: nowIso(),
    cwd: meta.cwd,
    permissionMode: meta.permissionMode,
    model: meta.model,
    createdAt: meta.createdAt ?? nowIso(),
  }
  await appendTranscriptLine(filePath, entry)
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
 * 从 messages 全量重建 jsonl（meta + 全部 message）。
 * 用于 compact 后 messages 变短等无法纯 append 的情况。
 */
export async function rewriteTranscriptFromMessages(
  file: string,
  session: PersistableSession,
  opts?: { createdAt?: string },
): Promise<void> {
  const filePath = path.resolve(file)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const lines: string[] = []
  const meta: TranscriptMetaEntry = {
    type: 'meta',
    sessionId: session.id,
    timestamp: nowIso(),
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    model: session.model,
    createdAt: opts?.createdAt ?? nowIso(),
  }
  lines.push(JSON.stringify(meta))
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

/**
 * T1 双写：在 JSON 快照旁增量 append `{id}.jsonl`。
 * - 新文件：meta + 全部 messages
 * - 增量：只 append messages[lastCount..]
 * - messages 变短（compact）：全量 rewrite（不先写 boundary 到旧尾再 rewrite，避免噪音）
 * - 冷启动（无 WeakMap）：按磁盘已有 message 行数作基线，避免 resume 后重复 append
 */
export async function dualWriteSessionTranscript(
  session: PersistableSession,
  jsonFilePath: string,
  opts?: { createdAt?: string },
): Promise<{ transcriptPath: string; appended: number; rewritten: boolean }> {
  const transcriptPath = resolveTranscriptPathFromJson(jsonFilePath)
  const prev = transcriptState.get(session)
  let lastCount = prev?.appendedMessageCount
  if (lastCount === undefined) {
    lastCount = await countTranscriptMessageEntries(transcriptPath)
  }
  const total = session.messages.length

  // messages 变短：全量重建（内存已是 compact 后链）
  if (lastCount > 0 && total < lastCount) {
    await rewriteTranscriptFromMessages(transcriptPath, session, {
      createdAt: opts?.createdAt,
    })
    setTranscriptWriteState(session, {
      filePath: transcriptPath,
      appendedMessageCount: total,
    })
    return { transcriptPath, appended: total, rewritten: true }
  }

  await ensureTranscriptFile(transcriptPath, {
    sessionId: session.id,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    model: session.model,
    createdAt: opts?.createdAt,
  })

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