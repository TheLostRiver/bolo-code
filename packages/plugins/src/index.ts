/**
 * 插件加载与贡献点合并
 * 后写覆盖前写；同名 tool 冲突时记录 error 并跳过后者
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
    commands?: string[]
  }
}

export type PluginScope = 'user' | 'project' | 'session'

export type LoadedPlugin = {
  manifest: PluginManifest
  root: string
  scope: PluginScope
}

export type MergeResult = {
  plugins: LoadedPlugin[]
  skills: LoadedSkill[]
  hooks: HooksConfig
  mcpServers: McpServerConfig[]
  agents: string[]
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
  for (const { dir, scope } of roots) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = await loadPluginFromDir(path.join(dir, name), scope)
      if (p) out.push(p)
    }
  }
  return out
}

function deepMergeHooks(base: HooksConfig, extra: HooksConfig): HooksConfig {
  const result: HooksConfig = { ...base }
  for (const [event, groups] of Object.entries(extra) as [keyof HooksConfig, HooksConfig[keyof HooksConfig]][]) {
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
  const seenSkillIds = new Set(skills.map((s) => s.meta.id))
  const seenMcp = new Set(mcpServers.map((s) => s.name))

  for (const plugin of plugins) {
    const c = plugin.manifest.contributes
    if (!c) continue

    if (c.skills) {
      for (const rel of c.skills) {
        const dir = path.resolve(plugin.root, rel)
        const found = await discoverSkillsInDir(dir, 'plugin')
        for (const s of found) {
          if (seenSkillIds.has(s.meta.id)) {
            // 后写覆盖
            skills = skills.filter((x) => x.meta.id !== s.meta.id)
          }
          seenSkillIds.add(s.meta.id)
          skills.push(s)
        }
      }
    }

    if (c.hooks) {
      const hookPath = path.resolve(plugin.root, c.hooks)
      const cfg = await readJson<HooksConfig>(hookPath)
      if (cfg) hooks = deepMergeHooks(hooks, cfg)
      else errors.push(`plugin ${plugin.manifest.id}: cannot read hooks ${c.hooks}`)
    }

    if (c.mcpServers) {
      const mcpPath = path.resolve(plugin.root, c.mcpServers)
      const servers = await loadMcpConfigFile(mcpPath)
      for (const s of servers) {
        if (seenMcp.has(s.name)) {
          errors.push(`mcp server name conflict: ${s.name} (plugin ${plugin.manifest.id}) — override`)
          mcpServers = mcpServers.filter((x) => x.name !== s.name)
        }
        seenMcp.add(s.name)
        mcpServers.push(s)
      }
    }

    if (c.agents) {
      for (const a of c.agents) {
        if (!agents.includes(a)) agents.push(a)
      }
    }
  }

  return { plugins, skills, hooks, mcpServers, agents, errors }
}