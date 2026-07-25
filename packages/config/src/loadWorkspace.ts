/**
 * 解析完整工作区配置：全局 ~/.bolo + 项目 .bolo
 * 对照 HelsincyCode：user settings + project settings 分层
 */

import type { HooksConfig } from '../../shared/src/index.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'
import path from 'node:path'
import {
  discoverSkills,
  mergeSkillsByPrecedence,
  type LoadedSkill,
} from '../../skills/src/index.ts'
import {
  loadMcpConfigFileDetailed,
  mergeMcpServerLayers,
  tagMcpServerScope,
  type McpServerConfig,
} from '../../mcp/src/index.ts'
import {
  discoverPluginsDetailed,
  mergePluginContributions,
  importForeignPluginSkillsFromRoots,
  type LoadedPlugin,
  type MergeResult,
} from '../../plugins/src/index.ts'
import {
  createProviderFromEnv,
  createProviderFromProfile,
  type LlmProvider,
  type ProviderKind,
} from '../../providers/src/index.ts'
import { ensureAllLayouts } from './ensure.ts'
import { loadConfigJson, loadHooksJson, mergeConfigs } from './io.ts'
import {
  getProjectLayout,
  getUserLayout,
  type BoloLayoutPaths,
} from './paths.ts'
import type { BoloConfigJson } from './types.ts'
import {
  getProviderProfile,
  normalizeProviderRegistry,
  type ProviderProfile,
  type ProviderRegistry,
} from './providerRegistry.ts'

export type ResolvedWorkspace = {
  cwd: string
  user: BoloLayoutPaths
  project: BoloLayoutPaths
  config: BoloConfigJson
  permissionMode: PermissionMode
  hooks: HooksConfig
  mcpServers: McpServerConfig[]
  /** M-GEN-1：mcp.json 校验 / 解析 warnings（不阻断会话） */
  mcpConfigWarnings?: string[]
  skills: LoadedSkill[]
  plugins: LoadedPlugin[]
  pluginMerge?: MergeResult
  provider: LlmProvider
  providerKind: ProviderKind
  providerModel?: string
  providerBaseUrl?: string
  /** active profile 缺少所需 key；CLI 可提示/延迟失败，不能据全局 env 误判 */
  providerMissingKey?: boolean
  /** P1：归一化后的多 provider 表 */
  providerRegistry: ProviderRegistry
  /** 启动 active profile id */
  providerId: string
  /** active profile 快照（无运行时 client） */
  providerProfile?: ProviderProfile
  createdPaths: string[]
}

function mergeHooks(a: HooksConfig, b: HooksConfig): HooksConfig {
  const out: HooksConfig = { ...a }
  for (const [k, groups] of Object.entries(b) as [
    keyof HooksConfig,
    HooksConfig[keyof HooksConfig],
  ][]) {
    if (!groups) continue
    out[k] = [...(out[k] ?? []), ...groups]
  }
  return out
}

/**
 * 文件 config + 环境变量 → Provider（active = defaultProvider）。
 * 优先级：profile 字段 / apiKeyEnv > 全局 env 回落 > defaults
 */
export function resolveProviderFromConfig(config: BoloConfigJson): {
  provider: LlmProvider
  kind: ProviderKind
  model?: string
  baseUrl?: string
  profileId: string
  registry: ProviderRegistry
  profile?: ProviderProfile
  missingKey?: boolean
} {
  const registry = normalizeProviderRegistry(config)
  const profileId = registry.defaultId
  const profile = getProviderProfile(registry, profileId)

  if (!profile) {
    // 不应发生；兜底 mock
    const fallback = createProviderFromEnv({ forceMock: true })
    return {
      ...fallback,
      profileId: 'default',
      registry,
      missingKey: true,
    }
  }

  const built = createProviderFromProfile(profile)
  return {
    provider: built.provider,
    kind: built.kind,
    model: built.model ?? profile.model,
    baseUrl: built.baseUrl ?? profile.baseUrl,
    profileId,
    registry,
    profile,
    ...(built.missingKey ? { missingKey: true } : {}),
  }
}

export type LoadWorkspaceOptions = {
  cwd: string
  ensureDefaults?: boolean
  loadPlugins?: boolean
}

export async function loadWorkspace(
  options: LoadWorkspaceOptions,
): Promise<ResolvedWorkspace> {
  const cwd = options.cwd
  const ensureDefaults = options.ensureDefaults !== false
  const loadPluginsFlag = options.loadPlugins !== false

  const ensured = await ensureAllLayouts(cwd, {
    writeDefaults: ensureDefaults,
  })
  const createdPaths = [...ensured.user.created, ...ensured.project.created]

  const user = getUserLayout()
  const project = getProjectLayout(cwd)

  const userConfig = await loadConfigJson(user)
  const projectConfig = await loadConfigJson(project)
  const config = mergeConfigs(userConfig, projectConfig)

  let hooks = mergeHooks(
    await loadHooksJson(user),
    await loadHooksJson(project),
  )

  const userMcp = await loadMcpConfigFileDetailed(user.mcpJson)
  const projectMcp = await loadMcpConfigFileDetailed(project.mcpJson)
  const mcpConfigWarnings = [
    ...userMcp.warnings.map((w) => `user mcp: ${w}`),
    ...projectMcp.warnings.map((w) => `project mcp: ${w}`),
  ]

  // M-GEN-8：user → project → plugins（后层赢）；同名覆盖记 warning
  const mcpLayers: Array<{
    label: string
    servers: McpServerConfig[]
  }> = [
    {
      label: 'user',
      servers: tagMcpServerScope(userMcp.servers, 'user'),
    },
    {
      label: 'project',
      servers: tagMcpServerScope(projectMcp.servers, 'project'),
    },
  ]

  let skills = await discoverSkills({
    cwd,
    userBoloDir: user.root,
    // S-PORT-2：仅配置显式列出的旁路根；默认空 = off
    extraSkillRoots: config.extraSkillRoots,
  })

  let plugins: LoadedPlugin[] = []
  let pluginMerge: MergeResult | undefined

  if (loadPluginsFlag) {
    // PL-SPEC-1：坏 manifest 跳过并记 errors，不拖垮其它插件
    const detailed = await discoverPluginsDetailed([
      { dir: user.pluginsDir, scope: 'user' },
      { dir: project.pluginsDir, scope: 'project' },
    ])
    plugins = detailed.plugins
    const pluginDiscoverErrors = detailed.errors

    // 每插件一层，label=plugin:<id>（project 插件后 discover，可盖 user 插件）
    for (const plugin of plugins) {
      const rel = plugin.manifest.contributes?.mcpServers
      if (!rel) continue
      const mcpPath = path.resolve(plugin.root, rel)
      const loaded = await loadMcpConfigFileDetailed(mcpPath)
      for (const w of loaded.warnings) {
        mcpConfigWarnings.push(`plugin ${plugin.manifest.id} mcp: ${w}`)
      }
      mcpLayers.push({
        label: `plugin:${plugin.manifest.id}`,
        servers: tagMcpServerScope(loaded.servers, 'plugin'),
      })
    }

    pluginMerge = await mergePluginContributions(plugins, {
      skills: [],
      hooks: {},
      // MCP 已在上方分层合并；此处传空避免双重合并
      mcpServers: [],
      agents: [],
      commands: [],
    })
    if (pluginDiscoverErrors.length) {
      pluginMerge.errors = [
        ...pluginDiscoverErrors,
        ...(pluginMerge.errors ?? []),
      ]
    }
    hooks = mergeHooks(hooks, pluginMerge.hooks)
    // S-PORT-3：plugin skills 盖过 bundled/user/project
    skills = mergeSkillsByPrecedence(skills, pluginMerge.skills)
  }

  // IMPORT-P1：外来插件只读 skills（配置显式根；默认 off）
  if (config.foreignPluginRoots?.length) {
    const foreign = await importForeignPluginSkillsFromRoots(
      config.foreignPluginRoots,
    )
    if (foreign.skills.length) {
      skills = mergeSkillsByPrecedence(skills, foreign.skills)
    }
    if (foreign.warnings.length) {
      if (!pluginMerge) {
        pluginMerge = {
          plugins: [],
          skills: [],
          hooks: {},
          mcpServers: [],
          agents: [],
          commands: [],
          errors: [],
        }
      }
      const merge = pluginMerge
      merge.errors = [
        ...(merge.errors ?? []),
        ...foreign.warnings,
      ]
    }
  }

  const mcpMerged = mergeMcpServerLayers(mcpLayers)
  mcpConfigWarnings.push(...mcpMerged.warnings)
  const mcpServers = mcpMerged.servers

  const resolved = resolveProviderFromConfig(config)
  const permissionMode = (config.permissionMode ?? 'default') as PermissionMode

  return {
    cwd,
    user,
    project,
    config,
    permissionMode,
    hooks,
    mcpServers,
    ...(mcpConfigWarnings.length ? { mcpConfigWarnings } : {}),
    skills,
    plugins,
    pluginMerge,
    provider: resolved.provider,
    providerKind: resolved.kind,
    providerModel: resolved.model,
    providerBaseUrl: resolved.baseUrl,
    ...(resolved.missingKey ? { providerMissingKey: true } : {}),
    providerRegistry: resolved.registry,
    providerId: resolved.profileId,
    providerProfile: resolved.profile,
    createdPaths,
  }
}
