/**
 * Skill frontmatter 契约（S-PORT-1）
 *
 * 对照 HelsincyCode loadSkillsDir.parseSkillFrontmatterFields + frontmatterParser
 * 语义重实现：规范字段 + 常见别名；未知键保留在 raw 中但不进 meta。
 * 无遥测。
 */

/** 规范字段（文档契约） */
export const SKILL_FRONTMATTER_CANONICAL = [
  'id',
  'name',
  'description',
  'when_to_use',
  'disable-model-invocation',
  'user-invocable',
] as const

export type SkillFrontmatterCanonical = (typeof SKILL_FRONTMATTER_CANONICAL)[number]

/**
 * 别名 → 规范键（解析时折叠）。
 * 未知键：忽略进 meta，仍可出现在 raw frontmatter。
 */
export const SKILL_FRONTMATTER_ALIASES: Record<string, SkillFrontmatterCanonical> = {
  id: 'id',
  name: 'name',
  description: 'description',
  // when_to_use 族（HC 常用 when_to_use；社区/camelCase 常见）
  when_to_use: 'when_to_use',
  whenToUse: 'when_to_use',
  'when-to-use': 'when_to_use',
  // disable-model-invocation 族
  'disable-model-invocation': 'disable-model-invocation',
  disable_model_invocation: 'disable-model-invocation',
  disableModelInvocation: 'disable-model-invocation',
  // user-invocable 族
  'user-invocable': 'user-invocable',
  user_invocable: 'user-invocable',
  userInvocable: 'user-invocable',
}

export type ParsedSkillFrontmatter = {
  id?: string
  name?: string
  description?: string
  whenToUse?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  /** 折叠后的规范键→值（仅已知字段） */
  canonical: Partial<Record<SkillFrontmatterCanonical, string>>
  /** 原始 frontmatter（含未知键） */
  raw: Record<string, string>
}

/**
 * 宽松布尔：对照 HC 仅 true/"true" 偏严；Bolo 可移植层接受 yes/on/1。
 * 缺省用 defaultValue。
 */
export function parseSkillBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === '') return defaultValue
  const n = value.toLowerCase().trim()
  if (['false', '0', 'no', 'off'].includes(n)) return false
  if (['true', '1', 'yes', 'on'].includes(n)) return true
  return defaultValue
}

/** 去掉引号、压空白 */
export function normalizeFrontmatterScalar(raw: string): string {
  return raw
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解析 markdown 的 YAML-like frontmatter（单行 key: value）。
 * 不做完整 YAML（嵌套/列表后置）；对照 HC 的 skill 主路径够用。
 */
export function parseMarkdownFrontmatter(raw: string): {
  frontmatter: Record<string, string>
  body: string
} {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw }
  }
  // 支持 \r\n
  const endMatch = raw.slice(3).match(/\r?\n---\r?\n?/)
  if (!endMatch || endMatch.index === undefined) {
    return { frontmatter: {}, body: raw }
  }
  const blockEnd = 3 + endMatch.index
  const block = raw.slice(3, blockEnd).replace(/^\r?\n/, '').trim()
  const after = blockEnd + endMatch[0].length
  const body = raw.slice(after).replace(/^\r?\n/, '')
  const frontmatter: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) continue
    frontmatter[m[1]] = normalizeFrontmatterScalar(m[2] ?? '')
  }
  return { frontmatter, body }
}

/**
 * 将 raw frontmatter 折叠为契约字段。
 * @param fallbackId 目录名等（无 id 时）
 */
export function parseSkillFrontmatterFields(
  raw: Record<string, string>,
  opts?: { fallbackId?: string },
): ParsedSkillFrontmatter {
  const canonical: Partial<Record<SkillFrontmatterCanonical, string>> = {}

  for (const [key, value] of Object.entries(raw)) {
    const canon = SKILL_FRONTMATTER_ALIASES[key]
    if (!canon) continue // 未知键忽略进 meta
    if (value === undefined || value === '') continue
    // 先写先得：规范键优先于后出现的别名；若已有规范键则不覆盖
    // 但别名与规范键等价：第一次非空写入
    if (canonical[canon] === undefined) {
      canonical[canon] = value
    }
  }

  // 若同时出现规范键与别名，规范键应赢：再扫一遍规范键名
  for (const k of SKILL_FRONTMATTER_CANONICAL) {
    if (raw[k] !== undefined && raw[k] !== '') {
      canonical[k] = raw[k]
    }
  }

  const fallbackId = opts?.fallbackId?.trim() || undefined
  const idRaw = canonical.id?.trim() || fallbackId
  const id = idRaw ? normalizeSkillId(idRaw) : undefined
  const name = canonical.name?.trim() || id
  const description = canonical.description?.trim() || undefined
  const whenToUse = canonical.when_to_use?.trim() || undefined

  return {
    id,
    name,
    description,
    whenToUse,
    disableModelInvocation: parseSkillBoolean(
      canonical['disable-model-invocation'],
      false,
    ),
    userInvocable: parseSkillBoolean(canonical['user-invocable'], true),
    canonical,
    raw: { ...raw },
  }
}

/** id：去空白 → 小写可选保持原样；仅压连续空白为 - */
export function normalizeSkillId(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 从 SKILL.md 全文解析 body + 契约 meta 字段。
 */
export function parseSkillMarkdown(
  raw: string,
  opts?: { fallbackId?: string },
): {
  body: string
  fields: ParsedSkillFrontmatter
} {
  const { frontmatter, body } = parseMarkdownFrontmatter(raw)
  const fields = parseSkillFrontmatterFields(frontmatter, opts)
  return { body, fields }
}