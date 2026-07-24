/**
 * 读取 mcp.json → McpServerConfig[]
 * M-GEN-1：坏 JSON / 无效项产生 warnings，不拖垮加载。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from './types.ts'
import {
  mcpConfigIssuesToWarnings,
  validateMcpServerConfig,
  type McpConfigIssue,
} from './validate.ts'

export type LoadMcpConfigResult = {
  servers: McpServerConfig[]
  warnings: string[]
  issues: McpConfigIssue[]
}

function labelPath(filePath: string): string {
  // 诊断用短标签，避免长绝对路径刷屏
  return path.basename(filePath) || filePath
}

/**
 * 解析 mcp.json 并校验各 server；error 级条目**不**进入 servers。
 */
export async function loadMcpConfigFileDetailed(
  filePath: string,
): Promise<LoadMcpConfigResult> {
  const warnings: string[] = []
  const issues: McpConfigIssue[] = []
  const label = labelPath(filePath)

  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return { servers: [], warnings: [], issues: [] }
    }
    const msg = e instanceof Error ? e.message : String(e)
    warnings.push(`MCP config "${label}": read failed: ${msg}`)
    return { servers: [], warnings, issues }
  }

  let json: {
    mcpServers?: Record<string, Omit<McpServerConfig, 'name'>>
    servers?: McpServerConfig[]
  }
  try {
    json = JSON.parse(raw) as typeof json
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    warnings.push(`MCP config "${label}": invalid JSON: ${msg}`)
    return { servers: [], warnings, issues }
  }

  let candidates: McpServerConfig[] = []
  if (Array.isArray(json.servers)) {
    candidates = json.servers.map((s) => ({ ...s }))
  } else if (json.mcpServers && typeof json.mcpServers === 'object') {
    candidates = Object.entries(json.mcpServers).map(([name, cfg]) => ({
      name,
      ...cfg,
    }))
  } else if (raw.trim() && raw.trim() !== '{}') {
    warnings.push(
      `MCP config "${label}": no "mcpServers" object or "servers" array; ignoring`,
    )
  }

  const servers: McpServerConfig[] = []
  for (const cfg of candidates) {
    const itemIssues = validateMcpServerConfig(cfg)
    issues.push(...itemIssues)
    const errors = itemIssues.filter((i) => i.level === 'error')
    if (errors.length) {
      warnings.push(...mcpConfigIssuesToWarnings(errors))
      // 仍把 warnings 级附上
      warnings.push(
        ...mcpConfigIssuesToWarnings(
          itemIssues.filter((i) => i.level === 'warning'),
        ),
      )
      continue
    }
    warnings.push(
      ...mcpConfigIssuesToWarnings(
        itemIssues.filter((i) => i.level === 'warning'),
      ),
    )
    servers.push(cfg)
  }

  return { servers, warnings, issues }
}

/** 仅 servers（兼容旧调用）；丢弃 warnings */
export async function loadMcpConfigFile(
  filePath: string,
): Promise<McpServerConfig[]> {
  const r = await loadMcpConfigFileDetailed(filePath)
  return r.servers
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