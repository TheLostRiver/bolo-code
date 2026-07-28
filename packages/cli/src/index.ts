/**
 * @bolo/cli 公共导出（测试与程序化调用）
 */
export {
  parseArgs,
  formatHelp,
  isResumePicker,
  type CliArgs,
} from './parseArgs.ts'
export {
  resumeFromIdOrPath,
  runResumeCli,
  runOnePrompt,
  runRepl,
  pickProjectSessionId,
  resolveContinueSessionId,
  formatSessionList,
  filterSessionListItems,
  resolveSessionPickerChoice,
  buildSessionSummary,
  formatSessionSummary,
  lastAssistantText,
  createCliOnEvent,
  attachSessionEventPrinter,
  getSessionEventPrinter,
  ResumePickerError,
  type ResumeCliOptions,
  type ResumeCliResult,
  type SessionSummary,
} from './resumeCli.ts'
export { runNewSessionCli, type NewSessionCliOptions } from './newSessionCli.ts'
export {
  CLI_LOCAL_SLASH_COMMANDS,
  getCliSlashCommandCandidates,
} from './slashCandidates.ts'
export {
  runInitCli,
  type InitCliOptions,
  type InitCliResult,
} from './initCli.ts'
export {
  renderWelcomeBanner,
  shouldUsePlainBanner,
  isNarrowTerminal,
  getTerminalColumns,
  NARROW_TERMINAL_COLUMNS,
  type BannerOptions,
} from './tui/banner.ts'
export {
  formatSessionStatusLine,
  type StatusLineSession,
  type StatusLineOptions,
} from './tui/statusLine.ts'
export {
  renderInkLayout,
  type InkLayoutOptions,
} from './tui/inkLayout.ts'
export {
  BOLO_CRYSTAL_ASCII_COMPACT_LINES,
  BOLO_CRYSTAL_ASCII_LINES,
  BOLO_CRYSTAL_COMPACT_LINES,
  BOLO_CRYSTAL_MEDIUM_LINES,
  BOLO_CRYSTAL_UNICODE_LINES,
  centerTuiArt,
  normalizeTuiArt,
  shouldUseAsciiCrystal,
} from './tui/crystalLogo.ts'
export {
  resolveTuiDockWidth,
  resolveTuiFrameWidth,
  TUI_FRAME_MAX_COLUMNS,
} from './tui/frame.ts'
export {
  createTerminalSurface,
  type TerminalDock,
  type TerminalSurface,
} from './tui/terminalSurface.ts'
export {
  resolveTuiTheme,
  type TuiTheme,
  type TuiThemeId,
} from './tui/theme.ts'
export {
  applyArrowPickerKey,
  formatArrowPickerScreen,
  runArrowPicker,
  type ArrowPickItem,
} from './tui/arrowPicker.ts'
export {
  runDiffPane,
  runDiffApprovePane,
  type DiffPaneResult,
  type DiffPaneBrowseResult,
  type DiffPaneApproveResult,
} from './tui/diffPane.ts'
export {
  formatToolEventLine,
  formatSessionEventChunks,
  createSessionEventPrinter,
  type CliSessionEvent,
  type SessionEventPrinter,
} from './tui/formatSessionEvent.ts'
export {
  measureTerminalText,
  clipTerminalText,
  padTerminalText,
  wrapTerminalText,
  stripTerminalAnsi,
  splitTerminalGraphemes,
  terminalGraphemeWidth,
} from './tui/terminalText.ts'
export {
  applyTuiInputKey,
  canUseTuiInput,
  createTuiInputState,
  formatTuiTokenCount,
  readTuiInput,
  renderTuiInputBox,
  renderUserMessage,
  shouldUseDynamicTui,
  type ApplyTuiInputKeyResult,
  type ReadTuiInputResult,
  type RenderedTuiInputBox,
  type TuiInputAction,
  type TuiInputKey,
  type TuiInputState,
  type TuiInputStatus,
  type TuiInputUsage,
  type TuiSlashMenuState,
} from './tui/inputBox.ts'
export {
  createTurnActivityIndicator,
  formatTurnActivityLine,
  type TurnActivityEvent,
  type TurnActivityIndicator,
} from './tui/turnActivity.ts'
export {
  renderContextDashboard,
  type RenderedContextDashboard,
} from './tui/contextDashboard.ts'
export {
  createTtyAskPermission,
  parsePermissionAnswer,
  formatPermissionPrompt,
  type AskPermissionFn,
  type AskPermissionRequest,
  type AskPermissionDecision,
} from './tui/askPermissionTty.ts'
export {
  applyPermissionPanelKey,
  formatPermissionPanelScreen,
  runPermissionPanel,
  type PermissionPanelKeyResult,
} from './tui/permissionPanel.ts'
export { createCliProvider, NO_KEY_MSG } from './provider.ts'
