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

/** 对照 HC SkillTool/prompt.ts */
export const MAX_LISTING_DESC_CHARS = 250
/** 对照 HC SKILL_BUDGET_CONTEXT_PERCENT */
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
/** 对照 HC DEFAULT_CHAR_BUDGET（约 1% of 200k×4） */
export const DEFAULT_SKILL_CATALOG_CHAR_BUDGET = 8_000
/** Bolo 上限，避免超大窗口把 catalog 撑爆 */
export const MAX_SKILL_CATALOG_CHAR_BUDGET = 12_000

function clip(s: string, max = MAX_LISTING_DESC_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/**
 * catalog 字符预算（对照 HC getCharBudget）。
 * 环境变量 `BOLO_SKILL_CATALOG_CHAR_BUDGET` 可覆盖（正整数）。
 */
export function getSkillCatalogCharBudget(opts?: {
  contextWindowTokens?: number
  maxChars?: number
  env?: NodeJS.ProcessEnv
}): number {
  if (typeof opts?.maxChars === 'number' && opts.maxChars > 0) {
    return Math.floor(opts.maxChars)
  }
  const env = opts?.env ?? process.env
  const fromEnv = Number(env.BOLO_SKILL_CATALOG_CHAR_BUDGET)
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv)
  }
  const ctx = opts?.contextWindowTokens
  if (typeof ctx === 'number' && ctx > 0) {
    const raw = Math.floor(ctx * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT)
    return Math.min(MAX_SKILL_CATALOG_CHAR_BUDGET, Math.max(1_000, raw))
  }
  return DEFAULT_SKILL_CATALOG_CHAR_BUDGET
}

export type SkillCatalogFormatOptions = {
  contextWindowTokens?: number
  /** 直接指定预算（优先于窗口推算） */
  maxChars?: number
  env?: NodeJS.ProcessEnv
}

/** S-PORT-5：catalog 格式化可观测统计 */
export type SkillCatalogStats = {
  /** 会话内 skill 总数（含 disable-model） */
  totalSkills: number
  /** 可进模型 catalog 的数量 */
  modelInvocable: number
  /** disable-model-invocation 数量 */
  modelDisabled: number
  /** 实际写入 listing 的条数 */
  listed: number
  /** 因预算省略的 model-invocable 条数 */
  omitted: number
  /** 字符预算 */
  budgetChars: number
  /** 最终 catalog 字符串长度（含标题） */
  usedChars: number
  /** 是否发生省略 */
  truncated: boolean
  /** 预算来源说明 */
  budgetSource: 'maxChars' | 'env' | 'contextWindow' | 'default'
}

export type FormatSkillCatalogResult = {
  text: string
  stats: SkillCatalogStats
}

function resolveBudgetSource(opts?: SkillCatalogFormatOptions): {
  budget: number
  budgetSource: SkillCatalogStats['budgetSource']
} {
  if (typeof opts?.maxChars === 'number' && opts.maxChars > 0) {
    return { budget: Math.floor(opts.maxChars), budgetSource: 'maxChars' }
  }
  const env = opts?.env ?? process.env
  const fromEnv = Number(env.BOLO_SKILL_CATALOG_CHAR_BUDGET)
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return { budget: Math.floor(fromEnv), budgetSource: 'env' }
  }
  if (
    typeof opts?.contextWindowTokens === 'number' &&
    opts.contextWindowTokens > 0
  ) {
    return {
      budget: getSkillCatalogCharBudget({
        contextWindowTokens: opts.contextWindowTokens,
      }),
      budgetSource: 'contextWindow',
    }
  }
  return {
    budget: DEFAULT_SKILL_CATALOG_CHAR_BUDGET,
    budgetSource: 'default',
  }
}

/**
 * 仅索引进上下文（给模型发现用，不是全文）
 * 对照 HC skill_listing + SkillTool prompt 的「目录预算」思路
 *
 * disable-model-invocation: 不进模型 catalog（仍可 /skills 列出，见 slash）。
 * S-PORT-5：返回 stats 供 /skills · /context 观测。
 */
export function formatSkillCatalogWithStats(
  skills: LoadedSkill[] | SkillCatalogEntry[],
  options?: SkillCatalogFormatOptions,
): FormatSkillCatalogResult {
  const entries = skills.map((s) =>
    'meta' in s ? toCatalogEntry(s as LoadedSkill) : (s as SkillCatalogEntry),
  )
  const modelDisabled = entries.filter((e) => !isSkillModelInvocable(e)).length
  const invocable = entries.filter((e) => isSkillModelInvocable(e))
  const { budget, budgetSource } = resolveBudgetSource(options)

  if (!invocable.length) {
    return {
      text: '',
      stats: {
        totalSkills: entries.length,
        modelInvocable: 0,
        modelDisabled,
        listed: 0,
        omitted: 0,
        budgetChars: budget,
        usedChars: 0,
        truncated: false,
        budgetSource,
      },
    }
  }

  const header = [
    '## Available Skills (catalog only — invoke via Skill tool to load full instructions)',
    'Do NOT assume skill body is already in context. Call tool Skill with skill id when needed.',
    '',
  ]
  const lines: string[] = [...header]

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
      used = lines.join('\n').length
      return {
        text: lines.join('\n'),
        stats: {
          totalSkills: entries.length,
          modelInvocable: invocable.length,
          modelDisabled,
          listed,
          omitted,
          budgetChars: budget,
          usedChars: used,
          truncated: true,
          budgetSource,
        },
      }
    }
    lines.push(line)
    listed += 1
    used += line.length + 1
  }

  const text = lines.join('\n')
  return {
    text,
    stats: {
      totalSkills: entries.length,
      modelInvocable: invocable.length,
      modelDisabled,
      listed,
      omitted: 0,
      budgetChars: budget,
      usedChars: text.length,
      truncated: false,
      budgetSource,
    },
  }
}

/**
 * 仅索引进上下文（字符串）。需要统计时用 `formatSkillCatalogWithStats`。
 */
export function formatSkillCatalog(
  skills: LoadedSkill[] | SkillCatalogEntry[],
  options?: SkillCatalogFormatOptions,
): string {
  return formatSkillCatalogWithStats(skills, options).text
}

/** 一行人类可读预算摘要（/skills · /context） */
export function formatSkillCatalogStatsLine(stats: SkillCatalogStats): string {
  const omit =
    stats.omitted > 0
      ? ` · omitted ${stats.omitted}`
      : stats.truncated
        ? ' · truncated'
        : ''
  const dis =
    stats.modelDisabled > 0 ? ` · no-model ${stats.modelDisabled}` : ''
  return (
    `skill catalog: listed ${stats.listed}/${stats.modelInvocable} model-visible` +
    ` · total ${stats.totalSkills}${dis}` +
    ` · ${stats.usedChars}/${stats.budgetChars} chars` +
    ` (${stats.budgetSource})${omit}`
  )
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