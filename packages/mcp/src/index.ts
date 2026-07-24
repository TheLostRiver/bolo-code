/**
 * @bolo/mcp — MCP host：stdio JSON-RPC、tools/resources/prompts、mcp__* 命名
 * 无遥测；禁止 mock invoke 冒充完成
 */

export type { McpServerConfig, McpToolRegistration } from './types.ts'
export { mcpToolName, parseMcpToolName } from './names.ts'
export {
  loadMcpConfigFile,
  registerToolsFromServers,
  findMcpTool,
} from './config.ts'
export {
  McpStdioClient,
  extractMessages,
  formatMcpCallOutput,
  formatMcpResourceContents,
  formatMcpPromptResult,
  type McpToolDef,
  type McpCallResult,
  type McpServerCapabilities,
  type McpResourceDef,
  type McpResourceContents,
  type McpPromptDef,
  type McpGetPromptResult,
  type StdioClientOptions,
} from './stdioClient.ts'
export {
  connectMcpServers,
  closeMcpConnections,
  boloToolFromMcp,
  registrationFromListed,
  createMcpMetaTools,
  type ConnectedMcpServer,
  type ConnectMcpResult,
  type ConnectMcpOptions,
} from './host.ts'