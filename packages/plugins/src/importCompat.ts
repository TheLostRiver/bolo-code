/**
 * 外来插件只读导入（IMPORT-P1 / IMPORT-X）
 * 识别 Claude / Codex 侧常见 plugin 清单 → **仅映射 skills**（+ 可选 mcp 路径提示）。
 * hooks **不保证**；不接官方 market API；不改对方文件。
 * 无遥测。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  discoverSkillsInDir,
  type LoadedSkill,
} from '../../skills/src/index.ts'

export type ForeignPluginKind = 'claude' | 'codex' | 'bolo' | 'unknown'

export type ForeignPluginDetect = {
  kind: ForeignPluginKind
  /** 清单文件绝对路径（若有） */
  manifestPath: string | null
  root: string
}

export type ImportForeignPluginResult = {
  kind: ForeignPluginKind
  root: string
  skills: LoadedSkill[]
  /** 若清单声明了 mcp 配置相对路径，仅作提示（不自动合并 hooks） */
  mcpPathHint?: string
  warnings: string[]
  /** 未支持的 contributes / 能力 */
  unsupported: string[]
}

const CLAUDE_MANIFESTS = [
  path.join('.claude-plugin', 'plugin.json'),
  'plugin.json',
] as const

const CODEX_MANIFESTS = [
  path.join('.codex-plugin', 'plugin.json'),
  path.join('.agents', 'plugins', 'plugin.json'),
] as const

async function readJsonObject(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw as Record<string, unknown>
  } catch {
    return null
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

/**
 * 探测目录是哪种外来/本地插件形态（只读，不加载内容）。
 */
export async function detectForeignPluginDir(
  root: string,
): Promise<ForeignPluginDetect> {
  const abs = path.resolve(root)
  if (await fileExists(path.join(abs, 'bolo.plugin.json'))) {
    return {
      kind: 'bolo',
      manifestPath: path.join(abs, 'bolo.plugin.json'),
      root: abs,
    }
  }
  for (const rel of CODEX_MANIFESTS) {
    const p = path.join(abs, rel)
    if (await fileExists(p)) {
      return { kind: 'codex', manifestPath: p, root: abs }
    }
  }
  for (const rel of CLAUDE_MANIFESTS) {
    const p = path.join(abs, rel)
    if (await fileExists(p)) {
      // 根 plugin.json 也可能是别的；有 .claude-plugin 或 skills 字段再标 claude
      if (rel.startsWith('.claude-plugin') || rel === 'plugin.json') {
        return { kind: 'claude', manifestPath: p, root: abs }
      }
    }
  }
  // 无清单但有 skills/ 目录 → unknown 可当旁路 skill 根
  if (await dirExists(path.join(abs, 'skills'))) {
    return { kind: 'unknown', manifestPath: null, root: abs }
  }
  return { kind: 'unknown', manifestPath: null, root: abs }
}

function collectStringPaths(
  v: unknown,
  out: string[],
): void {
  if (typeof v === 'string' && v.trim()) out.push(v.trim())
  else if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === 'string' && x.trim()) out.push(x.trim())
    }
  }
}

/**
 * 从外来插件目录只读导入 skills。
 * - bolo：提示应走正式 discoverPlugins，仍尝试扫 skills/
 * - claude/codex：解析清单中的 skills 路径；hooks 记 unsupported
 * - 失败面写入 warnings / unsupported（IMPORT-X）
 */
export async function importForeignPluginSkills(
  root: string,
): Promise<ImportForeignPluginResult> {
  const detected = await detectForeignPluginDir(root)
  const abs = detected.root
  const warnings: string[] = []
  const unsupported: string[] = []
  const skills: LoadedSkill[] = []
  let mcpPathHint: string | undefined

  if (detected.kind === 'bolo') {
    warnings.push(
      `import: ${path.basename(abs)} has bolo.plugin.json — prefer Bolo discoverPlugins / plugins dir, not foreign import`,
    )
  }

  let manifest: Record<string, unknown> | null = null
  if (detected.manifestPath) {
    manifest = await readJsonObject(detected.manifestPath)
    if (!manifest) {
      warnings.push(
        `import: cannot parse manifest at ${detected.manifestPath}`,
      )
    }
  }

  const skillRelPaths: string[] = []
  if (manifest) {
    const contributes =
      manifest.contributes &&
      typeof manifest.contributes === 'object' &&
      !Array.isArray(manifest.contributes)
        ? (manifest.contributes as Record<string, unknown>)
        : null

    // 常见字段：contributes.skills | skills | skill_paths
    collectStringPaths(manifest.skills, skillRelPaths)
    collectStringPaths(manifest.skill_paths, skillRelPaths)
    if (contributes) {
      collectStringPaths(contributes.skills, skillRelPaths)
      collectStringPaths(contributes.skill_paths, skillRelPaths)
      if (contributes.hooks !== undefined) {
        unsupported.push('hooks')
        warnings.push(
          'import: hooks contribution is not supported (ignored)',
        )
      }
      if (contributes.commands !== undefined) {
        unsupported.push('commands')
        warnings.push(
          'import: commands contribution is not supported (ignored)',
        )
      }
      if (contributes.agents !== undefined) {
        unsupported.push('agents')
        warnings.push(
          'import: agents contribution is not supported (ignored)',
        )
      }
      const mcp =
        contributes.mcpServers ?? contributes.mcp ?? manifest.mcpServers
      if (typeof mcp === 'string' && mcp.trim()) {
        mcpPathHint = path.resolve(abs, mcp.trim())
        warnings.push(
          `import: mcp path noted only (not auto-merged): ${mcp.trim()}`,
        )
      } else if (mcp !== undefined) {
        unsupported.push('mcpServers(non-path)')
        warnings.push(
          'import: inline mcpServers object is not auto-merged (unsupported shape)',
        )
      }
      for (const key of Object.keys(contributes)) {
        if (
          ![
            'skills',
            'skill_paths',
            'hooks',
            'commands',
            'agents',
            'mcpServers',
            'mcp',
          ].includes(key)
        ) {
          unsupported.push(`contributes.${key}`)
          warnings.push(
            `import: unsupported contributes.${key} (ignored)`,
          )
        }
      }
    } else if (manifest.hooks !== undefined) {
      unsupported.push('hooks')
      warnings.push('import: top-level hooks not supported (ignored)')
    }
  }

  // 默认 skills/ 目录
  if (!skillRelPaths.length) {
    skillRelPaths.push('skills')
  }

  const seenSkillIds = new Set<string>()
  for (const rel of skillRelPaths) {
    const skillRoot = path.isAbsolute(rel) ? rel : path.resolve(abs, rel)
    // 单文件 SKILL.md 路径
    if (skillRoot.toLowerCase().endsWith('skill.md')) {
      const parent = path.dirname(skillRoot)
      const layer = await discoverSkillsInDir(parent, 'plugin')
      for (const s of layer) {
        if (seenSkillIds.has(s.meta.id)) continue
        seenSkillIds.add(s.meta.id)
        skills.push(s)
      }
      continue
    }
    const layer = await discoverSkillsInDir(skillRoot, 'plugin')
    if (!layer.length) {
      // 目录不存在时轻提示
      if (!(await dirExists(skillRoot))) {
        warnings.push(`import: skills path missing: ${rel}`)
      }
    }
    for (const s of layer) {
      if (seenSkillIds.has(s.meta.id)) continue
      seenSkillIds.add(s.meta.id)
      skills.push(s)
    }
  }

  if (!skills.length) {
    warnings.push(
      `import: no skills discovered under ${path.basename(abs)} (not a full runtime port)`,
    )
  }

  return {
    kind: detected.kind,
    root: abs,
    skills,
    mcpPathHint,
    warnings,
    unsupported: [...new Set(unsupported)],
  }
}

/**
 * 批量导入多个外来插件根；合并 skills（后写赢 id）。
 */
export async function importForeignPluginSkillsFromRoots(
  roots: readonly string[],
): Promise<{
  skills: LoadedSkill[]
  warnings: string[]
  results: ImportForeignPluginResult[]
}> {
  const results: ImportForeignPluginResult[] = []
  const warnings: string[] = []
  const byId = new Map<string, LoadedSkill>()
  for (const r of roots) {
    const p = (r ?? '').trim()
    if (!p) continue
    const one = await importForeignPluginSkills(p)
    results.push(one)
    for (const w of one.warnings) {
      warnings.push(`[${path.basename(one.root)}] ${w}`)
    }
    for (const s of one.skills) {
      byId.set(s.meta.id, s)
    }
  }
  return { skills: [...byId.values()], warnings, results }
}