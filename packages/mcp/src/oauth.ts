/**
 * F-MCP-OAUTH 最小：headers 注入与 token 文件读取（无浏览器自动化、无遥测）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export type McpOAuthTokenFile = {
  access_token: string
  token_type?: string
  expires_at?: number
}

/**
 * 从 JSON 文件读 access_token（用户自行完成 OAuth 后落盘）。
 * 路径：绝对或相对 cwd。
 */
export async function loadMcpOAuthTokenFile(
  filePath: string,
): Promise<McpOAuthTokenFile | null> {
  try {
    const raw = await fs.readFile(path.resolve(filePath), 'utf8')
    const o = JSON.parse(raw) as Record<string, unknown>
    const token =
      typeof o.access_token === 'string'
        ? o.access_token
        : typeof o.accessToken === 'string'
          ? o.accessToken
          : ''
    if (!token.trim()) return null
    return {
      access_token: token.trim(),
      token_type:
        typeof o.token_type === 'string' ? o.token_type : 'Bearer',
      expires_at:
        typeof o.expires_at === 'number'
          ? o.expires_at
          : typeof o.expiresAt === 'number'
            ? o.expiresAt
            : undefined,
    }
  } catch {
    return null
  }
}

export function isMcpOAuthTokenExpired(
  token: McpOAuthTokenFile,
  now = Date.now(),
): boolean {
  if (token.expires_at == null) return false
  return now >= token.expires_at
}

/**
 * 合并 Authorization header；已有 Authorization 不覆盖。
 */
export function applyBearerAuthHeaders(
  headers: Record<string, string> | undefined,
  accessToken: string,
  tokenType = 'Bearer',
): Record<string, string> {
  const h = { ...(headers ?? {}) }
  const has = Object.keys(h).some((k) => k.toLowerCase() === 'authorization')
  if (!has && accessToken) {
    h.Authorization = `${tokenType} ${accessToken}`
  }
  return h
}

/**
 * 环境 BOLO_MCP_OAUTH_TOKEN_FILE 指向 token JSON 时注入 headers。
 */
export async function maybeInjectMcpOAuthHeaders(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  headers: Record<string, string> | undefined
  injected: boolean
  warning?: string
}> {
  const file = env.BOLO_MCP_OAUTH_TOKEN_FILE?.trim()
  if (!file) return { headers, injected: false }
  const tok = await loadMcpOAuthTokenFile(file)
  if (!tok) {
    return {
      headers,
      injected: false,
      warning: `mcp oauth token file unreadable: ${file}`,
    }
  }
  if (isMcpOAuthTokenExpired(tok)) {
    return {
      headers,
      injected: false,
      warning: `mcp oauth token expired: ${file}`,
    }
  }
  return {
    headers: applyBearerAuthHeaders(
      headers,
      tok.access_token,
      tok.token_type ?? 'Bearer',
    ),
    injected: true,
  }
}