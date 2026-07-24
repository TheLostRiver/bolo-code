/**
 * `.bolo/rules` 发现与装载 — 对照 HC `.claude/rules` 多文件约束 + Antigravity 式 rules 目录
 * 无遥测。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getBoloHomeDir } from '../../config/src/paths.ts'

/** 单 rule 文件默认上限（字符），对齐 BOLO.md */
export const BOLO_RULES_MAX_CHARS_PER_FILE = 32_000
/** 全部 rules 合计上限 */
export const BOLO_RULES_MAX_TOTAL_CHARS = 48_000

export type BoloRuleSource = {
  /** 逻辑路径（相对 cwd 或 ~ 提示） */
  label: string
  absPath: string
  chars: number
  truncated: boolean
  /** 来源层：用户全局 / 项目 */
  scope: 'user' | 'project'
}

export type LoadBoloRulesResult = {
  text: string
  sources: BoloRuleSource[]
}

export type LoadBoloRulesOptions = {
  cwd: string
  /** 覆盖用户配置根（测试用）；默认 getBoloHomeDir() */
  userConfigDir?: string
  maxCharsPerFile?: number
  maxTotalChars?: number
  /** 环境变量 BOLO_DISABLE_RULES 为真时跳过 */
  disable?: boolean
  /** 是否加载用户级 ~/.bolo/rules（默认 true） */
  loadUserRules?: boolean
  /** 是否加载项目级 .bolo/rules（默认 true） */
  loadProjectRules?: boolean
  /**
   * 当前相关路径（相对 cwd 或任意路径字符串）。
   * `alwaysApply: false` 且声明了 `paths` 时，任一 activePath 匹配任一 glob 才装载。
   */
  activePaths?: string[]
}

export type RuleFrontmatter = {
  disabled?: boolean
  /** 默认 true；false 时需 paths 匹配 activePaths 才装载，无 paths 则跳过 */
  alwaysApply?: boolean
  /** glob 列表；仅 alwaysApply=false 时参与过滤 */
  paths?: string[]
}

function envDisablesRules(): boolean {
  const v = process.env.BOLO_DISABLE_RULES?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true
  if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false
  return undefined
}

/** 路径归一化为正斜杠（不做 cwd 解析，仅字符串级） */
export function normalizeRulePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

/**
 * 最小 glob：`*` 不跨 `/`，`**` 可跨多层；也支持纯后缀（如 `*.ts` 匹配任意深度）。
 * pattern / path 均按正斜杠比较。
 */
export function matchRulePathGlob(filePath: string, pattern: string): boolean {
  const pathNorm = normalizeRulePath(filePath)
  const pat = normalizeRulePath(pattern).trim()
  if (!pat) return false

  // 纯后缀：*.ext / **/*.ext — 已由 ** 规则覆盖；额外：无 / 的 *.x 匹配任意段尾
  const re = globToRegExp(pat)
  if (re.test(pathNorm)) return true

  // 后缀匹配：pattern 以 * 开头且无 ** 时，也允许匹配 basename / 路径尾
  if (pat.startsWith('*.') && !pat.includes('/')) {
    const suffix = pat.slice(1) // e.g. .ts
    return pathNorm.endsWith(suffix) || pathNorm.split('/').pop()?.endsWith(suffix) === true
  }
  return false
}

function globToRegExp(glob: string): RegExp {
  let i = 0
  let out = '^'
  while (i < glob.length) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** 或 **/
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
      continue
    }
    if (c === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if ('\\.[]{}()+-^$|'.includes(c)) {
      out += '\\' + c
      i += 1
      continue
    }
    out += c
    i += 1
  }
  out += '$'
  return new RegExp(out)
}

/** 任一 activePath 匹配任一 glob */
export function activePathsMatchGlobs(
  activePaths: readonly string[] | undefined,
  globs: readonly string[] | undefined,
): boolean {
  if (!activePaths?.length || !globs?.length) return false
  for (const ap of activePaths) {
    for (const g of globs) {
      if (matchRulePathGlob(ap, g)) return true
    }
  }
  return false
}

function parsePathsValue(val: string): string[] | undefined {
  const v = val.trim()
  if (!v || v === '[]') return []
  // YAML 行内列表: ["a", "b"] 或 ['a','b']
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    const parts = inner.split(',').map((s) => {
      let t = s.trim()
      if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        t = t.slice(1, -1)
      }
      return t.trim()
    })
    return parts.filter(Boolean)
  }
  // 逗号分隔字符串
  return v
    .split(',')
    .map((s) => {
      let t = s.trim()
      if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        t = t.slice(1, -1)
      }
      return t.trim()
    })
    .filter(Boolean)
}

/**
 * 最小 frontmatter：disabled / alwaysApply / paths。
 * 无 frontmatter 时 body = 全文，meta 默认 alwaysApply=true。
 */
export function parseRuleFrontmatter(raw: string): {
  meta: RuleFrontmatter
  body: string
} {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) {
    return { meta: { alwaysApply: true }, body: text }
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) {
    return { meta: { alwaysApply: true }, body: text }
  }
  const fmBlock = text.slice(3, end).replace(/^\r?\n/, '')
  let body = text.slice(end + 4) // after \n---
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)

  const meta: RuleFrontmatter = { alwaysApply: true }
  const lines = fmBlock.split(/\r?\n/)
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // YAML 多行列表: paths:\n  - a\n  - b
    const listKey = /^([A-Za-z_][\w-]*)\s*:\s*$/.exec(trimmed)
    if (listKey && listKey[1]!.toLowerCase() === 'paths') {
      const items: string[] = []
      while (li + 1 < lines.length) {
        const next = lines[li + 1]!
        const item = /^\s*-\s+(.+)$/.exec(next)
        if (!item) break
        li++
        let t = item[1]!.trim()
        if (
          (t.startsWith('"') && t.endsWith('"')) ||
          (t.startsWith("'") && t.endsWith("'"))
        ) {
          t = t.slice(1, -1)
        }
        if (t) items.push(t)
      }
      meta.paths = items
      continue
    }

    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const val = m[2]!.trim()
    if (key === 'disabled') {
      const b = parseBool(val)
      if (b !== undefined) meta.disabled = b
    } else if (key === 'alwaysapply') {
      const b = parseBool(val)
      if (b !== undefined) meta.alwaysApply = b
    } else if (key === 'paths') {
      const parsed = parsePathsValue(val)
      if (parsed !== undefined) meta.paths = parsed
    }
  }
  return { meta, body }
}

function clipText(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return {
    text:
      text.slice(0, Math.max(0, max - 40)) +
      '\n\n…(truncated: exceeded max chars for this file)',
    truncated: true,
  }
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const name = ent.name
      if (name === 'node_modules' || name === '.git') continue
      const abs = path.join(current, name)
      if (ent.isDirectory()) {
        await walk(abs)
        continue
      }
      if (ent.isFile() && name.toLowerCase().endsWith('.md')) {
        out.push(abs)
      }
    }
  }
  await walk(dir)
  return out
}

function toPosixRel(from: string, abs: string): string {
  return path.relative(from, abs).split(path.sep).join('/')
}

type RuleCandidate = {
  label: string
  absPath: string
  scope: 'user' | 'project'
}

/**
 * 收集候选 rule 文件：用户目录先、项目目录后；各自路径名稳定排序。
 */
export async function collectRuleCandidates(opts: {
  cwd: string
  userConfigDir: string
  loadUserRules?: boolean
  loadProjectRules?: boolean
}): Promise<RuleCandidate[]> {
  const cwd = path.resolve(opts.cwd)
  const userRoot = path.join(opts.userConfigDir, 'rules')
  const projectRoot = path.join(cwd, '.bolo', 'rules')
  const list: RuleCandidate[] = []

  if (opts.loadUserRules !== false) {
    const files = await walkMarkdownFiles(userRoot)
    files.sort((a, b) =>
      toPosixRel(userRoot, a).localeCompare(toPosixRel(userRoot, b)),
    )
    for (const abs of files) {
      const rel = toPosixRel(userRoot, abs)
      list.push({
        label: `~/.bolo/rules/${rel}`,
        absPath: abs,
        scope: 'user',
      })
    }
  }

  if (opts.loadProjectRules !== false) {
    const files = await walkMarkdownFiles(projectRoot)
    files.sort((a, b) =>
      toPosixRel(projectRoot, a).localeCompare(toPosixRel(projectRoot, b)),
    )
    for (const abs of files) {
      const rel = toPosixRel(projectRoot, abs)
      list.push({
        label: `.bolo/rules/${rel}`,
        absPath: abs,
        scope: 'project',
      })
    }
  }

  return list
}

/**
 * 扫描并加载 rules，带字符预算与 frontmatter 过滤。
 */
export async function loadBoloRules(
  opts: LoadBoloRulesOptions,
): Promise<LoadBoloRulesResult> {
  if (opts.disable || envDisablesRules()) {
    return { text: '', sources: [] }
  }

  const maxPer = opts.maxCharsPerFile ?? BOLO_RULES_MAX_CHARS_PER_FILE
  const maxTotal = opts.maxTotalChars ?? BOLO_RULES_MAX_TOTAL_CHARS
  const userConfigDir = opts.userConfigDir ?? getBoloHomeDir()
  const candidates = await collectRuleCandidates({
    cwd: opts.cwd,
    userConfigDir,
    loadUserRules: opts.loadUserRules,
    loadProjectRules: opts.loadProjectRules,
  })

  const blocks: string[] = []
  const sources: BoloRuleSource[] = []
  let used = 0
  const seen = new Set<string>()

  for (const c of candidates) {
    const key = path.normalize(c.absPath).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    let raw: string
    try {
      const st = await fs.stat(c.absPath)
      if (!st.isFile()) continue
      raw = await fs.readFile(c.absPath, 'utf8')
    } catch {
      continue
    }

    const { meta, body } = parseRuleFrontmatter(raw)
    if (meta.disabled === true) continue
    // alwaysApply 默认 true：总是装载（忽略 paths）
    if (meta.alwaysApply === false) {
      const globs = meta.paths?.filter(Boolean) ?? []
      if (!globs.length) continue // 无 paths → 跳过
      if (!activePathsMatchGlobs(opts.activePaths, globs)) continue
    }

    const trimmed = body.trim()
    if (!trimmed) continue

    const remain = maxTotal - used
    if (remain <= 0) break

    const budget = Math.min(maxPer, remain)
    const { text: clipped, truncated } = clipText(trimmed, budget)
    used += clipped.length
    sources.push({
      label: c.label,
      absPath: c.absPath,
      chars: clipped.length,
      truncated,
      scope: c.scope,
    })
    blocks.push(`### ${c.label}\n\n${clipped}${truncated ? '\n' : ''}`)
  }

  if (!blocks.length) return { text: '', sources: [] }

  const text = [
    '# Project rules',
    'Standing constraints from `.bolo/rules` (and optional `~/.bolo/rules`).',
    'Follow them when relevant. They are not tool output.',
    '',
    ...blocks,
  ].join('\n')

  return { text, sources }
}