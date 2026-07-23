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
  DEFAULT_MCP_FILE,
  DEFAULT_HOOKS_FILE,
  type BoloConfigJson,
  type ProviderConfigJson,
  type McpFileJson,
  type HooksFileJson,
} from './types.ts'

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
  loadConfigJson,
  loadMcpJson,
  loadHooksJson,
  mergeConfigJson,
  mergeConfigs,
} from './io.ts'

export {
  loadWorkspace,
  resolveProviderFromConfig,
  type ResolvedWorkspace,
  type LoadWorkspaceOptions,
} from './loadWorkspace.ts'