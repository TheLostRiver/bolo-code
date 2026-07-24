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
  renderWelcomeBanner,
  shouldUsePlainBanner,
  type BannerOptions,
} from './tui/banner.ts'
export {
  formatSessionStatusLine,
  type StatusLineSession,
} from './tui/statusLine.ts'
export {
  formatToolEventLine,
  formatSessionEventChunks,
  createSessionEventPrinter,
  type CliSessionEvent,
  type SessionEventPrinter,
} from './tui/formatSessionEvent.ts'
export {
  createTtyAskPermission,
  parsePermissionAnswer,
  formatPermissionPrompt,
  type AskPermissionFn,
  type AskPermissionRequest,
  type AskPermissionDecision,
} from './tui/askPermissionTty.ts'
export { createCliProvider, NO_KEY_MSG } from './provider.ts'