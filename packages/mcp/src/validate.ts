/**
 * MCP 配置校验（M-GEN-1）
 * 对照 HC mcp config 加载失败可观测、坏项跳过的语义；无遥测。
 */

import type { McpServerConfig, McpTransportKind } from './types.ts'
import { resolveMcpTransport } from './types.ts'

export type McpConfigIssue = {
  /** 缺 name 时可能为空 */
  server?: string
  level: 'error' | 'warning'
  message: string
}

function hasText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 校验单个 server 配置。error = 不可连接；warning = 可连但可疑。
 */
export function validateMcpServerConfig(cfg: McpServerConfig): McpConfigIssue[] {
  const issues: McpConfigIssue[] = []
  const name = hasText(cfg.name) ? cfg.name.trim() : ''
  const tag = name || '(unnamed)'

  if (!name) {
    issues.push({
      level: 'error',
      message: 'MCP server entry missing non-empty "name"',
    })
  }

  const rawType = cfg.type
  if (
    rawType !== undefined &&
    rawType !== 'stdio' &&
    rawType !== 'http' &&
    rawType !== 'sse'
  ) {
    issues.push({
      server: name || undefined,
      level: 'error',
      message: `MCP server "${tag}": invalid type "${String(rawType)}" (use stdio | http | sse)`,
    })
    return issues
  }

  const hasCommand = hasText(cfg.command)
  const hasUrl = hasText(cfg.url)
  const transport = resolveMcpTransport(cfg)

  if (!transport) {
    issues.push({
      server: name || undefined,
      level: 'error',
      message: `MCP server "${tag}": need "command" (stdio) or "url" (http/sse)`,
    })
    return issues
  }

  if (rawType === 'stdio' && !hasCommand) {
    issues.push({
      server: name || undefined,
      level: 'error',
      message: `MCP server "${tag}": type is stdio but "command" is missing`,
    })
  }
  if ((rawType === 'http' || rawType === 'sse') && !hasUrl) {
    issues.push({
      server: name || undefined,
      level: 'error',
      message: `MCP server "${tag}": type is ${rawType} but "url" is missing`,
    })
  }
  if (rawType === 'stdio' && hasUrl && !hasCommand) {
    // already error above; skip
  } else if (rawType === 'stdio' && hasUrl) {
    issues.push({
      server: name || undefined,
      level: 'warning',
      message: `MCP server "${tag}": type is stdio; "url" is ignored`,
    })
  }
  if ((rawType === 'http' || rawType === 'sse') && hasCommand) {
    issues.push({
      server: name || undefined,
      level: 'warning',
      message: `MCP server "${tag}": type is ${rawType}; "command"/"args" are ignored`,
    })
  }
  if (!rawType && hasCommand && hasUrl) {
    issues.push({
      server: name || undefined,
      level: 'warning',
      message: `MCP server "${tag}": both command and url set without type — inferred as http (url wins). Set "type": "stdio" | "http" | "sse" explicitly`,
    })
  }

  if (
    (cfg.reconnectAttempts !== undefined ||
      cfg.reconnectDelayMs !== undefined) &&
    transport !== 'sse'
  ) {
    issues.push({
      server: name || undefined,
      level: 'warning',
      message: `MCP server "${tag}": reconnectAttempts/reconnectDelayMs only apply to type sse`,
    })
  }

  if (cfg.reconnectAttempts !== undefined) {
    const n = Number(cfg.reconnectAttempts)
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      issues.push({
        server: name || undefined,
        level: 'warning',
        message: `MCP server "${tag}": reconnectAttempts should be 0–10 (got ${String(cfg.reconnectAttempts)})`,
      })
    }
  }

  return issues
}

/**
 * 批量校验；errors 级表示不可连接。
 */
export function validateMcpServerConfigs(
  servers: readonly McpServerConfig[],
): McpConfigIssue[] {
  const out: McpConfigIssue[] = []
  const seen = new Set<string>()
  for (const cfg of servers) {
    out.push(...validateMcpServerConfig(cfg))
    const n = cfg.name?.trim()
    if (n) {
      if (seen.has(n)) {
        out.push({
          server: n,
          level: 'warning',
          message: `duplicate MCP server name "${n}" (later entry may overwrite in maps)`,
        })
      }
      seen.add(n)
    }
  }
  return out
}

export function mcpConfigIssuesToWarnings(
  issues: readonly McpConfigIssue[],
): string[] {
  return issues.map((i) => i.message)
}

/**
 * M-GEN-3：日志/诊断用请求头脱敏（不改原对象）。
 */
export function redactMcpHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase()
    if (
      key === 'authorization' ||
      key === 'proxy-authorization' ||
      key.includes('api-key') ||
      key.includes('apikey') ||
      key.includes('secret') ||
      key.includes('token') ||
      key.includes('password')
    ) {
      const s = String(v ?? '')
      out[k] = s.length <= 8 ? '***' : `${s.slice(0, 4)}…***`
    } else {
      out[k] = v
    }
  }
  return out
}

/** 连接摘要一行（无完整密钥） */
export function formatMcpServerConfigSummary(cfg: McpServerConfig): string {
  const transport = resolveMcpTransport(cfg) ?? 'unknown'
  const name = cfg.name?.trim() || '?'
  if (transport === 'stdio') {
    const args = (cfg.args ?? []).join(' ')
    return `${name} [stdio] ${cfg.command ?? '?'}${args ? ' ' + args : ''}`
  }
  if (transport === 'http' || transport === 'sse') {
    const hdrs = redactMcpHeaders(cfg.headers)
    const h =
      hdrs && Object.keys(hdrs).length
        ? ` headers={${Object.entries(hdrs)
            .map(([k, v]) => `${k}:${v}`)
            .join(',')}}`
        : ''
    return `${name} [${transport}] ${cfg.url ?? '?'}${h}`
  }
  return `${name} [invalid]`
}

export type { McpTransportKind }