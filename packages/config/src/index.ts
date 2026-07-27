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
  resolveSearxngSearchConfig,
  resolveSearxngSearchConfigFromSearch,
  type SearchConfigJson,
  type SearxngSearchConfigJson,
  type ResolvedSearxngSearchConfig,
  type ResolveSearxngSearchConfigResult,
} from './searxng.ts'

export {
  DEFAULT_SEARXNG_SETUP_PORT,
  SEARXNG_COMPOSE_PROJECT,
  SEARXNG_DOCKER_IMAGE,
  SEARXNG_SETUP_VERSION,
  commitSearxngSearchConfig,
  createSearxngSetupPlan,
  getSearxngSetupPaths,
  patchSearxngConfigJsonc,
  type CommitSearxngSearchConfigResult,
  type CreateSearxngSetupPlanInput,
  type SearxngSetupPaths,
  type SearxngSetupPlan,
} from './searxngSetup.ts'

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
  BUILTIN_PROVIDER_PRESETS,
  listProviderPresets,
  getProviderPreset,
  providerConfigFromPreset,
  formatProviderPresetLine,
  formatProviderPresetsHelp,
  type ProviderPreset,
} from './providerPresets.ts'

export {
  addProviderProfileToConfigFile,
  type AddProviderProfileResult,
  type AddProviderProfileOptions,
} from './addProviderProfile.ts'

export {
  ensureLayout,
  ensureUserLayout,
  ensureProjectLayout,
  ensureAllLayouts,
  type EnsureLayoutResult,
} from './ensure.ts'

export {
  readJsonFile,
  readJsonFileResult,
  loadConfigJsonWithWarnings,
  type ReadJsonResult,
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

export {
  BUILTIN_SEARCH_PRESETS,
  describeSearchPresetPrivacy,
  describeWebSearchStatus,
  enableSearchPresetInMcpFile,
  getSearchPreset,
  listSearchPresets,
  type EnableSearchPresetResult,
  type SearchPreset,
  type SearchPresetAuth,
  type SearchPresetPrivacy,
  type WebSearchStatus,
  type WebSearchStatusInput,
} from './searchPresets.ts'
