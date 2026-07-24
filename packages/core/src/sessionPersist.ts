/**
 * 会话 transcript 持久化（最小可用）
 *
 * 对照 HelsincyCode sessionStorage：有 session id、落盘、resume。
 * Bolo：**T3 默认只写 `.jsonl`**；旧 `.json` 快照只读兼容。
 * J-C+：同 id 同时有 `.json` + `.jsonl` 时 messages 优先 jsonl，meta 可从 json 补；无遥测。
 *
 * 路径：
 * - 项目：`<cwd>/.bolo/sessions/<id>.jsonl`（默认写）+ 可选旁路旧 `<id>.json`（只读）
 * - 用户：`~/.bolo/sessions/<id>.jsonl`（或 BOLO_CONFIG_DIR）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  getProjectLayout,
  getUserLayout,
} from '../../config/src/index.ts'
import {
  nowIso,
  type ChatMessage,
  type SessionPhase,
} from '../../shared/src/index.ts'
import {
  parsePermissionMode,
  type PermissionMode,
  type SessionPermissionRules,
} from '../../permissions/src/index.ts'
import {
  dualWriteSessionTranscript,
  loadTranscriptFile,
  loadTranscriptMessages,
  messagesFromTranscriptEntries,
  resolveTranscriptPathFromJson,
  rewriteTranscriptFromMessages,
  setTranscriptWriteState,
} from './sessionTranscript.ts'
import type { SessionUsage } from './sessionUsage.ts'
import { cloneSessionUsage } from './sessionUsage.ts'

/** 可落盘的会话切片（避免与 index 循环依赖） */
export type PersistableSession = {
  id: string
  cwd: string
  permissionMode: PermissionMode
  messages: ChatMessage[]
  systemPromptSections: string[]
  model?: string
  autoCompactEnabled: boolean
  contextWindowTokens: number
  maxPtlRetries: number
  phase?: SessionPhase
  /** 会话 Always-allow；可选落盘 */
  permissionRules?: SessionPermissionRules
  /** 会话 effort 档位；可选落盘 */
  effortLevel?: string
  /** 本地 token 累计；可选落盘，无遥测 */
  usage?: SessionUsage
  onEvent?: (e: { type: 'error'; message: string }) => void
}

/** 快照格式版本；破坏性变更时递增 */
export const SESSION_SNAPSHOT_VERSION = 1 as const

export type SessionScope = 'project' | 'user'

export type SessionSnapshot = {
  version: typeof SESSION_SNAPSHOT_VERSION
  id: string
  cwd: string
  permissionMode: PermissionMode
  messages: ChatMessage[]
  /**
   * system 段快照。resume 时默认优先按 cwd/mode 重建；
   * 重建关闭或失败时回退本字段。
   */
  systemPromptSections: string[]
  model?: string
  autoCompactEnabled: boolean
  contextWindowTokens: number
  maxPtlRetries: number
  createdAt: string
  updatedAt: string
  phase?: SessionPhase
  /** 会话 Always-allow（可选；旧快照无此字段） */
  permissionRules?: SessionPermissionRules
  /** 会话 effort 档位（可选） */
  effortLevel?: string
  /** 本地 token 累计（可选；无遥测） */
  usage?: SessionUsage
}

export type SaveSessionOptions = {
  /** 默认 project */
  scope?: SessionScope
  /** 覆盖 sessions 目录（测试用） */
  sessionsDir?: string
  /** 直接指定文件路径（优先于 id/scope；可为 .json 或 .jsonl） */
  filePath?: string
  /**
   * 是否仍写 JSON 快照。
   * - 默认 false（T3：只写 jsonl）
   * - true：兼容旧双写（json + jsonl）
   */
  writeJsonSnapshot?: boolean
  /**
   * 是否写 jsonl（默认 true）。
   * 仅当 writeJsonSnapshot=true 时，设 false 可只写 JSON（测试/逃生）。
   */
  writeTranscript?: boolean
}

export type LoadSessionOptions = {
  scope?: SessionScope
  /** load 时解析相对 id 的 cwd（project scope） */
  cwd?: string
  sessionsDir?: string
  filePath?: string
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/

function assertSafeSessionId(id: string): void {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error(`invalid session id: ${id}`)
  }
  if (!SAFE_ID.test(id)) {
    throw new Error(`invalid session id characters: ${id}`)
  }
}

/** 将 session id 规范为文件名（不含扩展名） */
export function sessionFileName(sessionId: string): string {
  assertSafeSessionId(sessionId)
  return `${sessionId}.json`
}

/**
 * 解析落盘路径。
 * - filePath 优先
 * - 否则 sessionsDir / scope + id
 */
export function resolveSessionFilePath(
  sessionId: string,
  options?: {
    scope?: SessionScope
    cwd?: string
    sessionsDir?: string
    filePath?: string
  },
): string {
  if (options?.filePath) {
    return path.resolve(options.filePath)
  }
  if (options?.sessionsDir) {
    return path.join(path.resolve(options.sessionsDir), sessionFileName(sessionId))
  }
  const scope = options?.scope ?? 'project'
  if (scope === 'user') {
    return path.join(getUserLayout().sessionsDir, sessionFileName(sessionId))
  }
  const cwd = options?.cwd ?? process.cwd()
  return path.join(getProjectLayout(cwd).sessionsDir, sessionFileName(sessionId))
}

/** 判断字符串是否像路径（含分隔符或 .json / .jsonl）而非纯 id */
export function looksLikeSessionPath(idOrPath: string): boolean {
  return (
    idOrPath.endsWith('.json') ||
    idOrPath.endsWith('.jsonl') ||
    idOrPath.includes('/') ||
    idOrPath.includes('\\') ||
    path.isAbsolute(idOrPath)
  )
}

/** 由 `.jsonl` 推导同目录 JSON 快照路径 */
export function resolveJsonPathFromTranscript(transcriptPath: string): string {
  const resolved = path.resolve(transcriptPath)
  if (resolved.endsWith('.jsonl')) {
    return resolved.slice(0, -'.jsonl'.length) + '.json'
  }
  if (resolved.endsWith('.json')) return resolved
  return `${resolved}.json`
}

export function resolveIdOrPath(
  idOrPath: string,
  options?: LoadSessionOptions,
): { id?: string; filePath: string } {
  if (options?.filePath) {
    return { filePath: path.resolve(options.filePath) }
  }
  if (looksLikeSessionPath(idOrPath)) {
    return { filePath: path.resolve(idOrPath) }
  }
  assertSafeSessionId(idOrPath)
  return {
    id: idOrPath,
    filePath: resolveSessionFilePath(idOrPath, {
      scope: options?.scope,
      cwd: options?.cwd,
      sessionsDir: options?.sessionsDir,
    }),
  }
}

function isChatMessage(x: unknown): x is ChatMessage {
  if (!x || typeof x !== 'object') return false
  const m = x as Record<string, unknown>
  if (typeof m.role !== 'string' || typeof m.content !== 'string') return false
  if (
    m.role !== 'system' &&
    m.role !== 'user' &&
    m.role !== 'assistant' &&
    m.role !== 'tool'
  ) {
    return false
  }
  if (m.tool_call_id !== undefined && typeof m.tool_call_id !== 'string') {
    return false
  }
  if (m.name !== undefined && typeof m.name !== 'string') return false
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls)) return false
    for (const tc of m.tool_calls) {
      if (!tc || typeof tc !== 'object') return false
      const t = tc as Record<string, unknown>
      if (
        typeof t.id !== 'string' ||
        typeof t.name !== 'string' ||
        typeof t.arguments !== 'string'
      ) {
        return false
      }
    }
  }
  return true
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
  return cloneSessionUsage(usage)
}

function parsePermissionRulesField(
  raw: unknown,
): SessionPermissionRules | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.alwaysAllowToolNames)) return undefined
  const names = o.alwaysAllowToolNames.filter(
    (n): n is string => typeof n === 'string' && n.trim().length > 0,
  )
  const out: SessionPermissionRules = { alwaysAllowToolNames: names }
  if (Array.isArray(o.alwaysAllowPrefixes)) {
    const prefixes = o.alwaysAllowPrefixes.filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    )
    if (prefixes.length) out.alwaysAllowPrefixes = prefixes
  }
  if (Array.isArray(o.alwaysAllowPathGlobs)) {
    const globs = o.alwaysAllowPathGlobs.filter(
      (g): g is string => typeof g === 'string' && g.trim().length > 0,
    )
    if (globs.length) out.alwaysAllowPathGlobs = globs
  }
  if (Array.isArray(o.alwaysAllowBashPrefixes)) {
    const bash = o.alwaysAllowBashPrefixes.filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    )
    if (bash.length) out.alwaysAllowBashPrefixes = bash
  }
  return out
}

function parseUsageField(raw: unknown): SessionUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined
  const inputTokens = num(o.inputTokens)
  const outputTokens = num(o.outputTokens)
  const totalTokens = num(o.totalTokens)
  const calls = num(o.calls)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    calls === undefined
  ) {
    return undefined
  }
  const out: SessionUsage = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    calls: calls ?? 0,
  }
  if (o.estimated === true) out.estimated = true
  const cacheRead = num(o.cacheReadInputTokens)
  if (cacheRead !== undefined && cacheRead > 0) {
    out.cacheReadInputTokens = cacheRead
  }
  const cacheCreate = num(o.cacheCreationInputTokens)
  if (cacheCreate !== undefined && cacheCreate > 0) {
    out.cacheCreationInputTokens = cacheCreate
  }
  if (o.byModel && typeof o.byModel === 'object' && !Array.isArray(o.byModel)) {
    const by: NonNullable<SessionUsage['byModel']> = {}
    for (const [k, v] of Object.entries(o.byModel as Record<string, unknown>)) {
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
      if (bcr !== undefined && bcr > 0) bucket.cacheReadInputTokens = bcr
      const bcc = num(b.cacheCreationInputTokens)
      if (bcc !== undefined && bcc > 0) bucket.cacheCreationInputTokens = bcc
      by[k] = bucket
    }
    if (Object.keys(by).length > 0) out.byModel = by
  }
  return out
}

/** JSON 安全序列化（剔除不可 JSON 的运行时句柄） */
export function toSnapshot(
  session: PersistableSession,
  previous?: Partial<SessionSnapshot>,
): SessionSnapshot {
  const createdAt = previous?.createdAt ?? nowIso()
  const permissionRules = clonePermissionRules(session.permissionRules)
  const usage = cloneUsage(session.usage)
  const effort =
    typeof session.effortLevel === 'string' && session.effortLevel.trim()
      ? session.effortLevel.trim()
      : undefined
  return {
    version: SESSION_SNAPSHOT_VERSION,
    id: session.id,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    messages: session.messages.map(cloneMessage),
    systemPromptSections: [...session.systemPromptSections],
    model: session.model,
    autoCompactEnabled: session.autoCompactEnabled,
    contextWindowTokens: session.contextWindowTokens,
    maxPtlRetries: session.maxPtlRetries,
    createdAt,
    updatedAt: nowIso(),
    phase: session.phase,
    ...(permissionRules ? { permissionRules } : {}),
    ...(effort ? { effortLevel: effort } : {}),
    ...(usage ? { usage } : {}),
  }
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

export function parseSessionSnapshot(raw: unknown): SessionSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('session snapshot: not an object')
  }
  const o = raw as Record<string, unknown>
  if (o.version !== 1 && o.version !== SESSION_SNAPSHOT_VERSION) {
    throw new Error(`session snapshot: unsupported version ${String(o.version)}`)
  }
  if (typeof o.id !== 'string' || !o.id) {
    throw new Error('session snapshot: missing id')
  }
  if (typeof o.cwd !== 'string') {
    throw new Error('session snapshot: missing cwd')
  }
  if (!Array.isArray(o.messages)) {
    throw new Error('session snapshot: messages must be array')
  }
  for (let i = 0; i < o.messages.length; i++) {
    if (!isChatMessage(o.messages[i])) {
      throw new Error(`session snapshot: invalid message at index ${i}`)
    }
  }
  const sections = Array.isArray(o.systemPromptSections)
    ? o.systemPromptSections.filter((s): s is string => typeof s === 'string')
    : []

  const permissionRules = parsePermissionRulesField(o.permissionRules)
  const usage = parseUsageField(o.usage)
  const effortLevel =
    typeof o.effortLevel === 'string' && o.effortLevel.trim()
      ? o.effortLevel.trim()
      : undefined

  return {
    version: SESSION_SNAPSHOT_VERSION,
    id: o.id,
    cwd: o.cwd,
    permissionMode: parsePermissionMode(o.permissionMode, 'default'),
    messages: o.messages as ChatMessage[],
    systemPromptSections: sections,
    model: typeof o.model === 'string' ? o.model : undefined,
    autoCompactEnabled: o.autoCompactEnabled === true,
    contextWindowTokens:
      typeof o.contextWindowTokens === 'number' && o.contextWindowTokens > 0
        ? o.contextWindowTokens
        : 128_000,
    maxPtlRetries:
      typeof o.maxPtlRetries === 'number' && o.maxPtlRetries >= 0
        ? Math.floor(o.maxPtlRetries)
        : 3,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : nowIso(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : nowIso(),
    phase:
      typeof o.phase === 'string'
        ? (o.phase as SessionPhase)
        : undefined,
    ...(permissionRules ? { permissionRules } : {}),
    ...(effortLevel ? { effortLevel } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** 原子写：temp + rename（Windows 上若目标存在则先 unlink） */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  const body = JSON.stringify(value, null, 2) + '\n'
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

export async function saveSession(
  session: PersistableSession,
  options?: SaveSessionOptions & {
    previous?: Partial<SessionSnapshot>
    /**
     * @deprecated 使用 writeTranscript；默认 true。false 时关闭 jsonl 写入。
     */
    dualWriteTranscript?: boolean
  },
): Promise<{ path: string; snapshot: SessionSnapshot; transcriptPath?: string }> {
  // 解析「逻辑 JSON 路径」用于配对 jsonl；T3 默认可不存在该文件
  const rawFilePath = options?.filePath
    ? path.resolve(options.filePath)
    : resolveSessionFilePath(session.id, {
        scope: options?.scope,
        cwd: session.cwd,
        sessionsDir: options?.sessionsDir,
      })
  const filePath = rawFilePath.endsWith('.jsonl')
    ? resolveJsonPathFromTranscript(rawFilePath)
    : rawFilePath
  const transcriptPath = resolveTranscriptPathFromJson(filePath)

  let previous = options?.previous
  if (!previous) {
    try {
      const existing = await loadSessionSnapshotFromPath(filePath)
      previous = existing
    } catch {
      // T3：无 JSON 时从 jsonl meta 取 createdAt
      try {
        const { meta } = await loadTranscriptMessages(transcriptPath)
        if (meta?.createdAt) previous = { createdAt: meta.createdAt }
      } catch {
        previous = undefined
      }
    }
  }

  const snapshot = toSnapshot(session, previous)
  const writeJson = options?.writeJsonSnapshot === true
  const writeTranscript =
    options?.writeTranscript !== false && options?.dualWriteTranscript !== false

  if (writeJson) {
    await atomicWriteJson(filePath, snapshot)
  }

  // T3 默认：只写 jsonl；失败在仅 jsonl 模式下抛出，双写兼容时不阻断 JSON
  let outTranscript: string | undefined
  if (writeTranscript) {
    try {
      const tw = await dualWriteSessionTranscript(session, filePath, {
        createdAt: snapshot.createdAt,
      })
      outTranscript = tw.transcriptPath
    } catch (err) {
      if (!writeJson) throw err
      const message = err instanceof Error ? err.message : String(err)
      session.onEvent?.({
        type: 'error',
        message: `transcript dual-write failed: ${message}`,
      })
    }
  }

  // 返回 path：有 JSON 则 JSON；否则 jsonl（便于调用方展示真实落盘）
  const returnPath =
    writeJson || !outTranscript ? filePath : outTranscript

  return {
    path: returnPath,
    snapshot,
    transcriptPath: outTranscript,
  }
}

export type MigrateSessionOptions = LoadSessionOptions & {
  /** 默认 false：不删旧 .json；true 则旁路写出 jsonl 后 unlink JSON */
  deleteJson?: boolean
  /** 已有非空 jsonl 时是否强制 rewrite */
  force?: boolean
}

/**
 * 将旧 JSON 快照旁路写出为 jsonl（D2）。
 * - 不删旧 json（除非 deleteJson）
 * - 已有 jsonl 且含 message 时默认跳过 rewrite（除非 force）
 */
export async function migrateSessionToJsonl(
  idOrPath: string,
  options?: MigrateSessionOptions,
): Promise<{
  jsonPath: string
  transcriptPath: string
  wrote: boolean
  deletedJson: boolean
  messageCount: number
}> {
  const { path: loadedPath, snapshot } = await loadSession(idOrPath, options)
  const jsonPath = loadedPath.endsWith('.jsonl')
    ? resolveJsonPathFromTranscript(loadedPath)
    : path.resolve(loadedPath)
  const transcriptPath = resolveTranscriptPathFromJson(jsonPath)

  let existingMessages = 0
  try {
    const t = await loadTranscriptMessages(transcriptPath)
    existingMessages = t.messages.length
  } catch {
    existingMessages = 0
  }

  if (existingMessages > 0 && !options?.force) {
    return {
      jsonPath,
      transcriptPath,
      wrote: false,
      deletedJson: false,
      messageCount: existingMessages,
    }
  }

  const session: PersistableSession = {
    id: snapshot.id,
    cwd: snapshot.cwd,
    permissionMode: snapshot.permissionMode,
    messages: snapshot.messages.map((m) => ({ ...m })),
    systemPromptSections: [...snapshot.systemPromptSections],
    model: snapshot.model,
    autoCompactEnabled: snapshot.autoCompactEnabled,
    contextWindowTokens: snapshot.contextWindowTokens,
    maxPtlRetries: snapshot.maxPtlRetries,
    phase: snapshot.phase,
    permissionRules: snapshot.permissionRules,
    effortLevel: snapshot.effortLevel,
    usage: snapshot.usage,
  }

  await rewriteTranscriptFromMessages(transcriptPath, session, {
    createdAt: snapshot.createdAt,
  })
  setTranscriptWriteState(session, {
    filePath: transcriptPath,
    appendedMessageCount: session.messages.length,
  })

  let deletedJson = false
  if (options?.deleteJson) {
    try {
      await fs.unlink(jsonPath)
      deletedJson = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    }
  }

  return {
    jsonPath,
    transcriptPath,
    wrote: true,
    deletedJson,
    messageCount: snapshot.messages.length,
  }
}

async function loadSessionSnapshotFromPath(
  filePath: string,
): Promise<SessionSnapshot> {
  const raw = await fs.readFile(filePath, 'utf8')
  return parseSessionSnapshot(JSON.parse(raw) as unknown)
}

function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /ENOENT|no such file|session not found/i.test(msg)
}

/**
 * 从 `.jsonl` 建最小快照（无 JSON 时）；meta 行提供配置切片（T3 扩展字段）。
 */
async function snapshotFromTranscriptOnly(
  transcriptPath: string,
  opts?: { idHint?: string; cwd?: string },
): Promise<SessionSnapshot> {
  const { messages, meta, path: tPath } = await loadTranscriptMessages(
    transcriptPath,
  )
  const jsonPath = resolveJsonPathFromTranscript(tPath)
  const id =
    meta?.sessionId ||
    path.basename(jsonPath).replace(/\.json$/i, '') ||
    opts?.idHint ||
    'unknown'
  const now = nowIso()
  const mode = parsePermissionMode(
    typeof meta?.permissionMode === 'string' ? meta.permissionMode : 'default',
  )
  const permissionRules = meta?.permissionRules
    ? {
        alwaysAllowToolNames: [...meta.permissionRules.alwaysAllowToolNames],
        ...(meta.permissionRules.alwaysAllowPrefixes?.length
          ? {
              alwaysAllowPrefixes: [
                ...meta.permissionRules.alwaysAllowPrefixes,
              ],
            }
          : {}),
        ...(meta.permissionRules.alwaysAllowPathGlobs?.length
          ? {
              alwaysAllowPathGlobs: [
                ...meta.permissionRules.alwaysAllowPathGlobs,
              ],
            }
          : {}),
        ...(meta.permissionRules.alwaysAllowBashPrefixes?.length
          ? {
              alwaysAllowBashPrefixes: [
                ...meta.permissionRules.alwaysAllowBashPrefixes,
              ],
            }
          : {}),
      }
    : undefined
  const usage = meta?.usage
    ? cloneSessionUsage(meta.usage)
    : undefined
  return {
    version: SESSION_SNAPSHOT_VERSION,
    id,
    cwd: meta?.cwd ?? opts?.cwd ?? process.cwd(),
    permissionMode: mode,
    messages,
    systemPromptSections: meta?.systemPromptSections
      ? [...meta.systemPromptSections]
      : [],
    model: meta?.model,
    autoCompactEnabled:
      typeof meta?.autoCompactEnabled === 'boolean'
        ? meta.autoCompactEnabled
        : true,
    contextWindowTokens:
      typeof meta?.contextWindowTokens === 'number'
        ? meta.contextWindowTokens
        : 128_000,
    maxPtlRetries:
      typeof meta?.maxPtlRetries === 'number' ? meta.maxPtlRetries : 3,
    createdAt: meta?.createdAt ?? now,
    updatedAt: meta?.updatedAt ?? now,
    ...(meta?.phase ? { phase: meta.phase as SessionPhase } : {}),
    ...(permissionRules ? { permissionRules } : {}),
    ...(meta?.effortLevel ? { effortLevel: meta.effortLevel } : {}),
    ...(usage ? { usage } : {}),
  }
}

/**
 * J-C+：同目录 `.json` + `.jsonl` 时 messages 优先 transcript；
 * meta / system / 配置切片可从 JSON 补；仅有其一则用其一。
 * 返回 path 始终为 JSON 侧路径（便于 autoSave 写回）。
 */
export async function loadSessionPair(
  jsonPath: string,
  opts?: { idHint?: string; cwd?: string },
): Promise<{ path: string; snapshot: SessionSnapshot; fromTranscript: boolean }> {
  const resolvedJson = path.resolve(jsonPath)
  const transcriptPath = resolveTranscriptPathFromJson(resolvedJson)

  let jsonSnap: SessionSnapshot | undefined
  try {
    jsonSnap = await loadSessionSnapshotFromPath(resolvedJson)
  } catch (err) {
    if (!isMissingFileError(err)) throw err
  }

  let transcript:
    | Awaited<ReturnType<typeof loadTranscriptMessages>>
    | undefined
  try {
    transcript = await loadTranscriptMessages(transcriptPath)
  } catch (err) {
    if (!isMissingFileError(err)) throw err
  }

  if (jsonSnap && transcript) {
    // 双文件：jsonl 有可用 messages（R1 后非空）则优先；空/全坏行则回退 JSON
    const useTranscript = transcript.messages.length > 0
    return {
      path: resolvedJson,
      snapshot: {
        ...jsonSnap,
        messages: useTranscript ? transcript.messages : jsonSnap.messages,
        // meta 可补 JSON 缺省
        model: jsonSnap.model ?? transcript.meta?.model,
        cwd: jsonSnap.cwd || transcript.meta?.cwd || opts?.cwd || process.cwd(),
        createdAt: jsonSnap.createdAt || transcript.meta?.createdAt || jsonSnap.createdAt,
      },
      fromTranscript: useTranscript,
    }
  }

  if (jsonSnap) {
    return { path: resolvedJson, snapshot: jsonSnap, fromTranscript: false }
  }

  if (transcript) {
    const snapshot = await snapshotFromTranscriptOnly(transcriptPath, {
      idHint: opts?.idHint,
      cwd: opts?.cwd,
    })
    // T3：仅有 jsonl 时 path 指向真实文件，便于 CLI/autoSave 展示与回写
    return { path: transcriptPath, snapshot, fromTranscript: true }
  }

  throw new Error(`session not found: ${resolvedJson} (json and jsonl)`)
}

/**
 * 读会话快照（J-C+：同 id 有 jsonl 时 messages 优先 jsonl）。
 * - 路径 / filePath / sessionsDir / 显式 scope：只查该处
 * - 纯 id 且未指定 scope/sessionsDir：先 project（cwd），再 user（~/.bolo）
 * - 显式 `.jsonl`：读 transcript，meta 可从旁路 `.json` 补
 */
export async function loadSession(
  idOrPath: string,
  options?: LoadSessionOptions,
): Promise<{ path: string; snapshot: SessionSnapshot }> {
  const cwd = options?.cwd

  if (options?.filePath) {
    const filePath = path.resolve(options.filePath)
    if (filePath.endsWith('.jsonl')) {
      const jsonPath = resolveJsonPathFromTranscript(filePath)
      const loaded = await loadSessionPair(jsonPath, {
        idHint: idOrPath,
        cwd,
      })
      return { path: loaded.path, snapshot: loaded.snapshot }
    }
    const loaded = await loadSessionPair(filePath, { idHint: idOrPath, cwd })
    return { path: loaded.path, snapshot: loaded.snapshot }
  }

  if (looksLikeSessionPath(idOrPath)) {
    const filePath = path.resolve(idOrPath)
    if (filePath.endsWith('.jsonl')) {
      const jsonPath = resolveJsonPathFromTranscript(filePath)
      const loaded = await loadSessionPair(jsonPath, {
        idHint: path.basename(jsonPath, '.json'),
        cwd,
      })
      return { path: loaded.path, snapshot: loaded.snapshot }
    }
    const loaded = await loadSessionPair(filePath, {
      idHint: path.basename(filePath, '.json'),
      cwd,
    })
    return { path: loaded.path, snapshot: loaded.snapshot }
  }

  if (options?.sessionsDir || options?.scope) {
    const { filePath } = resolveIdOrPath(idOrPath, options)
    const loaded = await loadSessionPair(filePath, { idHint: idOrPath, cwd })
    return { path: loaded.path, snapshot: loaded.snapshot }
  }

  // 纯 id：project → user
  const projectPath = resolveSessionFilePath(idOrPath, {
    scope: 'project',
    cwd: options?.cwd,
  })
  try {
    const loaded = await loadSessionPair(projectPath, {
      idHint: idOrPath,
      cwd: options?.cwd,
    })
    return { path: loaded.path, snapshot: loaded.snapshot }
  } catch (err) {
    if (!isMissingFileError(err)) throw err
  }
  const userPath = resolveSessionFilePath(idOrPath, { scope: 'user' })
  try {
    const loaded = await loadSessionPair(userPath, {
      idHint: idOrPath,
      cwd: options?.cwd,
    })
    return { path: loaded.path, snapshot: loaded.snapshot }
  } catch (err) {
    if (isMissingFileError(err)) {
      throw new Error(
        `session not found: ${idOrPath} (looked in project and user sessions)`,
      )
    }
    throw err
  }
}

/**
 * 将快照字段写回 live session（就地替换 messages 数组内容，保持引用）
 */
export function applySnapshotToSession(
  session: PersistableSession,
  snapshot: SessionSnapshot,
  options?: { restoreSystemSections?: boolean },
): void {
  session.messages.length = 0
  session.messages.push(...snapshot.messages.map(cloneMessage))
  if (options?.restoreSystemSections) {
    session.systemPromptSections = [...snapshot.systemPromptSections]
  }
  session.permissionMode = snapshot.permissionMode
  if (snapshot.model !== undefined) session.model = snapshot.model
  session.autoCompactEnabled = snapshot.autoCompactEnabled
  session.contextWindowTokens = snapshot.contextWindowTokens
  session.maxPtlRetries = snapshot.maxPtlRetries
  if (snapshot.permissionRules) {
    session.permissionRules = clonePermissionRules(snapshot.permissionRules)!
  }
  if (snapshot.effortLevel !== undefined) {
    session.effortLevel = snapshot.effortLevel
  }
  if (snapshot.usage) {
    session.usage = cloneUsage(snapshot.usage)
  }
}

/** 挂在 session 上的持久化元数据（运行时，不进 JSON） */
export type SessionPersistMeta = {
  autoSave: boolean
  scope: SessionScope
  sessionsDir?: string
  filePath?: string
  createdAt?: string
}

const persistMeta = new WeakMap<object, SessionPersistMeta>()

export function setSessionPersistMeta(
  session: object,
  meta: Partial<SessionPersistMeta>,
): void {
  const prev = persistMeta.get(session) ?? {
    autoSave: false,
    scope: 'project' as SessionScope,
  }
  persistMeta.set(session, { ...prev, ...meta })
}

export function getSessionPersistMeta(
  session: object,
): SessionPersistMeta | undefined {
  return persistMeta.get(session)
}

/**
 * 若 session 开启 autoSave，则按 meta 写盘（失败只打事件，不抛）
 */
export async function maybeAutoSaveSession(
  session: PersistableSession,
): Promise<void> {
  const meta = persistMeta.get(session)
  if (!meta?.autoSave) return
  try {
    const { path: p, snapshot } = await saveSession(session, {
      scope: meta.scope,
      sessionsDir: meta.sessionsDir,
      filePath: meta.filePath,
      previous: meta.createdAt ? { createdAt: meta.createdAt } : undefined,
    })
    setSessionPersistMeta(session, {
      createdAt: snapshot.createdAt,
      filePath: meta.filePath ?? p,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    session.onEvent?.({ type: 'error', message: `autoSave failed: ${message}` })
  }
}

/** 项目会话列表项（对齐 HC listSessions 轻量字段，无遥测） */
export type SessionListItem = {
  id: string
  filePath: string
  /** ISO：优先 snapshot.updatedAt，否则文件 mtime */
  updatedAt: string
  messageCount: number
  /** 首条有意义 user 摘要，截断 */
  preview: string
  cwd?: string
  model?: string
}

const PREVIEW_MAX = 80

/** 从 messages 取首条非空 user 内容摘要 */
export function sessionPreviewFromMessages(
  messages: unknown,
  max = PREVIEW_MAX,
): string {
  if (!Array.isArray(messages)) return ''
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const row = m as Record<string, unknown>
    if (row.role !== 'user') continue
    if (typeof row.content !== 'string') continue
    const one = row.content.replace(/\s+/g, ' ').trim()
    if (!one) continue
    if (one.length <= max) return one
    return `${one.slice(0, max - 1)}…`
  }
  return ''
}

/**
 * 从 jsonl 粗提列表字段（坏行跳过；messageCount/preview 走 R1 boundary）。
 * 半行/损坏行：JSON.parse 失败则跳过。
 */
async function sessionListItemFromJsonl(
  filePath: string,
  idFromFile: string,
  mtime: Date,
): Promise<SessionListItem | null> {
  let entries: Awaited<ReturnType<typeof loadTranscriptFile>>['entries']
  try {
    ;({ entries } = await loadTranscriptFile(filePath))
  } catch {
    return null
  }

  const { messages, meta } = messagesFromTranscriptEntries(entries)
  const id =
    (meta?.sessionId && meta.sessionId.trim()) || idFromFile
  let lastTs: string | undefined
  for (const e of entries) {
    if (typeof e.timestamp === 'string' && e.timestamp.trim()) {
      lastTs = e.timestamp
    }
  }

  const mtimeIso = mtime.toISOString()
  return {
    id,
    filePath,
    // 仅 jsonl：优先文件 mtime（列表新鲜度），无 mtime 时回退末行 timestamp
    updatedAt: mtimeIso || lastTs || new Date(0).toISOString(),
    messageCount: messages.length,
    preview: sessionPreviewFromMessages(messages),
    cwd: meta?.cwd,
    model: meta?.model,
  }
}

/** 取较新的 ISO 时间（解析失败则回退字符串比较） */
function newerIso(a: string, b: string): string {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return tb >= ta ? b : a
  }
  return b.localeCompare(a) >= 0 ? b : a
}

/**
 * 列出当前项目 `.bolo/sessions` 下 `*.json` 与 `*.jsonl`（可覆盖 sessionsDir）。
 * 同 id 去重（J-D）：
 * - 配置/path：优先 JSON 路径与 model/cwd
 * - messageCount / preview：有可用 jsonl messages 时跟 jsonl（R1）
 * - updatedAt：取 JSON updatedAt 与 jsonl mtime 较新者
 * 按 updatedAt 降序；坏文件跳过。
 */
export async function listProjectSessions(opts: {
  cwd: string
  sessionsDir?: string
  limit?: number
}): Promise<SessionListItem[]> {
  const sessionsDir =
    opts.sessionsDir ?? getProjectLayout(opts.cwd).sessionsDir
  const limit = opts.limit ?? 50

  let names: string[]
  try {
    names = await fs.readdir(sessionsDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return []
    throw err
  }

  type ListAcc = SessionListItem & {
    fromJson?: boolean
    fromJsonl?: boolean
  }
  const byId = new Map<string, ListAcc>()

  for (const name of names) {
    if (name.startsWith('.')) continue
    const isJson = name.endsWith('.json')
    const isJsonl = name.endsWith('.jsonl')
    if (!isJson && !isJsonl) continue

    const filePath = path.join(sessionsDir, name)
    try {
      const st = await fs.stat(filePath)
      if (!st.isFile()) continue

      if (isJson) {
        const raw = await fs.readFile(filePath, 'utf8')
        let parsed: unknown
        try {
          parsed = JSON.parse(raw) as unknown
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object') continue
        const o = parsed as Record<string, unknown>
        const idFromFile = name.slice(0, -'.json'.length)
        const id =
          typeof o.id === 'string' && o.id.trim() ? o.id.trim() : idFromFile
        const messages = Array.isArray(o.messages) ? o.messages : []
        const mtimeIso = st.mtime.toISOString()
        const updatedAt =
          typeof o.updatedAt === 'string' && o.updatedAt.trim()
            ? o.updatedAt
            : mtimeIso
        const prev = byId.get(id)
        if (prev?.fromJsonl) {
          // 已有 jsonl：path/配置用 JSON；消息预览保留 jsonl（若有）
          const keepJsonlMsgs = prev.messageCount > 0 || prev.preview.length > 0
          byId.set(id, {
            id,
            filePath,
            updatedAt: newerIso(prev.updatedAt, updatedAt),
            messageCount: keepJsonlMsgs ? prev.messageCount : messages.length,
            preview: keepJsonlMsgs
              ? prev.preview
              : sessionPreviewFromMessages(messages),
            cwd:
              typeof o.cwd === 'string'
                ? o.cwd
                : prev.cwd,
            model:
              typeof o.model === 'string'
                ? o.model
                : prev.model,
            fromJson: true,
            fromJsonl: true,
          })
        } else {
          byId.set(id, {
            id,
            filePath,
            updatedAt,
            messageCount: messages.length,
            preview: sessionPreviewFromMessages(messages),
            cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
            model: typeof o.model === 'string' ? o.model : undefined,
            fromJson: true,
          })
        }
        continue
      }

      // *.jsonl
      const idFromFile = name.slice(0, -'.jsonl'.length)
      const item = await sessionListItemFromJsonl(filePath, idFromFile, st.mtime)
      if (!item) continue
      const prev = byId.get(item.id)
      if (prev?.fromJson) {
        // 已有 JSON：messages/preview 用 jsonl（R1，非空时）；path 仍 JSON
        const useJsonlMsgs = item.messageCount > 0
        byId.set(item.id, {
          id: prev.id,
          filePath: prev.filePath,
          updatedAt: newerIso(prev.updatedAt, item.updatedAt),
          messageCount: useJsonlMsgs ? item.messageCount : prev.messageCount,
          preview: useJsonlMsgs ? item.preview : prev.preview,
          cwd: prev.cwd ?? item.cwd,
          model: prev.model ?? item.model,
          fromJson: true,
          fromJsonl: true,
        })
        continue
      }
      byId.set(item.id, { ...item, fromJsonl: true })
    } catch {
      // 坏文件 / 不可读：跳过
      continue
    }
  }

  const items: SessionListItem[] = [...byId.values()].map(
    ({ fromJson: _j, fromJsonl: _l, ...rest }) => rest,
  )

  items.sort((a, b) => {
    const ta = Date.parse(a.updatedAt)
    const tb = Date.parse(b.updatedAt)
    if (Number.isFinite(tb) && Number.isFinite(ta) && tb !== ta) {
      return tb - ta
    }
    // 回退：字符串降序
    return b.updatedAt.localeCompare(a.updatedAt)
  })

  return items.slice(0, Math.max(0, limit))
}