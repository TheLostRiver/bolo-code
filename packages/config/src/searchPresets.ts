/**
 * Web search preset：给 `openai-compatible` 那条腿用。
 *
 * Chat Completions 协议上没有 hosted 搜索的位置，但用户把这条线路视为一等公民。
 * Bolo 已经有完整的 MCP client（stdio / http / sse + `${ENV}` 展开），
 * 所以这条腿**不写新的 HTTP 搜索客户端**——搜索作为一个 MCP server 交付，
 * preset 只负责把一行配置写进 mcp.json。
 *
 * 顺带的好处：MCP 搜索结果是 tool-result，会经过 `truncateMiddle` 与
 * per-tool 预算。两条 hosted 线路的结果在 provider 侧就进了上下文，
 * 本地截断管不着——这条腿反而是唯一被本地预算治理的。
 *
 * **密钥永不落盘**：只写 `${ENV_VAR}` 引用，由 MCP 的 envExpand 在连接时展开。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export type SearchPresetAuth = 'none' | 'header'

export type SearchPreset = {
  id: string
  /** 写进 mcp.json 的 server 名 */
  serverName: string
  url: string
  /**
   * 鉴权方式。**只有** none / header——本仓库的 MCP client 没有 OAuth，
   * 承诺一个做不到的模式等于给用户挖坑。
   */
  auth: SearchPresetAuth
  /** 需要的环境变量名；缺省表示无需 key */
  requiresKeyEnv?: string
  /** 写进配置的 headers（值只能是 `${ENV}` 引用，不能是真值） */
  headers?: Record<string, string>
  label: string
  notes?: string
}

export const BUILTIN_SEARCH_PRESETS: readonly SearchPreset[] = [
  {
    id: 'exa',
    serverName: 'exa-search',
    url: 'https://mcp.exa.ai/mcp',
    auth: 'none',
    label: 'Exa (no key; rate limited by IP)',
    notes:
      'Queries leave your machine and go to Exa. Free tier is IP rate limited.',
  },
  {
    id: 'exa-key',
    serverName: 'exa-search',
    url: 'https://mcp.exa.ai/mcp',
    auth: 'header',
    requiresKeyEnv: 'EXA_API_KEY',
    headers: { 'x-api-key': '${EXA_API_KEY}' },
    label: 'Exa (with API key; higher limits)',
    notes: 'Set EXA_API_KEY in your environment. The key is never written to disk.',
  },
  {
    id: 'searxng',
    serverName: 'searxng-search',
    // 自托管：用户改成自己的实例地址
    url: 'http://127.0.0.1:8080/mcp',
    auth: 'none',
    label: 'SearXNG (self-hosted; edit the url to your instance)',
    notes:
      'Nothing leaves your network if you run SearXNG yourself. Point url at your instance.',
  },
]

export function listSearchPresets(): SearchPreset[] {
  return [...BUILTIN_SEARCH_PRESETS]
}

export function getSearchPreset(id: string): SearchPreset | undefined {
  const key = id.trim().toLowerCase()
  return BUILTIN_SEARCH_PRESETS.find((p) => p.id.toLowerCase() === key)
}

export type EnableSearchPresetResult =
  | { ok: true; serverName: string; alreadyPresent: boolean }
  | { ok: false; error: string }

/**
 * 把 preset 写进 mcp.json。
 * 幂等；保留用户已有的 mcpServers；只写 `${ENV}` 引用。
 */
export async function enableSearchPresetInMcpFile(
  mcpJsonPath: string,
  presetId: string,
): Promise<EnableSearchPresetResult> {
  const preset = getSearchPreset(presetId)
  if (!preset) {
    return {
      ok: false,
      error: `unknown search preset "${presetId}"; try: ${BUILTIN_SEARCH_PRESETS.map((p) => p.id).join(', ')}`,
    }
  }

  let existing: { mcpServers?: Record<string, unknown> } = {}
  try {
    const raw = await fs.readFile(mcpJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    if (parsed && typeof parsed === 'object') existing = parsed
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      // 文件在但读不了：绝不覆盖，否则会吞掉用户的其它 MCP 配置
      return {
        ok: false,
        error: `${mcpJsonPath} exists but could not be parsed (${
          err instanceof Error ? err.message : String(err)
        }); refusing to overwrite it`,
      }
    }
  }

  const servers = { ...(existing.mcpServers ?? {}) }
  const alreadyPresent = servers[preset.serverName] !== undefined

  servers[preset.serverName] = {
    type: 'http',
    url: preset.url,
    ...(preset.headers ? { headers: { ...preset.headers } } : {}),
  }

  const next = { ...existing, mcpServers: servers }
  await fs.mkdir(path.dirname(mcpJsonPath), { recursive: true })
  await fs.writeFile(mcpJsonPath, JSON.stringify(next, null, 2) + '\n', 'utf8')

  return { ok: true, serverName: preset.serverName, alreadyPresent }
}

export type WebSearchStatusInput = {
  /** webSearchDialect 解出的方言 id */
  dialectId: string
  /** 用户是否已配置提供搜索的 MCP server */
  hasSearchMcpServer: boolean
}

export type WebSearchStatus = {
  configured: boolean
  summary: string
}

/**
 * 面向用户的状态描述。
 *
 * 措辞是本函数的重点：没有搜索能力**不是故障**。写成
 * "unavailable" / "unsupported" 会让人以为坏了、跑去排查；
 * 正确的呈现是「还没开 + 一步就能开」。
 */
export function describeWebSearchStatus(
  input: WebSearchStatusInput,
): WebSearchStatus {
  if (input.dialectId === 'anthropic-hosted') {
    return {
      configured: true,
      summary: 'web search: on (runs server-side at your provider)',
    }
  }
  if (input.dialectId === 'openai-responses-hosted') {
    return {
      configured: true,
      summary: 'web search: on (hosted by your provider)',
    }
  }
  if (input.hasSearchMcpServer) {
    return {
      configured: true,
      summary: 'web search: on (via a configured MCP server)',
    }
  }
  if (input.dialectId === 'openrouter-plugin') {
    return {
      configured: false,
      summary:
        'web search: off — this endpoint can do it, but it bills per request; enable with /websearch on',
    }
  }
  return {
    configured: false,
    summary: `web search: not set up yet — run 'bolo search enable exa' to add one (${
      BUILTIN_SEARCH_PRESETS.map((p) => p.id).join(' | ')
    })`,
  }
}
