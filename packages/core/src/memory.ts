/**
 * 跨会话 Memory（auto-memory）
 * 对照 HelsincyCode memdir：MEMORY.md 索引 + 行为说明进 system；有行/字节预算。
 * MEM-6：topic 扫描 + 确定性相关挑选（无 side-query LLM / 无遥测）。
 * MEM-7：user + project 双根分层注入。
 * 不是会话 transcript。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  getBoloHomeDir,
  getProjectBoloDir,
} from '../../config/src/paths.ts'

export const MEMORY_DIR_NAME = 'memory'
export const MEMORY_ENTRYPOINT_NAME = 'MEMORY.md'

/** 对照 HC MAX_ENTRYPOINT_LINES */
export const MAX_MEMORY_ENTRYPOINT_LINES = 200
/** 对照 HC MAX_ENTRYPOINT_BYTES（字符近似） */
export const MAX_MEMORY_ENTRYPOINT_BYTES = 25_000

/** topic 扫描上限 */
export const MAX_MEMORY_TOPIC_FILES = 200
/** frontmatter / 头描述最多读行 */
export const MEMORY_TOPIC_HEADER_LINES = 40
/** 相关 topic 最多注入条数 */
export const MAX_RELEVANT_MEMORY_TOPICS = 5
/** 相关 topic 正文合计字符预算 */
export const MAX_RELEVANT_MEMORY_BODY_CHARS = 12_000
/** 单 topic 正文字符上限 */
export const MAX_SINGLE_TOPIC_BODY_CHARS = 4_000

export type MemoryScope = 'user' | 'project'

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
  scope?: MemoryScope
}

export type MemoryTopicHeader = {
  /** 相对 memory 根的路径（posix 风格） */
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  title: string | null
  scope: MemoryScope
}

export type RelevantMemoryTopic = MemoryTopicHeader & {
  score: number
  body?: string
}

export function isMemoryDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.BOLO_DISABLE_MEMORY?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * 用户记忆根：BOLO_MEMORY_DIR（绝对）> <boloHome>/memory
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

/** 项目记忆根：<cwd>/.bolo/memory */
export function getProjectMemoryDir(opts: {
  cwd: string
}): string {
  return path.join(getProjectBoloDir(opts.cwd), MEMORY_DIR_NAME)
}

export function getMemoryEntrypoint(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
}): string {
  return path.join(getMemoryDir(opts), MEMORY_ENTRYPOINT_NAME)
}

export function getProjectMemoryEntrypoint(opts: {
  cwd: string
}): string {
  return path.join(getProjectMemoryDir(opts), MEMORY_ENTRYPOINT_NAME)
}

export async function ensureMemoryDir(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
}): Promise<string> {
  const dir = getMemoryDir(opts)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function ensureProjectMemoryDir(opts: {
  cwd: string
}): Promise<string> {
  const dir = getProjectMemoryDir(opts)
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
  /** 指定目录时直接读该根（用于 project） */
  memoryDir?: string
  scope?: MemoryScope
}): Promise<MemoryEntrypointLoad> {
  const dir = opts?.memoryDir ?? getMemoryDir(opts)
  const filePath = path.join(dir, MEMORY_ENTRYPOINT_NAME)
  const scope = opts?.scope
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
      scope,
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
      scope,
    }
  }
}

export async function loadProjectMemoryEntrypoint(opts: {
  cwd: string
  maxLines?: number
  maxBytes?: number
}): Promise<MemoryEntrypointLoad> {
  return loadMemoryEntrypoint({
    memoryDir: getProjectMemoryDir(opts),
    scope: 'project',
    maxLines: opts.maxLines,
    maxBytes: opts.maxBytes,
  })
}

/** 简易 YAML-ish frontmatter（仅 description / title） */
export function parseMemoryTopicFrontmatter(raw: string): {
  body: string
  description: string | null
  title: string | null
} {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) {
    return { body: text, description: null, title: null }
  }
  const end = text.indexOf('\n---', 3)
  if (end < 0) {
    return { body: text, description: null, title: null }
  }
  const fm = text.slice(3, end).trim()
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  let description: string | null = null
  let title: string | null = null
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^(description|title)\s*:\s*(.*)$/i)
    if (!m) continue
    let v = m[2].trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    if (m[1].toLowerCase() === 'description') description = v || null
    else title = v || null
  }
  return { body, description, title }
}

function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/')
}

/**
 * 递归列出 memory 目录下 topic *.md（排除 MEMORY.md）。
 */
export async function scanMemoryTopics(
  memoryDir: string,
  opts?: { scope?: MemoryScope; maxFiles?: number },
): Promise<MemoryTopicHeader[]> {
  const scope = opts?.scope ?? 'user'
  const maxFiles = opts?.maxFiles ?? MAX_MEMORY_TOPIC_FILES
  const root = path.normalize(memoryDir)
  const out: MemoryTopicHeader[] = []

  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) break
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!ent.isFile()) continue
      if (!ent.name.toLowerCase().endsWith('.md')) continue
      if (ent.name === MEMORY_ENTRYPOINT_NAME) continue
      let st: import('node:fs').Stats
      let head: string
      try {
        st = await fs.stat(abs)
        const fh = await fs.open(abs, 'r')
        try {
          const buf = Buffer.alloc(8_192)
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
          head = buf.slice(0, bytesRead).toString('utf8')
        } finally {
          await fh.close()
        }
      } catch {
        continue
      }
      const headLines = head.split(/\r?\n/).slice(0, MEMORY_TOPIC_HEADER_LINES).join('\n')
      const { description, title } = parseMemoryTopicFrontmatter(headLines)
      let derivedTitle = title
      if (!derivedTitle) {
        const hm = headLines.match(/^#\s+(.+)$/m)
        if (hm) derivedTitle = hm[1].trim()
      }
      const rel = toPosixRel(path.relative(root, abs))
      out.push({
        filename: rel,
        filePath: abs,
        mtimeMs: st.mtimeMs,
        description,
        title: derivedTitle,
        scope,
      })
    }
  }

  await walk(root)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, maxFiles)
}

/** 分词：字母数字与 CJK 连续段；过滤极短英文停用噪声 */
export function tokenizeMemoryQuery(text: string): string[] {
  const lower = text.toLowerCase()
  const parts = lower.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{1,}/g) ?? []
  const stop = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'from',
    'your',
    'please',
    'use',
    'not',
    'are',
    'was',
    'were',
    'have',
    'has',
    'will',
    'can',
    'how',
    'what',
    'when',
    'where',
    'who',
    'why',
  ])
  return [...new Set(parts.filter((p) => !stop.has(p) && p.length >= 2))]
}

/**
 * 确定性相关挑选：文件名/标题/描述与 query token 重叠计分。
 * 无 LLM、无遥测。匹配按 token 边界（避免 notes⊃not）。
 */
export function selectRelevantMemoryTopics(
  query: string,
  topics: readonly MemoryTopicHeader[],
  opts?: { limit?: number },
): RelevantMemoryTopic[] {
  const limit = opts?.limit ?? MAX_RELEVANT_MEMORY_TOPICS
  const tokens = tokenizeMemoryQuery(query)
  if (!tokens.length || !topics.length) return []

  const scored: RelevantMemoryTopic[] = []
  for (const t of topics) {
    const hayTokens = new Set(
      tokenizeMemoryQuery(
        [t.filename.replace(/\.md$/i, ''), t.title ?? '', t.description ?? ''].join(
          ' ',
        ),
      ),
    )
    // 文件名整段也作为可匹配串（下划线拆开已在 tokenize）
    let score = 0
    for (const tok of tokens) {
      if (hayTokens.has(tok)) {
        score += tok.length >= 4 ? 3 : 2
        if (t.filename.toLowerCase().includes(tok)) score += 2
        if ((t.title ?? '').toLowerCase().split(/\W+/).includes(tok)) score += 1
      }
    }
    if (t.scope === 'project' && score > 0) score += 1
    if (score > 0) scored.push({ ...t, score })
  }
  scored.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)
  return scored.slice(0, limit)
}

export async function loadTopicBodies(
  topics: readonly RelevantMemoryTopic[],
  opts?: {
    maxTotalChars?: number
    maxPerFile?: number
  },
): Promise<RelevantMemoryTopic[]> {
  const maxTotal = opts?.maxTotalChars ?? MAX_RELEVANT_MEMORY_BODY_CHARS
  const maxPer = opts?.maxPerFile ?? MAX_SINGLE_TOPIC_BODY_CHARS
  let used = 0
  const out: RelevantMemoryTopic[] = []
  for (const t of topics) {
    if (used >= maxTotal) break
    try {
      const raw = await fs.readFile(t.filePath, 'utf8')
      const { body } = parseMemoryTopicFrontmatter(raw)
      let text = body.trim()
      if (text.length > maxPer) {
        text = text.slice(0, maxPer) + '\n…(topic truncated)'
      }
      const room = maxTotal - used
      if (text.length > room) {
        text = text.slice(0, Math.max(0, room - 20)) + '\n…(budget)'
      }
      used += text.length
      out.push({ ...t, body: text })
    } catch {
      out.push({ ...t, body: undefined })
    }
  }
  return out
}

/** 行为说明（无索引正文）— 对照 HC buildMemoryLines 精简 */
export function buildMemoryGuidelines(memoryDirs: string | string[]): string {
  const dirs = (Array.isArray(memoryDirs) ? memoryDirs : [memoryDirs]).filter(
    Boolean,
  )
  const entry = MEMORY_ENTRYPOINT_NAME
  const dirList =
    dirs.length === 1
      ? `\`${dirs[0]}\``
      : dirs.map((d, i) => `${i + 1}. \`${d}\``).join('\n')
  return [
    '# auto memory',
    '',
    dirs.length === 1
      ? `You have a persistent, file-based memory at ${dirList}.`
      : `You have persistent, file-based memory at:`,
    ...(dirs.length > 1 ? [dirList, ''] : ['']),
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
    `1. Write each memory to its **own** markdown file under the memory dir (e.g. \`user_preferences.md\`, \`project_release.md\`).`,
    '2. Add **one short index line** to `' +
      entry +
      '` (no frontmatter in the index), e.g.:',
    '   `- [Title](file.md) — one-line hook`',
    '3. Optional YAML frontmatter on topic files: `description:` / `title:` (helps listing).',
    `\`${entry}\` is loaded into context (truncated after ~${MAX_MEMORY_ENTRYPOINT_LINES} lines / ~${MAX_MEMORY_ENTRYPOINT_BYTES} chars) — keep it concise.`,
    'Update or delete outdated memories. Do not duplicate; prefer updating an existing file.',
    '',
    'If the user asks to ignore memory, proceed as if the index were empty.',
  ].join('\n')
}

function formatEntrypointBody(
  loaded: MemoryEntrypointLoad,
  heading: string,
): string {
  if (loaded.exists) {
    if (loaded.content.trim()) {
      return ['', `## ${heading}`, '', loaded.content.trim()].join('\n')
    }
    return [
      '',
      `## ${heading}`,
      '',
      `${MEMORY_ENTRYPOINT_NAME} exists but is empty. When you save new memories, index them here.`,
    ].join('\n')
  }
  return [
    '',
    `## ${heading}`,
    '',
    `No ${MEMORY_ENTRYPOINT_NAME} yet under \`${loaded.dir}\`. Create it when you save the first memory.`,
  ].join('\n')
}

function formatRelevantSection(
  topics: readonly RelevantMemoryTopic[],
): string {
  if (!topics.length) return ''
  const blocks: string[] = [
    '',
    '## Related memory topics',
    '',
    'Deterministic keyword match (not a full search). Prefer reading files with tools if needed.',
    '',
  ]
  for (const t of topics) {
    const label = t.title || t.filename
    blocks.push(
      `### [${t.scope}] ${label} (\`${t.filename}\`, score=${t.score})`,
    )
    if (t.description) blocks.push(`_${t.description}_`)
    if (t.body?.trim()) {
      blocks.push('', t.body.trim(), '')
    } else {
      blocks.push('', `_(body unavailable; path \`${t.filePath}\`)_`, '')
    }
  }
  return blocks.join('\n')
}

/**
 * System volatile 段：行为 + 当前 MEMORY.md + 可选相关 topic。
 * disabled / 失败时返回 undefined（fail-open 不注入）。
 *
 * 合并规则（MEM-7）：
 * - 始终尝试 user 根；
 * - 若提供 cwd，再叠加 project `.bolo/memory`；
 * - 两源索引**并列**注入（project 段在后，便于覆盖语义上「后写优先」由模型判断）；
 * - 相关 topic 合并扫描，project 同分加权。
 */
export async function buildMemorySystemSection(opts?: {
  userBoloDir?: string
  env?: NodeJS.ProcessEnv
  /** 项目 cwd；有则叠加 project memory */
  cwd?: string
  /** 已加载 user 结果；省略则读盘 */
  loaded?: MemoryEntrypointLoad
  ensureDir?: boolean
  /** 用于相关 topic 的查询文本（通常最近用户话） */
  relevanceQuery?: string
  /** 是否扫描并注入相关 topic 正文（默认：有 query 才开） */
  includeRelevantTopics?: boolean
}): Promise<string | undefined> {
  const env = opts?.env ?? process.env
  if (isMemoryDisabled(env)) return undefined

  if (opts?.ensureDir !== false) {
    try {
      await ensureMemoryDir(opts)
      if (opts?.cwd) await ensureProjectMemoryDir({ cwd: opts.cwd })
    } catch {
      /* 建目录失败仍尝试读 */
    }
  }

  const userLoaded =
    opts?.loaded ??
    (await loadMemoryEntrypoint({
      userBoloDir: opts?.userBoloDir,
      env,
      scope: 'user',
    }))

  let projectLoaded: MemoryEntrypointLoad | undefined
  if (opts?.cwd) {
    projectLoaded = await loadProjectMemoryEntrypoint({ cwd: opts.cwd })
  }

  const dirs = [userLoaded.dir]
  if (projectLoaded) dirs.push(projectLoaded.dir)

  const guidelines = buildMemoryGuidelines(dirs)
  let body = formatEntrypointBody(
    userLoaded,
    projectLoaded
      ? `Current user ${MEMORY_ENTRYPOINT_NAME}`
      : `Current ${MEMORY_ENTRYPOINT_NAME}`,
  )
  if (projectLoaded) {
    body +=
      formatEntrypointBody(
        projectLoaded,
        `Current project ${MEMORY_ENTRYPOINT_NAME}`,
      ) +
      '\n\nWhen user and project indexes conflict, prefer **project** facts for this repo.'
  }

  const wantRelevant =
    opts?.includeRelevantTopics === true ||
    (opts?.includeRelevantTopics !== false &&
      Boolean(opts?.relevanceQuery?.trim()))

  let relevantBlock = ''
  if (wantRelevant && opts?.relevanceQuery?.trim()) {
    const headers: MemoryTopicHeader[] = []
    try {
      headers.push(
        ...(await scanMemoryTopics(userLoaded.dir, { scope: 'user' })),
      )
      if (projectLoaded) {
        headers.push(
          ...(await scanMemoryTopics(projectLoaded.dir, {
            scope: 'project',
          })),
        )
      }
    } catch {
      /* scan fail-open */
    }
    const picked = selectRelevantMemoryTopics(
      opts.relevanceQuery,
      headers,
    )
    const withBody = await loadTopicBodies(picked)
    relevantBlock = formatRelevantSection(withBody)
  }

  return `${guidelines}\n${body}${relevantBlock}`
}

export function formatMemoryTopicsList(
  topics: readonly MemoryTopicHeader[],
): string {
  if (!topics.length) return 'topics:          (none)'
  const lines = [`topics:          ${topics.length} file(s)`, '']
  for (const t of topics.slice(0, 50)) {
    const desc = t.description || t.title || ''
    lines.push(
      `  · [${t.scope}] ${t.filename}` +
        (desc ? ` — ${desc.slice(0, 80)}` : ''),
    )
  }
  if (topics.length > 50) lines.push(`  · … +${topics.length - 50} more`)
  return lines.join('\n')
}

export function formatMemoryStatus(
  loaded: MemoryEntrypointLoad,
  opts?: {
    disabled?: boolean
    project?: MemoryEntrypointLoad
    topics?: readonly MemoryTopicHeader[]
  },
): string {
  const disabled = opts?.disabled === true
  const lines = [
    `memory:          ${disabled ? 'disabled (BOLO_DISABLE_MEMORY)' : 'enabled'}`,
    `user dir:        ${loaded.dir}`,
    `user entry:      ${loaded.path}`,
    `user exists:     ${loaded.exists ? 'yes' : 'no'}`,
  ]
  if (opts?.project) {
    lines.push(
      `project dir:     ${opts.project.dir}`,
      `project entry:   ${opts.project.path}`,
      `project exists:  ${opts.project.exists ? 'yes' : 'no'}`,
    )
  }
  if (loaded.exists) {
    lines.push(
      `user size:       ${loaded.lineCount} lines, ${loaded.byteCount} chars` +
        (loaded.wasLineTruncated || loaded.wasByteTruncated
          ? ` (truncated for prompt: line=${loaded.wasLineTruncated} byte=${loaded.wasByteTruncated})`
          : ''),
    )
    const preview = loaded.content.trim()
    if (preview) {
      const clip =
        preview.length > 800 ? preview.slice(0, 800) + '\n…' : preview
      lines.push('', '--- user preview (as injected, may be truncated) ---', clip)
    } else {
      lines.push('user preview:    (empty file)')
    }
  } else {
    lines.push(
      'tip:             Write topic .md files + index lines in MEMORY.md (model can use Write tool).',
    )
  }
  if (opts?.topics) {
    lines.push('', formatMemoryTopicsList(opts.topics))
  }
  return lines.join('\n')
}