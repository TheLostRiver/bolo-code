/** MCP host 骨架 — 工具名统一 mcp__server__tool */

export type McpServerConfig = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const i = rest.indexOf('__')
  if (i <= 0) return null
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}