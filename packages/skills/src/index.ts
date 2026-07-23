/**
 * Skill 发现与加载 — 对照 HelsincyCode loadSkillsDir + SkillTool
 *
 * 路径（同 id 后者覆盖前者）：
 *   packages/bundled-skills/<id>/SKILL.md  （发行内置）
 *   ~/.bolo/skills/<id>/SKILL.md           （全局，BOLO_CONFIG_DIR 可覆盖）
 *   .bolo/skills/<id>/SKILL.md             （项目）
 *   插件 skills/                           （workspace 合并时再覆盖）
 *
 * Token 策略（对齐 HC）：
 *   - 默认只把「目录索引」进上下文（name + description + when_to_use）
 *   - 全文仅在模型调用 Skill 工具 / 用户显式 /skill 时加载
 *   - 禁止把所有全局 skill 正文无条件塞进 system（会爆 token）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export type SkillMeta = {
  id: string
  name: string
  description?: string
  /** when_to_use：给模型决定是否调用 */
  whenToUse?: string
  path: string
  /** 是否允许模型通过 Skill 工具调用；false 则仅用户 slash */
  disableModelInvocation?: boolean
  /** 是否允许用户 /skill 调用 */
  userInvocable?: boolean
}

export type SkillSource = 'user' | 'project' | 'plugin' | 'bundled'

export type LoadedSkill = {
  meta: SkillMeta
  source: SkillSource
  body: string
  frontmatter: Record<string, string>
}

/** 目录索引条目（无 body） */
export type SkillCatalogEntry = {
  id: string
  name: string
  description?: string
  whenToUse?: string
  source: SkillSource
  path: string
  disableModelInvocation: boolean
}

/**
 * 仓库内置 skills 根目录（packages/bundled-skills）。
 * 相对本文件：packages/skills/src → ../../bundled-skills
 */
export function getBundledSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', 'bundled-skills')
}

export function describeSkillLayout(userRoot?: string) {
  const root = userRoot ?? path.join(os.homedir(), '.bolo')
  return {
    bundled: path.join(getBundledSkillsDir(), '<id>', 'SKILL.md'),
    user: path.join(root, 'skills', '<id>', 'SKILL.md'),
    project: path.join('.bolo', 'skills', '<id>', 'SKILL.md'),
    plugin: path.join('<plugin>', 'skills', '<id>', 'SKILL.md'),
  }
}

function parseBoolean(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined || v === '') return defaultValue
  const n = v.toLowerCase().trim()
  if (['false', '0', 'no', 'off'].includes(n)) return false
  if (['true', '1', 'yes', 'on'].includes(n)) return true
  return defaultValue
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>
  body: string
} {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw }
  }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, body: raw }
  const block = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const frontmatter: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (m) frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return { frontmatter, body }
}

export async function loadSkillFile(
  skillMdPath: string,
  source: SkillSource,
): Promise<LoadedSkill | null> {
  try {
    const raw = await fs.readFile(skillMdPath, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)
    const id = frontmatter.id || path.basename(path.dirname(skillMdPath))
    const name = frontmatter.name || id
    return {
      meta: {
        id,
        name,
        description: frontmatter.description,
        whenToUse: frontmatter.when_to_use || frontmatter.whenToUse,
        path: skillMdPath,
        disableModelInvocation: parseBoolean(
          frontmatter['disable-model-invocation'],
          false,
        ),
        userInvocable: parseBoolean(frontmatter['user-invocable'], true),
      },
      source,
      body,
      frontmatter,
    }
  } catch {
    return null
  }
}

export async function discoverSkillsInDir(
  dir: string,
  source: SkillSource,
): Promise<LoadedSkill[]> {
  const out: LoadedSkill[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const skillMd = path.join(dir, name, 'SKILL.md')
    try {
      await fs.access(skillMd)
    } catch {
      continue
    }
    const loaded = await loadSkillFile(skillMd, source)
    if (loaded) out.push(loaded)
  }
  return out
}

export type DiscoverSkillsOptions = {
  cwd: string
  /** 默认 ~/.bolo（或 BOLO_CONFIG_DIR） */
  userBoloDir?: string
  /**
   * 内置 skills 目录；默认 getBundledSkillsDir()。
   * 传 `false` 跳过 bundled（测试用）。
   */
  bundledSkillsDir?: string | false
}

/**
 * 发现 skills。合并优先级（同 id）：
 * bundled → user → project（后者覆盖前者）。
 * 插件层由 loadWorkspace 再覆盖。
 */
export async function discoverSkills(
  opts: DiscoverSkillsOptions,
): Promise<LoadedSkill[]> {
  const userRoot =
    opts.userBoloDir ??
    process.env.BOLO_CONFIG_DIR?.trim() ??
    path.join(os.homedir(), '.bolo')

  const map = new Map<string, LoadedSkill>()

  if (opts.bundledSkillsDir !== false) {
    const bundledDir = opts.bundledSkillsDir ?? getBundledSkillsDir()
    const bundled = await discoverSkillsInDir(bundledDir, 'bundled')
    for (const s of bundled) map.set(s.meta.id, s)
  }

  const user = await discoverSkillsInDir(
    path.join(userRoot, 'skills'),
    'user',
  )
  for (const s of user) map.set(s.meta.id, s)

  const project = await discoverSkillsInDir(
    path.join(opts.cwd, '.bolo', 'skills'),
    'project',
  )
  for (const s of project) map.set(s.meta.id, s)

  return [...map.values()]
}

export function toCatalogEntry(skill: LoadedSkill): SkillCatalogEntry {
  return {
    id: skill.meta.id,
    name: skill.meta.name,
    description: skill.meta.description,
    whenToUse: skill.meta.whenToUse,
    source: skill.source,
    path: skill.meta.path,
    disableModelInvocation: skill.meta.disableModelInvocation === true,
  }
}

export function skillsToCatalog(skills: LoadedSkill[]): SkillCatalogEntry[] {
  return skills.map(toCatalogEntry)
}

/** 对照 HC MAX_LISTING_DESC_CHARS */
export const MAX_LISTING_DESC_CHARS = 250

function clip(s: string, max = MAX_LISTING_DESC_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/**
 * 仅索引进上下文（给模型发现用，不是全文）
 * 对照 HC skill_listing + SkillTool prompt 的「目录预算」思路
 */
export function formatSkillCatalog(
  skills: LoadedSkill[] | SkillCatalogEntry[],
  options?: { contextWindowTokens?: number; maxChars?: number },
): string {
  const entries = skills.map((s) =>
    'meta' in s ? toCatalogEntry(s as LoadedSkill) : (s as SkillCatalogEntry),
  )
  // 模型可调用的才进 Skill 工具目录
  const invocable = entries.filter((e) => !e.disableModelInvocation)
  if (!invocable.length) return ''

  const ctx = options?.contextWindowTokens ?? 128_000
  // ~1% 上下文字符预算（chars ≈ tokens * 4）
  const budget =
    options?.maxChars ??
    Math.min(12_000, Math.floor(ctx * 4 * 0.01) || 8_000)

  const lines: string[] = [
    '## Available Skills (catalog only — invoke via Skill tool to load full instructions)',
    'Do NOT assume skill body is already in context. Call tool Skill with skill id when needed.',
    '',
  ]

  let used = lines.join('\n').length
  for (const e of invocable) {
    const descParts = [e.description, e.whenToUse].filter(Boolean)
    const desc = clip(descParts.join(' — ') || '(no description)')
    const line = `- ${e.id}: ${desc} [${e.source}]`
    if (used + line.length + 1 > budget) {
      lines.push(
        `- … (${invocable.length - lines.length + 3} more skills omitted; use Skill tool with exact id if known)`,
      )
      break
    }
    lines.push(line)
    used += line.length + 1
  }

  return lines.join('\n')
}

/**
 * @deprecated 会把全文塞进 system，易爆 token。请用 formatSkillCatalog + Skill 工具。
 * 仅保留给调试/显式 opt-in。
 */
export function skillsToSystemPrompt(skills: LoadedSkill[]): string {
  return formatSkillCatalog(skills)
}

export function formatSkillBodyForInjection(skill: LoadedSkill): string {
  const base = path.dirname(skill.meta.path)
  return [
    `Base directory for this skill: ${base}`,
    '',
    `# Skill: ${skill.meta.name} (${skill.meta.id})`,
    skill.meta.description ? `Description: ${skill.meta.description}` : '',
    skill.meta.whenToUse ? `When to use: ${skill.meta.whenToUse}` : '',
    '',
    skill.body.trim(),
  ]
    .filter((l) => l !== undefined)
    .join('\n')
}

/** 按 id 取全文（Skill 工具调用时） */
export function findSkillById(
  skills: LoadedSkill[],
  idOrName: string,
): LoadedSkill | undefined {
  const key = idOrName.replace(/^\//, '').trim()
  return (
    skills.find((s) => s.meta.id === key || s.meta.name === key) ??
    skills.find((s) => s.meta.id.toLowerCase() === key.toLowerCase())
  )
}