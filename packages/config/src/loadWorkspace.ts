/**
 * 解析完整工作区配置：全局 ~/.bolo + 项目 .bolo
 * 对照 HelsincyCode：user settings + project settings 分层
 */

import type { HooksConfig } from '../../shared/src/index.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'
import {
  discoverSkills,
  type LoadedSkill,
} from '../../skills/src/index.ts'
import {
  loadMcpConfigFile,
  type McpServerConfig,
} from '../../mcp/src/index.ts'
import {
  discoverPlugins,
  mergePluginContributions,
  type LoadedPlugin,
  type MergeResult,
} from '../../plugins/src/index.ts'
import {
  createProviderFromEnv,
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

export type ResolvedWorkspace = {
  cwd: string
  user: BoloLayoutPaths
  project: BoloLayoutPaths
  config: BoloConfigJson
  permissionMode: PermissionMode
  hooks: HooksConfig
  mcpServers: McpServerConfig[]
  skills: LoadedSkill[]
  plugins: LoadedPlugin[]
  pluginMerge?: MergeResult
  provider: LlmProvider
  providerKind: ProviderKind
  providerModel?: string
  providerBaseUrl?: string
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

function mergeMcpServers(
  user: McpServerConfig[],
  project: McpServerConfig[],
): McpServerConfig[] {
  const map = new Map<string, McpServerConfig>()
  for (const s of user) map.set(s.name, s)
  for (const s of project) map.set(s.name, s)
  return [...map.values()]
}

/**
 * 文件 config + 环境变量 → Provider
 * 优先级：env > config.provider > defaults
 */
export function resolveProviderFromConfig(config: BoloConfigJson): {
  provider: LlmProvider
  kind: ProviderKind
  model?: string
  baseUrl?: string
} {
  const kindRaw = config.provider?.kind
  const kind =
    kindRaw === 'anthropic'
      ? 'anthropic'
      : kindRaw === 'mock'
        ? 'mock'
        : kindRaw === 'openai-responses'
          ? 'openai-responses'
          : kindRaw === 'openai-compatible'
            ? 'openai-compatible'
            : undefined

  return createProviderFromEnv({
    kind,
    apiKey: config.provider?.apiKey,
    baseUrl: config.provider?.baseUrl,
    model: config.provider?.model,
    timeoutMs: config.provider?.timeoutMs,
    maxTokens: config.provider?.maxTokens,
    forceMock: kindRaw === 'mock',
  })
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

  let mcpServers = mergeMcpServers(
    await loadMcpConfigFile(user.mcpJson),
    await loadMcpConfigFile(project.mcpJson),
  )

  let skills = await discoverSkills({
    cwd,
    userBoloDir: user.root,
  })

  let plugins: LoadedPlugin[] = []
  let pluginMerge: MergeResult | undefined

  if (loadPluginsFlag) {
    plugins = await discoverPlugins([
      { dir: user.pluginsDir, scope: 'user' },
      { dir: project.pluginsDir, scope: 'project' },
    ])
    pluginMerge = await mergePluginContributions(plugins, {
      skills: [],
      hooks: {},
      mcpServers: [],
      agents: [],
      commands: [],
    })
    hooks = mergeHooks(hooks, pluginMerge.hooks)
    mcpServers = mergeMcpServers(mcpServers, pluginMerge.mcpServers)
    const skillMap = new Map(skills.map((s) => [s.meta.id, s]))
    for (const s of pluginMerge.skills) skillMap.set(s.meta.id, s)
    skills = [...skillMap.values()]
  }

  const { provider, kind, model, baseUrl } = resolveProviderFromConfig(config)
  const permissionMode = (config.permissionMode ?? 'default') as PermissionMode

  return {
    cwd,
    user,
    project,
    config,
    permissionMode,
    hooks,
    mcpServers,
    skills,
    plugins,
    pluginMerge,
    provider,
    providerKind: kind,
    providerModel: model,
    providerBaseUrl: baseUrl,
    createdPaths,
  }
}