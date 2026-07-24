/**
 * 跨会话 Memory（auto-memory 最小）
 * 对照 HelsincyCode memdir：MEMORY.md 索引 + 行为说明进 system；有行/字节预算。
 * 无遥测；不是会话 transcript。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getBoloHomeDir } from '../../config/src/paths.ts'

export const MEMORY_DIR_NAME = 'memory'
export const MEMORY_ENTRYPOINT_NAME = 'MEMORY.md'

/** 对照 HC MAX_ENTRYPOINT_LINES */
export const MAX_MEMORY_ENTRYPOINT_LINES = 200
/** 对照 HC MAX_ENTRYPOINT_BYTES（字符近似） */
export const MAX_MEMORY_ENTRYPOINT_BYTES = 25_000

export type MemoryEntrypointLoad = {
  path: string
  dir: string
  exists: boolean
  raw: string
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

export function isMemoryDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.BOLO_DISABLE_MEMORY?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * 记忆根目录：BOLO_MEMORY_DIR（绝对）> <boloHome>/memory
 */
export function getMemoryDir(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
}): string {
  const env = opts?.env ?? process.env
  const override = env.BOLO_MEMORY_DIR?.trim()
  if (override) {
    return path.normalize(path.resolve(override))
  }
  const home = opts?.userBoloDir ?? getBoloHomeDir()
  return path.join(home, MEMORY_DIR_NAME)
}

export function getMemoryEntrypoint(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
}): string {
  return path.join(getMemoryDir(opts), MEMORY_ENTRYPOINT_NAME)
}

export async function ensureMemoryDir(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
}): Promise<string> {
  const dir = getMemoryDir(opts)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * 截断 MEMORY.md：先行数 cap，再字节 cap（尽量在行边界切）。
 * 对照 HC truncateEntrypointContent。
 */
export function truncateMemoryEntrypoint(
  raw: string,
  opts?: { maxLines?: number; maxBytes?: number },
): {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
} {
  const maxLines = opts?.maxLines ?? MAX_MEMORY_ENTRYPOINT_LINES
  const maxBytes = opts?.maxBytes ?? MAX_MEMORY_ENTRYPOINT_BYTES
  const trimmed = raw.replace(/^\uFEFF/, '').trim()
  if (!trimmed) {
    return {
      content: '',
      lineCount: 0,
      byteCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
    }
  }
  const lines = trimmed.split(/\r?\n/)
  const lineCount = lines.length
  const byteCount = trimmed.length
  const wasLineTruncated = lineCount > maxLines
  const wasByteTruncated = byteCount > maxBytes

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated: false,
      wasByteTruncated: false,
    }
  }

  let content = wasLineTruncated
    ? lines.slice(0, maxLines).join('\n')
    : trimmed

  if (content.length > maxBytes) {
    let cut = content.slice(0, maxBytes)
    const lastNl = cut.lastIndexOf('\n')
    if (lastNl > maxBytes * 0.5) cut = cut.slice(0, lastNl)
    content = cut
  }

  const caps: string[] = []
  if (wasLineTruncated) caps.push(`lines ${lineCount}>${maxLines}`)
  if (wasByteTruncated) caps.push(`bytes ${byteCount}>${maxBytes}`)
  content =
    content +
    `\n\n…(MEMORY.md truncated: ${caps.join(', ')}; keep the index concise)`

  return {
    content,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

export async function loadMemoryEntrypoint(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
  maxLines?: number
  maxBytes?: number
}): Promise<MemoryEntrypointLoad> {
  const dir = getMemoryDir(opts)
  const filePath = path.join(dir, MEMORY_ENTRYPOINT_NAME)
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const t = truncateMemoryEntrypoint(raw, opts)
    return {
      path: filePath,
      dir,
      exists: true,
      raw,
      content: t.content,
      lineCount: t.lineCount,
      byteCount: t.byteCount,
      wasLineTruncated: t.wasLineTruncated,
      wasByteTruncated: t.wasByteTruncated,
    }
  } catch {
    return {
      path: filePath,
      dir,
      exists: false,
      raw: '',
      content: '',
      lineCount: 0,
      byteCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
    }
  }
}

/** 行为说明（无索引正文）— 对照 HC buildMemoryLines 精简 */
export function buildMemoryGuidelines(memoryDir: string): string {
  const entry = MEMORY_ENTRYPOINT_NAME
  return [
    '# auto memory',
    '',
    `You have a persistent, file-based memory at \`${memoryDir}\`.`,
    '',
    'Use it for facts that should help **future** conversations (not just this turn):',
    '- User preferences and corrections ("use bun not npm", "prefer concise answers")',
    '- Project context not obvious from code (deadlines, decisions, constraints)',
    '- Pointers to external systems (dashboards, trackers)',
    '- Anything the user explicitly asks you to remember',
    '',
    '## What not to save',
    '- Secrets, passwords, API keys, tokens',
    '- Full chat transcripts or huge code dumps',
    '- Information only useful inside this conversation (use a plan/todos instead)',
    '- Facts easily re-derived from the repo with a quick read',
    '',
    '## How to save',
    `1. Write each memory to its **own** markdown file under \`${memoryDir}\` (e.g. \`user_preferences.md\`, \`project_release.md\`).`,
    '2. Add **one short index line** to `' +
      entry +
      '` (no frontmatter in the index), e.g.:',
    '   `- [Title](file.md) — one-line hook`',
    `\`${entry}\` is loaded into context (truncated after ~${MAX_MEMORY_ENTRYPOINT_LINES} lines / ~${MAX_MEMORY_ENTRYPOINT_BYTES} chars) — keep it concise.`,
    'Update or delete outdated memories. Do not duplicate; prefer updating an existing file.',
    '',
    'If the user asks to ignore memory, proceed as if the index were empty.',
  ].join('\n')
}

/**
 * System volatile 段：行为 + 当前 MEMORY.md 内容。
 * disabled / 失败时返回 undefined（fail-open 不注入）。
 */
export async function buildMemorySystemSection(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
  /** 已加载结果；省略则读盘 */
  loaded?: MemoryEntrypointLoad
  ensureDir?: boolean
}): Promise<string | undefined> {
  const env = opts?.env ?? process.env
  if (isMemoryDisabled(env)) return undefined

  if (opts?.ensureDir !== false) {
    try {
      await ensureMemoryDir(opts)
    } catch {
      /* 建目录失败仍尝试读 */
    }
  }

  const loaded =
    opts?.loaded ??
    (await loadMemoryEntrypoint({
      userBoloDir: opts?.userBoloDir,
      env,
    }))

  const guidelines = buildMemoryGuidelines(loaded.dir)
  const body = loaded.exists
    ? loaded.content.trim()
      ? [
          '',
          `## Current ${MEMORY_ENTRYPOINT_NAME}`,
          '',
          loaded.content.trim(),
        ].join('\n')
      : [
          '',
          `## Current ${MEMORY_ENTRYPOINT_NAME}`,
          '',
          `Your ${MEMORY_ENTRYPOINT_NAME} exists but is empty. When you save new memories, index them here.`,
        ].join('\n')
    : [
        '',
        `## Current ${MEMORY_ENTRYPOINT_NAME}`,
        '',
        `No ${MEMORY_ENTRYPOINT_NAME} yet. Create it under \`${loaded.dir}\` when you save the first memory.`,
      ].join('\n')

  return `${guidelines}\n${body}`
}

export function formatMemoryStatus(loaded: MemoryEntrypointLoad, opts?: {
  disabled?: boolean
}): string {
  const disabled = opts?.disabled === true
  const lines = [
    `memory:          ${disabled ? 'disabled (BOLO_DISABLE_MEMORY)' : 'enabled'}`,
    `dir:             ${loaded.dir}`,
    `entrypoint:      ${loaded.path}`,
    `exists:          ${loaded.exists ? 'yes' : 'no'}`,
  ]
  if (loaded.exists) {
    lines.push(
      `size:            ${loaded.lineCount} lines, ${loaded.byteCount} chars` +
        (loaded.wasLineTruncated || loaded.wasByteTruncated
          ? ` (truncated for prompt: line=${loaded.wasLineTruncated} byte=${loaded.wasByteTruncated})`
          : ''),
    )
    const preview = loaded.content.trim()
    if (preview) {
      const clip =
        preview.length > 800 ? preview.slice(0, 800) + '\n…' : preview
      lines.push('', '--- preview (as injected, may be truncated) ---', clip)
    } else {
      lines.push('preview:         (empty file)')
    }
  } else {
    lines.push(
      'tip:             Write topic .md files + index lines in MEMORY.md (model can use Write tool).',
    )
  }
  return lines.join('\n')
}