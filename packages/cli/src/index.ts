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
} from './tui/inputBox.ts'
export {
  createTurnActivityIndicator,
  formatTurnActivityLine,
  type TurnActivityEvent,
  type TurnActivityIndicator,
} from './tui/turnActivity.ts'
export {
  createTtyAskPermission,
  parsePermissionAnswer,
  formatPermissionPrompt,
  type AskPermissionFn,
  type AskPermissionRequest,
  type AskPermissionDecision,
} from './tui/askPermissionTty.ts'
export { createCliProvider, NO_KEY_MSG } from './provider.ts'
