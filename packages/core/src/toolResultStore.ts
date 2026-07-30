import { createHash } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { getWorkspaceSessionsDir } from '../../config/src/index.ts'
import type { ToolResultReference } from '../../shared/src/index.ts'

export const DEFAULT_TOOL_RESULT_CHUNK_BYTES = 16 * 1024
export const MAX_TOOL_RESULT_CHUNK_BYTES = 64 * 1024

export type ToolResultReadFailureReason =
  | 'invalid-reference'
  | 'invalid-offset'
  | 'path-escape'
  | 'session-mismatch'
  | 'symlink'
  | 'missing'
  | 'not-file'
  | 'size-mismatch'
  | 'invalid-utf8'
  | 'aborted'
  | 'read-error'

export type ToolResultChunkReadRequest = {
  cwd: string
  sessionId: string
  reference: ToolResultReference
  offset: number
  maxBytes?: number
  signal?: AbortSignal
}

export type ToolResultChunkReadResult =
  | {
      ok: true
      text: string
      offset: number
      nextOffset: number
      totalBytes: number
      eof: boolean
    }
  | {
      ok: false
      reason: ToolResultReadFailureReason
      message: string
    }

export type ToolResultChunkReader = (
  request: ToolResultChunkReadRequest,
) => Promise<ToolResultChunkReadResult>

export type ToolResultSessionCleanupResult = {
  removed: boolean
  reason?: 'missing' | 'symlink' | 'unsafe-path' | 'remove-error'
}

function safeStoreSegment(value: string, fallback: string): string {
  const normalized = value.normalize('NFC')
  const readable = normalized
    .replace(/[^a-zA-Z0-9._-]+/gu, '_')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 72)
  const digest = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 10)
  return `${readable || fallback}-${digest}`
}

function toolResultRoot(cwd: string): string {
  return path.resolve(getWorkspaceSessionsDir(cwd), 'tool-results')
}

export function resolveToolResultSessionDirectory(
  cwd: string,
  sessionId: string,
): string {
  return path.resolve(
    toolResultRoot(cwd),
    safeStoreSegment(sessionId, 'session'),
  )
}

export function resolveToolResultFilePath(
  cwd: string,
  sessionId: string,
  toolUseId: string,
): string {
  return path.resolve(
    resolveToolResultSessionDirectory(cwd, sessionId),
    `${safeStoreSegment(toolUseId, 'tool')}.txt`,
  )
}

function isDirectChild(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    path.dirname(relative) === '.'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function lstatOrReason(
  target: string,
): Promise<
  | { ok: true; stat: Awaited<ReturnType<typeof fs.lstat>> }
  | { ok: false; reason: 'missing' | 'read-error'; message: string }
> {
  try {
    return { ok: true, stat: await fs.lstat(target) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        ok: false,
        reason: 'missing',
        message: `tool result is missing: ${target}`,
      }
    }
    return {
      ok: false,
      reason: 'read-error',
      message: `cannot inspect tool result path: ${errorMessage(error)}`,
    }
  }
}

async function validateReferencePath(
  request: ToolResultChunkReadRequest,
): Promise<
  | {
      ok: true
      filePath: string
      totalBytes: number
    }
  | Extract<ToolResultChunkReadResult, { ok: false }>
> {
  const { reference } = request
  if (
    reference.kind !== 'session-file' ||
    !path.isAbsolute(reference.path) ||
    !Number.isInteger(reference.bytes) ||
    reference.bytes < 0
  ) {
    return {
      ok: false,
      reason: 'invalid-reference',
      message: 'tool result reference is malformed',
    }
  }

  const root = toolResultRoot(request.cwd)
  const sessionDir = resolveToolResultSessionDirectory(
    request.cwd,
    request.sessionId,
  )
  const filePath = path.resolve(reference.path)
  const rootRelative = path.relative(root, filePath)
  if (
    !rootRelative ||
    rootRelative.startsWith('..') ||
    path.isAbsolute(rootRelative)
  ) {
    return {
      ok: false,
      reason: 'path-escape',
      message: 'tool result path is outside the workspace session store',
    }
  }
  if (!isDirectChild(sessionDir, filePath)) {
    return {
      ok: false,
      reason: 'session-mismatch',
      message: 'tool result path does not belong to this session',
    }
  }

  for (const directory of [root, sessionDir]) {
    const inspected = await lstatOrReason(directory)
    if (!inspected.ok) return inspected
    if (inspected.stat.isSymbolicLink()) {
      return {
        ok: false,
        reason: 'symlink',
        message: `tool result store contains a symbolic link: ${directory}`,
      }
    }
    if (!inspected.stat.isDirectory()) {
      return {
        ok: false,
        reason: 'not-file',
        message: `tool result store path is not a directory: ${directory}`,
      }
    }
  }

  const inspectedFile = await lstatOrReason(filePath)
  if (!inspectedFile.ok) return inspectedFile
  if (inspectedFile.stat.isSymbolicLink()) {
    return {
      ok: false,
      reason: 'symlink',
      message: 'tool result reference points to a symbolic link',
    }
  }
  if (!inspectedFile.stat.isFile()) {
    return {
      ok: false,
      reason: 'not-file',
      message: 'tool result reference does not point to a regular file',
    }
  }

  try {
    const [realRoot, realSession, realFile] = await Promise.all([
      fs.realpath(root),
      fs.realpath(sessionDir),
      fs.realpath(filePath),
    ])
    if (
      !isDirectChild(realRoot, realSession) ||
      !isDirectChild(realSession, realFile)
    ) {
      return {
        ok: false,
        reason: 'path-escape',
        message: 'tool result real path escapes the workspace session store',
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason:
        (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? 'missing'
          : 'read-error',
      message: `cannot resolve tool result path: ${errorMessage(error)}`,
    }
  }

  if (inspectedFile.stat.size !== reference.bytes) {
    return {
      ok: false,
      reason: 'size-mismatch',
      message:
        `tool result size changed: expected ${reference.bytes} bytes, ` +
        `found ${inspectedFile.stat.size}`,
    }
  }
  return {
    ok: true,
    filePath,
    totalBytes: inspectedFile.stat.size,
  }
}

function decodeBoundedUtf8(
  buffer: Buffer,
  bytesRead: number,
  eof: boolean,
): { text: string; consumed: number } | undefined {
  if (bytesRead === 0) return { text: '', consumed: 0 }
  const minimum = eof ? bytesRead : Math.max(0, bytesRead - 3)
  for (let consumed = bytesRead; consumed >= minimum; consumed -= 1) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, consumed),
      )
      return { text, consumed }
    } catch {
      // A non-EOF chunk may end in the middle of a UTF-8 sequence.
    }
  }
  return undefined
}

export const readToolResultFileChunk: ToolResultChunkReader = async (
  request,
) => {
  if (request.signal?.aborted) {
    return {
      ok: false,
      reason: 'aborted',
      message: 'tool result read was aborted',
    }
  }
  if (
    !Number.isInteger(request.offset) ||
    request.offset < 0 ||
    !Number.isFinite(request.offset)
  ) {
    return {
      ok: false,
      reason: 'invalid-offset',
      message: 'tool result offset must be a non-negative integer',
    }
  }

  const validated = await validateReferencePath(request)
  if (!validated.ok) return validated
  if (request.offset > validated.totalBytes) {
    return {
      ok: false,
      reason: 'invalid-offset',
      message: 'tool result offset is beyond the end of the file',
    }
  }
  if (request.offset === validated.totalBytes) {
    return {
      ok: true,
      text: '',
      offset: request.offset,
      nextOffset: request.offset,
      totalBytes: validated.totalBytes,
      eof: true,
    }
  }

  const requested = Number.isFinite(request.maxBytes)
    ? Math.floor(request.maxBytes!)
    : DEFAULT_TOOL_RESULT_CHUNK_BYTES
  const maxBytes = Math.max(
    4,
    Math.min(MAX_TOOL_RESULT_CHUNK_BYTES, requested),
  )
  const length = Math.min(maxBytes, validated.totalBytes - request.offset)
  const buffer = Buffer.allocUnsafe(length)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const noFollow =
      typeof fsConstants.O_NOFOLLOW === 'number'
        ? fsConstants.O_NOFOLLOW
        : 0
    handle = await fs.open(
      validated.filePath,
      fsConstants.O_RDONLY | noFollow,
    )
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      request.offset,
    )
    if (request.signal?.aborted) {
      return {
        ok: false,
        reason: 'aborted',
        message: 'tool result read was aborted',
      }
    }
    const physicalEof =
      request.offset + bytesRead >= validated.totalBytes
    const decoded = decodeBoundedUtf8(buffer, bytesRead, physicalEof)
    if (!decoded || (!physicalEof && decoded.consumed === 0)) {
      return {
        ok: false,
        reason: 'invalid-utf8',
        message: 'tool result is not valid UTF-8',
      }
    }
    const nextOffset = request.offset + decoded.consumed
    return {
      ok: true,
      text: decoded.text,
      offset: request.offset,
      nextOffset,
      totalBytes: validated.totalBytes,
      eof: nextOffset >= validated.totalBytes,
    }
  } catch (error) {
    return {
      ok: false,
      reason:
        (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? 'missing'
          : 'read-error',
      message: `cannot read tool result: ${errorMessage(error)}`,
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function writeToolResultFile(options: {
  cwd: string
  sessionId: string
  toolUseId: string
  content: string
}): Promise<ToolResultReference | undefined> {
  const root = toolResultRoot(options.cwd)
  const sessionDir = resolveToolResultSessionDirectory(
    options.cwd,
    options.sessionId,
  )
  const filePath = resolveToolResultFilePath(
    options.cwd,
    options.sessionId,
    options.toolUseId,
  )
  try {
    await fs.mkdir(root, { recursive: true })
    const rootStat = await fs.lstat(root)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return undefined
    try {
      const sessionStat = await fs.lstat(sessionDir)
      if (
        sessionStat.isSymbolicLink() ||
        !sessionStat.isDirectory()
      ) {
        return undefined
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return undefined
      }
      await fs.mkdir(sessionDir)
    }
    if (!isDirectChild(root, sessionDir) || !isDirectChild(sessionDir, filePath)) {
      return undefined
    }
    try {
      const existing = await fs.lstat(filePath)
      if (existing.isSymbolicLink() || !existing.isFile()) {
        return undefined
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return undefined
      }
    }
    const noFollow =
      typeof fsConstants.O_NOFOLLOW === 'number'
        ? fsConstants.O_NOFOLLOW
        : 0
    const handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        noFollow,
      0o600,
    )
    try {
      await handle.writeFile(options.content, 'utf8')
    } finally {
      await handle.close()
    }
    return {
      kind: 'session-file',
      path: filePath,
      bytes: Buffer.byteLength(options.content, 'utf8'),
    }
  } catch {
    return undefined
  }
}

export async function cleanupToolResultSession(options: {
  cwd: string
  sessionId: string
}): Promise<ToolResultSessionCleanupResult> {
  const root = toolResultRoot(options.cwd)
  const sessionDir = resolveToolResultSessionDirectory(
    options.cwd,
    options.sessionId,
  )
  if (!isDirectChild(root, sessionDir)) {
    return { removed: false, reason: 'unsafe-path' }
  }
  try {
    const [rootStat, sessionStat] = await Promise.all([
      fs.lstat(root),
      fs.lstat(sessionDir),
    ])
    if (
      rootStat.isSymbolicLink() ||
      sessionStat.isSymbolicLink()
    ) {
      return { removed: false, reason: 'symlink' }
    }
    if (!rootStat.isDirectory() || !sessionStat.isDirectory()) {
      return { removed: false, reason: 'unsafe-path' }
    }
    const [realRoot, realSession] = await Promise.all([
      fs.realpath(root),
      fs.realpath(sessionDir),
    ])
    if (!isDirectChild(realRoot, realSession)) {
      return { removed: false, reason: 'unsafe-path' }
    }
    const entries = await fs.readdir(sessionDir, {
      withFileTypes: true,
    })
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        !entry.isFile()
      ) {
        return { removed: false, reason: 'unsafe-path' }
      }
    }
    for (const entry of entries) {
      const target = path.resolve(sessionDir, entry.name)
      if (!isDirectChild(sessionDir, target)) {
        return { removed: false, reason: 'unsafe-path' }
      }
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { removed: false, reason: 'unsafe-path' }
      }
      await fs.unlink(target)
    }
    await fs.rmdir(sessionDir)
    return { removed: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { removed: false, reason: 'missing' }
    }
    return { removed: false, reason: 'remove-error' }
  }
}
