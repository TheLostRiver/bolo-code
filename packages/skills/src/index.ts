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
 *
 * Frontmatter 契约：S-PORT-1 → `./frontmatter.ts`
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  parseSkillMarkdown,
  SKILL_FRONTMATTER_ALIASES,
  SKILL_FRONTMATTER_CANONICAL,
  parseSkillFrontmatterFields,
  parseMarkdownFrontmatter,
  parseSkillBoolean,
  normalizeSkillId,
  type ParsedSkillFrontmatter,
} from './frontmatter.ts'

export type {
  ParsedSkillFrontmatter,
  SkillFrontmatterCanonical,
} from './frontmatter.ts'

export {
  parseSkillMarkdown,
  parseSkillFrontmatterFields,
  parseMarkdownFrontmatter,
  parseSkillBoolean,
  normalizeSkillId,
  SKILL_FRONTMATTER_ALIASES,
  SKILL_FRONTMATTER_CANONICAL,
}

export type SkillMeta = {
  id: string
  name: string
  description?: string
  /** when_to_use：给模型决定是否调用 */
  whenToUse?: string
  path: string
  /** 是否允许模型通过 Skill 工具调用；true 则仅用户 slash（若 userInvocable） */
  disableModelInvocation?: boolean
  /** 是否允许用户 /skill 调用 */
  userInvocable?: boolean
}

export type SkillSource = 'user' | 'project' | 'plugin' | 'bundled' | 'extra'

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
  userInvocable: boolean
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

export async function loadSkillFile(
  skillMdPath: string,
  source: SkillSource,
): Promise<LoadedSkill | null> {
  try {
    const raw = await fs.readFile(skillMdPath, 'utf8')
    const fallbackId = path.basename(path.dirname(skillMdPath))
    const { body, fields } = parseSkillMarkdown(raw, { fallbackId })
    const id = fields.id || normalizeSkillId(fallbackId)
    if (!id) return null
    const name = fields.name || id
    return {
      meta: {
        id,
        name,
        description: fields.description,
        whenToUse: fields.whenToUse,
        path: skillMdPath,
        disableModelInvocation: fields.disableModelInvocation,
        userInvocable: fields.userInvocable,
      },
      source,
      body,
      frontmatter: fields.raw,
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
  /**
   * S-PORT-2：可选旁路 skill 根（每根下为 `<id>/SKILL.md`）。
   * **默认不传 / 空 = 关闭**；不静默扫描 `~/.agents/skills` 等。
   * 合并位次：bundled → **extra** → user → project（→ plugin 在 workspace）。
   */
  extraSkillRoots?: readonly string[]
}

/**
 * 规范化旁路根：去空、expand `~`、相对路径相对 cwd、去重保序。
 * 不检查目录是否存在（discover 时空目录自然无 skill）。
 */
export function resolveExtraSkillRoots(
  roots: readonly string[] | undefined,
  opts?: { cwd?: string; homeDir?: string },
): string[] {
  if (!roots?.length) return []
  const cwd = opts?.cwd ?? process.cwd()
  const home = opts?.homeDir ?? os.homedir()
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of roots) {
    let p = (raw ?? '').trim()
    if (!p) continue
    if (p === '~') p = home
    else if (p.startsWith('~/') || p.startsWith('~\\')) {
      p = path.join(home, p.slice(2))
    }
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p)
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/**
 * 发现 skills。合并优先级（同 id，后者覆盖前者）：
 *   bundled → extra(旁路) → user → project
 * 插件层由 `mergeSkillsByPrecedence(..., pluginSkills)` / loadWorkspace 再盖。
 */
export async function discoverSkills(
  opts: DiscoverSkillsOptions,
): Promise<LoadedSkill[]> {
  const userRoot =
    opts.userBoloDir ??
    process.env.BOLO_CONFIG_DIR?.trim() ??
    path.join(os.homedir(), '.bolo')

  const layers: LoadedSkill[][] = []

  if (opts.bundledSkillsDir !== false) {
    const bundledDir = opts.bundledSkillsDir ?? getBundledSkillsDir()
    layers.push(await discoverSkillsInDir(bundledDir, 'bundled'))
  }

  const extras = resolveExtraSkillRoots(opts.extraSkillRoots, {
    cwd: opts.cwd,
  })
  for (const root of extras) {
    layers.push(await discoverSkillsInDir(root, 'extra'))
  }

  layers.push(
    await discoverSkillsInDir(path.join(userRoot, 'skills'), 'user'),
  )
  layers.push(
    await discoverSkillsInDir(
      path.join(opts.cwd, '.bolo', 'skills'),
      'project',
    ),
  )

  return mergeSkillsByPrecedence(...layers)
}

/**
 * 同 id 覆盖序：后写的层赢（对照 HC managed→user→project 方向，Bolo 为
 * bundled → user → project → plugin）。
 * 稳定序：按最终 map 插入序（先出现的 id 保留位置，值可被后层替换）。
 */
export function mergeSkillsByPrecedence(
  ...layers: readonly (readonly LoadedSkill[])[]
): LoadedSkill[] {
  const map = new Map<string, LoadedSkill>()
  for (const layer of layers) {
    for (const s of layer) {
      if (!s?.meta?.id) continue
      map.set(s.meta.id, s)
    }
  }
  return [...map.values()]
}

/** 覆盖源从低到高（文档 / /skills 说明用） */
export const SKILL_SOURCE_PRECEDENCE: readonly SkillSource[] = [
  'bundled',
  'extra',
  'user',
  'project',
  'plugin',
] as const

/**
 * S-PORT-4：模型是否可通过 Skill 工具加载全文。
 * disable-model-invocation: true → 否。
 */
export function isSkillModelInvocable(
  skill: LoadedSkill | SkillCatalogEntry | SkillMeta,
): boolean {
  const disable =
    'meta' in skill
      ? skill.meta.disableModelInvocation
      : skill.disableModelInvocation
  return disable !== true
}

/**
 * S-PORT-4：用户是否可通过 /skill 或 /<id> 注入全文。
 * user-invocable: false → 否。与 disable-model-invocation 正交。
 */
export function isSkillUserInvocable(
  skill: LoadedSkill | SkillCatalogEntry | SkillMeta,
): boolean {
  const ui =
    'meta' in skill ? skill.meta.userInvocable : skill.userInvocable
  return ui !== false
}

/**
 * Skill 工具拒绝原因（S-PORT-4）；null = 允许返回全文。
 */
export function skillModelInvokeBlockReason(
  skill: LoadedSkill,
): string | null {
  if (!isSkillModelInvocable(skill)) {
    return `Skill "${skill.meta.id}" has disable-model-invocation (not available via Skill tool; use /skill if user-invocable)`
  }
  return null
}

/**
 * 用户 slash 拒绝原因；null = 允许注入。
 */
export function skillUserInvokeBlockReason(
  skill: LoadedSkill,
): string | null {
  if (!isSkillUserInvocable(skill)) {
    return `Skill "${skill.meta.id}" is not user-invocable (user-invocable: false)`
  }
  return null
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
    userInvocable: skill.meta.userInvocable !== false,
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
 *
 * disable-model-invocation: 不进模型 catalog（仍可 /skills 列出，见 slash）。
 */
export function formatSkillCatalog(
  skills: LoadedSkill[] | SkillCatalogEntry[],
  options?: { contextWindowTokens?: number; maxChars?: number },
): string {
  const entries = skills.map((s) =>
    'meta' in s ? toCatalogEntry(s as LoadedSkill) : (s as SkillCatalogEntry),
  )
  const invocable = entries.filter((e) => isSkillModelInvocable(e))
  if (!invocable.length) return ''

  const ctx = options?.contextWindowTokens ?? 128_000
  const budget =
    options?.maxChars ??
    Math.min(12_000, Math.floor(ctx * 4 * 0.01) || 8_000)

  const lines: string[] = [
    '## Available Skills (catalog only — invoke via Skill tool to load full instructions)',
    'Do NOT assume skill body is already in context. Call tool Skill with skill id when needed.',
    '',
  ]

  let used = lines.join('\n').length
  let listed = 0
  for (const e of invocable) {
    const descParts = [e.description, e.whenToUse].filter(Boolean)
    const desc = clip(descParts.join(' — ') || '(no description)')
    const line = `- ${e.id}: ${desc} [${e.source}]`
    if (used + line.length + 1 > budget) {
      const omitted = invocable.length - listed
      lines.push(
        `- … (${omitted} more skills omitted; use Skill tool with exact id if known)`,
      )
      break
    }
    lines.push(line)
    listed += 1
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