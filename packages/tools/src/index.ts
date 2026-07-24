/**
 * @bolo/tools — 对照 HelsincyCode Tool + tools/*
 */

export {
  buildTool,
  findToolByName,
  validateAgainstJsonSchema,
  formatToolUseError,
  type BoloTool,
  type ToolDef,
  type ToolResult,
  type ToolContext,
  type ToolCallResult,
  type JsonSchema,
} from './types.ts'

export {
  createBuiltinTools,
  createBashTool,
  createReadTool,
  createWriteTool,
  createApplyPatchTool,
  createGlobTool,
  createGrepTool,
  createSkillTool,
  executeTool,
  listToolNames,
  getToolSpec,
  getBuiltinToolSpecs,
  BUILTIN_TOOLS,
  type ToolSpec,
  type LegacyToolContext as ToolContextLegacy,
} from './builtins.ts'

export {
  applyPatchToCwd,
  parseApplyPatch,
  resolveSafe,
  type ApplyPatchResult,
  type PatchOp,
  type PatchHunk,
} from './applyPatch.ts'

export {
  toolsToOpenAI,
  toolsToAnthropic,
  type ToolLike,
} from './providerSchema.ts'

export type { ToolContext as BuiltinToolContext } from './types.ts'