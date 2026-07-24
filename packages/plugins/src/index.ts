/**
 * 插件加载与贡献点合并（PL1 + PL2 最小）
 *
 * 能力：发现 user/project `.bolo/plugins/*` + `bolo.plugin.json`；
 * 合并 contributes.skills（缺省则扫根下 `skills/`）、hooks、mcp、agents、commands。
 * PL2：contributes.commands 扫 markdown 为 slash 可调用命令；热加载由 core `/plugins reload` 触发。
 * 非市场、非远程安装。
 *
 * 后写覆盖前写；同名 mcp 冲突时记录 error 并覆盖。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { HooksConfig } from '../../shared/src/index.ts'
import { discoverSkillsInDir, type LoadedSkill } from '../../skills/src/index.ts'
import { loadMcpConfigFile, type McpServerConfig } from '../../mcp/src/index.ts'

export type PluginManifest = {
  id: string
  name: string
  version: string
  contributes?: {
    skills?: string[]
    hooks?: string
    mcpServers?: string
    agents?: string[]
    /** 相对插件根的命令目录；扫 `*.md` → slash 名（可带 pluginId: 前缀） */
    commands?: string[]
  }
}

export type PluginScope = 'user' | 'project' | 'session'

export type LoadedPlugin = {
  manifest: PluginManifest
  root: string
  scope: PluginScope
}

/** 插件贡献的 slash 命令（对照 HC plugin commands；无市场） */
export type PluginCommand = {
  /** slash 名（小写）；默认可为 `id` 或 `pluginId:id` */
  name: string
  /** 短 id（文件名 / frontmatter） */
  id: string
  pluginId: string
  description?: string
  body: string
  path: string
  scope: PluginScope
}

export type MergeResult = {
  plugins: LoadedPlugin[]
  skills: LoadedSkill[]
  hooks: HooksConfig
  mcpServers: McpServerConfig[]
  agents: string[]
  commands: PluginCommand[]
  errors: string[]
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function parseMdFrontmatter(raw: string): {
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

/** 规范化 slash 名：小写、空格→-、仅保留 [a-z0-9_:-] */
export function normalizePluginCommandName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_:-]/g, '')
}

/**
 * 从单个 markdown 文件装载插件命令。
 * frontmatter: name / id / description；缺省 id=文件名。
 */
export async function loadPluginCommandFile(
  filePath: string,
  plugin: LoadedPlugin,
): Promise<PluginCommand | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const { frontmatter, body } = parseMdFrontmatter(raw)
    const base = path.basename(filePath, path.extname(filePath))
    if (base.toLowerCase() === 'skill') return null
    const id = normalizePluginCommandName(
      frontmatter.id || frontmatter.name || base,
    )
    if (!id) return null
    const bare = normalizePluginCommandName(frontmatter.name || id)
    // 默认命名空间 pluginId:cmd，避免与内置 slash 撞名；显式 name 含 `:` 则原样
    const name =
      bare.includes(':')
        ? bare
        : normalizePluginCommandName(`${plugin.manifest.id}:${bare}`)
    return {
      name,
      id: bare.includes(':') ? bare.split(':').pop() || bare : bare,
      pluginId: plugin.manifest.id,
      description: frontmatter.description,
      body: body.trim(),
      path: filePath,
      scope: plugin.scope,
    }
  } catch {
    return null
  }
}

/** 扫目录下一层 `*.md`（不递归；对照 HC walk 简化） */
export async function discoverPluginCommandsInDir(
  dir: string,
  plugin: LoadedPlugin,
): Promise<PluginCommand[]> {
  const out: PluginCommand[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const full = path.join(dir, name)
    try {
      const st = await fs.stat(full)
      if (!st.isFile()) continue
    } catch {
      continue
    }
    const cmd = await loadPluginCommandFile(full, plugin)
    if (cmd) out.push(cmd)
  }
  return out
}

export async function loadPluginFromDir(
  dir: string,
  scope: PluginScope,
): Promise<LoadedPlugin | null> {
  const manifestPath = path.join(dir, 'bolo.plugin.json')
  const manifest = await readJson<PluginManifest>(manifestPath)
  if (!manifest?.id) return null
  return { manifest, root: dir, scope }
}

export async function discoverPlugins(
  roots: { dir: string; scope: PluginScope }[],
): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = []
  const byId = new Map<string, LoadedPlugin>()
  for (const { dir, scope } of roots) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = path.join(dir, name)
      try {
        const st = await fs.stat(full)
        if (!st.isDirectory()) continue
      } catch {
        continue
      }
      const p = await loadPluginFromDir(full, scope)
      if (!p) continue
      // 同 id：后扫覆盖前扫（project 覆盖 user）
      byId.set(p.manifest.id, p)
    }
  }
  for (const p of byId.values()) out.push(p)
  return out
}

function deepMergeHooks(base: HooksConfig, extra: HooksConfig): HooksConfig {
  const result: HooksConfig = { ...base }
  for (const [event, groups] of Object.entries(extra) as [
    keyof HooksConfig,
    HooksConfig[keyof HooksConfig],
  ][]) {
    if (!groups) continue
    const prev = result[event] ?? []
    result[event] = [...prev, ...groups]
  }
  return result
}

/**
 * 合并顺序：defaults → plugins（传入顺序）→ project overrides 由调用方控制顺序
 */
export async function mergePluginContributions(
  plugins: LoadedPlugin[],
  defaults?: Partial<MergeResult>,
): Promise<MergeResult> {
  const errors: string[] = []
  let skills: LoadedSkill[] = [...(defaults?.skills ?? [])]
  let hooks: HooksConfig = { ...(defaults?.hooks ?? {}) }
  let mcpServers: McpServerConfig[] = [...(defaults?.mcpServers ?? [])]
  const agents: string[] = [...(defaults?.agents ?? [])]
  let commands: PluginCommand[] = [...(defaults?.commands ?? [])]
  const seenSkillIds = new Set(skills.map((s) => s.meta.id))
  const seenMcp = new Set(mcpServers.map((s) => s.name))
  const seenCmdNames = new Set(commands.map((c) => c.name))

  for (const plugin of plugins) {
    const c = plugin.manifest.contributes

    // skills：contributes.skills 相对路径列表；未声明则扫 <plugin>/skills/；显式 [] 跳过
    let skillRels: string[]
    if (c?.skills && c.skills.length > 0) {
      skillRels = c.skills
    } else if (c === undefined || c.skills === undefined) {
      skillRels = ['skills']
    } else {
      skillRels = []
    }
    for (const rel of skillRels) {
      const dir = path.resolve(plugin.root, rel)
      const found = await discoverSkillsInDir(dir, 'plugin')
      for (const s of found) {
        if (seenSkillIds.has(s.meta.id)) {
          skills = skills.filter((x) => x.meta.id !== s.meta.id)
        }
        seenSkillIds.add(s.meta.id)
        skills.push(s)
      }
    }

    if (c?.hooks) {
      const hookPath = path.resolve(plugin.root, c.hooks)
      const cfg = await readJson<HooksConfig>(hookPath)
      if (cfg) hooks = deepMergeHooks(hooks, cfg)
      else errors.push(`plugin ${plugin.manifest.id}: cannot read hooks ${c.hooks}`)
    }

    if (c?.mcpServers) {
      const mcpPath = path.resolve(plugin.root, c.mcpServers)
      const servers = await loadMcpConfigFile(mcpPath)
      for (const s of servers) {
        if (seenMcp.has(s.name)) {
          errors.push(
            `mcp server name conflict: ${s.name} (plugin ${plugin.manifest.id}) — override`,
          )
          mcpServers = mcpServers.filter((x) => x.name !== s.name)
        }
        seenMcp.add(s.name)
        mcpServers.push(s)
      }
    }

    if (c?.agents) {
      for (const a of c.agents) {
        if (!agents.includes(a)) agents.push(a)
      }
    }

    // commands：显式列表；未声明则尝试 commands/（目录不存在则空）
    let cmdRels: string[]
    if (c?.commands && c.commands.length > 0) {
      cmdRels = c.commands
    } else if (c === undefined || c.commands === undefined) {
      cmdRels = ['commands']
    } else {
      cmdRels = []
    }
    for (const rel of cmdRels) {
      const dir = path.resolve(plugin.root, rel)
      const found = await discoverPluginCommandsInDir(dir, plugin)
      for (const cmd of found) {
        if (seenCmdNames.has(cmd.name)) {
          commands = commands.filter((x) => x.name !== cmd.name)
          errors.push(
            `plugin command name conflict: /${cmd.name} (plugin ${plugin.manifest.id}) — override`,
          )
        }
        seenCmdNames.add(cmd.name)
        commands.push(cmd)
      }
    }
  }

  return { plugins, skills, hooks, mcpServers, agents, commands, errors }
}

export function findPluginCommand(
  commands: PluginCommand[] | undefined,
  name: string,
): PluginCommand | undefined {
  if (!commands?.length) return undefined
  const n = normalizePluginCommandName(name)
  return (
    commands.find((c) => c.name === n) ??
    commands.find((c) => c.id === n) ??
    commands.find((c) => c.name.endsWith(':' + n))
  )
}

// ── 插件市场（PL-MKT 最小）──
export {
  registerMarketplace,
  listKnownMarketplaces,
  loadCatalogForKnown,
  searchMarketplacePlugins,
  installPluginFromMarketplace,
  installPluginFromPath,
  uninstallPlugin,
  listInstalledPlugins,
  parseMarketplaceCatalog,
  loadMarketplaceCatalogFromPath,
  knownMarketplacesPath,
  installedPluginsPath,
  type MarketplaceCatalog,
  type MarketplacePluginEntry,
  type KnownMarketplace,
  type InstalledPluginRecord,
  type MarketplaceSearchHit,
} from './marketplace.ts'