/**
 * @bolo/mcp — MCP host：stdio JSON-RPC、tools list/call、mcp__* 命名
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
  type McpToolDef,
  type McpCallResult,
  type StdioClientOptions,
} from './stdioClient.ts'
export {
  connectMcpServers,
  closeMcpConnections,
  boloToolFromMcp,
  registrationFromListed,
  type ConnectedMcpServer,
  type ConnectMcpResult,
  type ConnectMcpOptions,
} from './host.ts'