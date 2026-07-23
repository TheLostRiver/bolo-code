/**
 * 读取 mcp.json → McpServerConfig[]
 */

import { promises as fs } from 'node:fs'
import type { McpServerConfig } from './types.ts'

export async function loadMcpConfigFile(
  filePath: string,
): Promise<McpServerConfig[]> {
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

/** @deprecated 声明式注册；真连接请用 connectMcpServers */
export function registerToolsFromServers(
  servers: McpServerConfig[],
): import('./types.ts').McpToolRegistration[] {
  const out: import('./types.ts').McpToolRegistration[] = []
  for (const s of servers) {
    for (const t of s.tools ?? []) {
      out.push({
        name: `mcp__${s.name}__${t.name}`,
        server: s.name,
        tool: t.name,
        description: t.description ?? `MCP ${s.name}/${t.name}`,
        requiresPermission: true,
      })
    }
  }
  return out
}

export function findMcpTool<T extends { name: string }>(
  regs: T[],
  name: string,
): T | undefined {
  return regs.find((r) => r.name === name)
}