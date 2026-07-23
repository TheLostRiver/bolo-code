/**
 * MCP host — 工具名统一 mcp__server__tool
 * v1：从配置注册工具表；stdio 真协议后置，提供 mock 注册与 invoke 占位
 */

import { promises as fs } from 'node:fs'

export type McpServerConfig = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 声明式工具列表（无真连接时用于注册） */
  tools?: { name: string; description?: string }[]
}

export type McpToolRegistration = {
  name: string
  server: string
  tool: string
  description: string
  requiresPermission: boolean
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

export function parseMcpToolName(
  name: string,
): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const i = rest.indexOf('__')
  if (i <= 0) return null
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

export async function loadMcpConfigFile(filePath: string): Promise<McpServerConfig[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const json = JSON.parse(raw) as {
      mcpServers?: Record<string, Omit<McpServerConfig, 'name'>>
      servers?: McpServerConfig[]
    }
    if (Array.isArray(json.servers)) return json.servers
    if (json.mcpServers) {
      return Object.entries(json.mcpServers).map(([name, cfg]) => ({
        name,
        ...cfg,
      }))
    }
    return []
  } catch {
    return []
  }
}

export function registerToolsFromServers(
  servers: McpServerConfig[],
): McpToolRegistration[] {
  const out: McpToolRegistration[] = []
  for (const s of servers) {
    for (const t of s.tools ?? []) {
      out.push({
        name: mcpToolName(s.name, t.name),
        server: s.name,
        tool: t.name,
        description: t.description ?? `MCP ${s.name}/${t.name}`,
        requiresPermission: true,
      })
    }
  }
  return out
}

/**
 * v1 invoke：无真 MCP 连接时返回结构化占位结果
 * 后续替换为 JSON-RPC tools/call
 */
export async function invokeMcpTool(
  reg: McpToolRegistration,
  input: unknown,
): Promise<{ ok: boolean; output: string }> {
  return {
    ok: true,
    output: JSON.stringify({
      mock: true,
      server: reg.server,
      tool: reg.tool,
      input,
      note: 'stdio MCP client not wired yet; registration path verified',
    }),
  }
}

export function findMcpTool(
  regs: McpToolRegistration[],
  name: string,
): McpToolRegistration | undefined {
  return regs.find((r) => r.name === name)
}