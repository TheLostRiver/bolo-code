/**
 * @bolo/mcp — MCP host：stdio / Streamable HTTP / 经典 SSE、tools/resources/prompts、list_changed、mcp__* 命名
 * 无遥测；禁止 mock invoke 冒充完成
 */

export type {
  McpServerConfig,
  McpToolRegistration,
  McpTransportKind,
} from './types.ts'
export { resolveMcpTransport } from './types.ts'
export { mcpToolName, parseMcpToolName } from './names.ts'
export {
  loadMcpConfigFile,
  loadMcpConfigFileDetailed,
  registerToolsFromServers,
  findMcpTool,
  type LoadMcpConfigResult,
} from './config.ts'
export {
  validateMcpServerConfig,
  validateMcpServerConfigs,
  mcpConfigIssuesToWarnings,
  redactMcpHeaders,
  formatMcpServerConfigSummary,
  type McpConfigIssue,
} from './validate.ts'
export {
  mergeMcpServerLayers,
  mergeMcpServerLists,
  tagMcpServerScope,
  type McpServerLayer,
  type MergeMcpServerLayersResult,
} from './merge.ts'
export {
  expandEnvVarsInString,
  expandEnvVarsInRecord,
  expandMcpServerConfig,
  type ExpandEnvResult,
  type ExpandMcpServerConfigResult,
} from './envExpand.ts'
export type {
  McpClient,
  McpToolDef,
  McpCallResult,
  McpServerCapabilities,
  McpResourceDef,
  McpResourceContents,
  McpPromptDef,
  McpGetPromptResult,
  McpNotificationHandler,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from './client.ts'
export {
  formatMcpCallOutput,
  formatMcpResourceContents,
  formatMcpPromptResult,
  MCP_TOOLS_LIST_CHANGED,
  MCP_RESOURCES_LIST_CHANGED,
  MCP_PROMPTS_LIST_CHANGED,
  MCP_PROTOCOL_VERSION,
  MCP_DEFAULT_TIMEOUT_MS,
} from './client.ts'
export {
  McpStdioClient,
  extractMessages,
  type StdioClientOptions,
} from './stdioClient.ts'
export {
  McpHttpClient,
  parseSseDataPayloads,
  type HttpClientOptions,
} from './httpClient.ts'
export {
  McpSseClient,
  consumeSseEvents,
  resolveSseMessageUrl,
  type SseClientOptions,
} from './sseClient.ts'
export {
  connectMcpServers,
  closeMcpConnections,
  boloToolFromMcp,
  registrationFromListed,
  createMcpMetaTools,
  attachMcpListChangedHandlers,
  rebuildMcpBoloTools,
  mergeSessionToolsWithMcp,
  isMcpManagedToolName,
  coerceMcpPromptArguments,
  safeListMcpResources,
  safeListMcpPrompts,
  type ConnectedMcpServer,
  type ConnectMcpResult,
  type ConnectMcpOptions,
  type McpConnectFailure,
  type McpListChangedKind,
  type McpListChangedEvent,
} from './host.ts'