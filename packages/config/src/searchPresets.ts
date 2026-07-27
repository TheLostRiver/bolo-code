/**
 * Web search preset：给 `openai-compatible` 那条腿用。
 *
 * Chat Completions 协议上没有 hosted 搜索的位置，但用户把这条线路视为一等公民。
 * Bolo 已经有完整的 MCP client（stdio / http / sse + `${ENV}` 展开），
 * 所以第三方通用搜索服务继续作为 MCP server 交付，preset 只负责把一行配置
 * 写进 mcp.json。SearXNG 是例外：它有稳定 JSON API，Bolo 直接连接用户显式
 * 配置的实例，不再为一个不存在的 `/mcp` 桥写占位 preset。
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

/**
 * 查询实际去哪 —— **机器可读**，不是散文。
 *
 * 之所以要有这个字段：这里曾经出过一条假承诺。searxng 的 notes 写着
 * "Nothing leaves your network if you run SearXNG yourself"，而事实是
 * SearXNG 自己没有索引，它是元搜索代理，自托管后查询字符串仍会由你的服务器
 * 转发给上游引擎。散文没人守得住，字段可以被测试守住。
 *
 * - `vendor`：查询发给该服务商（如 Exa）
 * - `upstream-engines`：自托管聚合器，但查询仍到达 Google/Bing 等上游引擎；
 *   自托管隐藏的是**你的 IP 与 cookie，不是查询内容**
 * - `local-only`：查询不出你自己掌控的范围（需自有索引，如 YaCy intranet）
 */
export type SearchPresetPrivacy = 'vendor' | 'upstream-engines' | 'local-only'

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
  /** 查询去哪。必填——不允许新增一个不说清去向的后端。 */
  privacy: SearchPresetPrivacy
  /** 需要的环境变量名；缺省表示无需 key */
  requiresKeyEnv?: string
  /** 写进配置的 headers（值只能是 `${ENV}` 引用，不能是真值） */
  headers?: Record<string, string>
  /**
   * 只注册这些工具。
   *
   * 活体实测发现的问题：Exa 的 MCP server 一次列出搜索**和远程抓取**两个工具，
   * 模型转头就用远程抓取替代了 Bolo 本地的 WebFetch —— 用户敲的是
   * `search enable`，却连抓取也一并出了机器。他没要求这个。
   * 想要那个工具的人可以自己往 mcp.json 里加。
   */
  allowTools?: string[]
  label: string
  notes?: string
}

export const BUILTIN_SEARCH_PRESETS: readonly SearchPreset[] = [
  {
    id: 'exa',
    serverName: 'exa-search',
    url: 'https://mcp.exa.ai/mcp',
    auth: 'none',
    privacy: 'vendor',
    // 只要搜索。Exa 还会列出一个远程抓取工具，那个工具会把「你在读哪个 URL」
    // 也告诉 Exa，且会顶掉 Bolo 本地的 WebFetch——不是 `search enable` 该带来的东西。
    allowTools: ['web_search_exa'],
    label: 'Exa (no key; rate limited by IP)',
    notes:
      'Queries go to Exa. Their privacy policy says query data trains and fine-tunes their models. Free tier is IP rate limited. Registers the search tool only.',
  },
  {
    id: 'exa-key',
    serverName: 'exa-search',
    url: 'https://mcp.exa.ai/mcp',
    auth: 'header',
    privacy: 'vendor',
    requiresKeyEnv: 'EXA_API_KEY',
    headers: { 'x-api-key': '${EXA_API_KEY}' },
    allowTools: ['web_search_exa'],
    label: 'Exa (with API key; higher limits)',
    notes:
      'Queries go to Exa; same policy as the keyless tier. Set EXA_API_KEY in your environment — the key is never written to disk.',
  },
]

/** 面向用户的一行「查询去哪」——list / enable 共用，避免两处措辞漂移 */
export function describeSearchPresetPrivacy(p: SearchPreset): string {
  switch (p.privacy) {
    case 'vendor':
      return 'queries leave your machine and go to this vendor'
    case 'upstream-engines':
      return 'queries leave your network and reach upstream engines (self-hosting hides your IP, not the query)'
    case 'local-only':
      return 'queries stay within infrastructure you control'
  }
}

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
    ...(preset.allowTools?.length
      ? { allowTools: [...preset.allowTools] }
      : {}),
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
  /** 用户是否显式配置了 SearXNG JSON 直连工具 */
  hasSearxngSearchTool?: boolean
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
  const activeLanes: string[] = []
  if (input.dialectId === 'anthropic-hosted') {
    activeLanes.push('runs server-side at your provider')
  }
  if (input.dialectId === 'openai-responses-hosted') {
    activeLanes.push('hosted by your provider')
  }
  if (input.hasSearxngSearchTool) {
    activeLanes.push('direct JSON via configured SearXNG')
  }
  if (input.hasSearchMcpServer) {
    activeLanes.push('via a configured MCP server')
  }
  if (activeLanes.length > 0) {
    return {
      configured: true,
      summary: `web search: on (${activeLanes.join('; ')})`,
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
