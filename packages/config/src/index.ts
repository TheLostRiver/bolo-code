/**
 * @bolo/config — 全局 ~/.bolo 与项目 .bolo
 * 对照 HelsincyCode CLAUDE_CONFIG_DIR / ~/.claude
 */

export {
  BOLO_DIR_NAME,
  getBoloHomeDir,
  getProjectBoloDir,
  layoutPaths,
  getUserLayout,
  getProjectLayout,
  describeLayout,
  type BoloLayoutPaths,
} from './paths.ts'

export {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_JSONC,
  DEFAULT_AGENTS_CONFIG,
  DEFAULT_AGENTS_README,
  DEFAULT_MCP_FILE,
  DEFAULT_HOOKS_FILE,
  type BoloConfigJson,
  type AgentsConfigJson,
  type ProviderConfigJson,
  type McpFileJson,
  type HooksFileJson,
} from './types.ts'

export {
  normalizeProviderRegistry,
  mergeProviderConfigJson,
  mergeProvidersMaps,
  profileFromConfigJson,
  normalizeEffortDialectFromConfig,
  getProviderProfile,
  listProviderProfileSummaries,
  formatProviderProfileLine,
  type ProviderProfile,
  type ProviderRegistry,
  type ProviderProfileSummary,
  type ProviderKindName,
} from './providerRegistry.ts'

export {
  ensureLayout,
  ensureUserLayout,
  ensureProjectLayout,
  ensureAllLayouts,
  type EnsureLayoutResult,
} from './ensure.ts'

export {
  readJsonFile,
  writeJsonFile,
  writeTextIfMissing,
  loadConfigJson,
  loadMcpJson,
  loadHooksJson,
  mergeConfigJson,
  mergeConfigs,
  stripJsonc,
  parseJsonc,
} from './io.ts'

export {
  loadWorkspace,
  resolveProviderFromConfig,
  type ResolvedWorkspace,
  type LoadWorkspaceOptions,
} from './loadWorkspace.ts'