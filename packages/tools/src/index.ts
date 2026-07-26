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
  createExitPlanModeTool,
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_MODE_EXIT_TARGET,
  type PlanModeStoreRef,
} from './exitPlanMode.ts'

export {
  createAskUserQuestionTool,
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionAskerRef,
  type AskUserQuestionOutcome,
} from './askUserQuestion.ts'

export {
  createTodoWriteTool,
  TODO_WRITE_TOOL_NAME,
  type TodoStoreRef,
} from './todoWrite.ts'

export {
  createBashOutputTool,
  createKillShellTool,
  BASH_OUTPUT_TOOL_NAME,
  KILL_SHELL_TOOL_NAME,
} from './backgroundShellTools.ts'

export {
  spawnBackgroundShell,
  killBackgroundShell,
  killAllBackgroundShells,
  readBackgroundShellOutput,
  cleanupShellOutputDir,
  resolveShellOutputDir,
  isProcessAlive,
  _getShellOutputStreamForTest,
  MAX_SHELL_OUTPUT_READ_BYTES,
  type SpawnBackgroundShellOptions,
  type SpawnBackgroundShellResult,
  type KillBackgroundShellResult,
  type ReadShellOutputResult,
} from './backgroundShellRuntime.ts'

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
  resolveDiffRenderTheme,
  shouldSyntaxHighlight,
  shouldShowLineGutter,
  lineNumberWidth,
  expandHunksToBodyLines,
  highlightCodeLine,
  renderDiffBodyLines,
  renderHunksRich,
  colorizeUnifiedTextRich,
  type DiffRenderTheme,
  type DiffRenderThemeId,
  type DiffBodyLine,
  type DiffBodyLineKind,
} from './diffRender.ts'

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