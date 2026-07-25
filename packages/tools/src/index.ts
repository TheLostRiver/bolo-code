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
  type ToolInterruptBehavior,
  type JsonSchema,
} from './types.ts'

export {
  createBuiltinTools,
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createApplyPatchTool,
  createGlobTool,
  createGrepTool,
  createSkillTool,
  createWebFetchTool,
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
  applyHunksToText,
  type ApplyPatchResult,
  type ApplyPatchFileMeta,
  type PatchOp,
  type PatchHunk,
} from './applyPatch.ts'

export {
  countHunkLines,
  diffHunksFromEdit,
  diffHunksFromFullReplace,
  formatUnifiedDiff,
  formatEditToolOutput,
  formatWriteToolOutput,
  type DiffHunk,
  type LineCounts,
} from './textDiff.ts'

export {
  previewFileToolChange,
  toPermissionPreviewPayload,
  type FileChangePreview,
  type FileChangePreviewFile,
  type PermissionPreviewPayload,
} from './fileChangePreview.ts'

export {
  colorizeUnifiedText,
  formatAnsiUnifiedFromHunks,
  formatFileChangeEndLine,
  formatCountsAnsi,
  formatCountsPlain,
  createDiffSummary,
  shouldShowVerboseDiff,
  shouldShowCompactDiffOnly,
  inlineDiffMaxLines,
  type DiffSummaryRow,
} from './ansiDiff.ts'

export {
  fetchSingleFileGitDiff,
  findGitRoot,
  formatGitFileDiffSlash,
  formatGitStatusSlash,
  listGitStatus,
  type GitFileDiff,
  type GitStatusEntry,
} from './gitDiff.ts'

export {
  toolsToOpenAI,
  toolsToAnthropic,
  type ToolLike,
} from './providerSchema.ts'

export type { ToolContext as BuiltinToolContext } from './types.ts'