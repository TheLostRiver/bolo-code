/**
 * Web search 方言表：一个用户意图 → 每厂 wire 片段。
 *
 * 与 `effortDialect.ts` 同构，理由也一样：厂商差异属于**数据**，不属于
 * 散落在 provider 里的 if/else。会话只携带意图 `on|off|auto`；
 * `ToolSpec` 不被任何厂商形状污染。
 *
 * 参考调研结论（只借语义）：HelsincyCode 用 Anthropic 服务端 web_search，
 * codex 发 OpenAI hosted ToolSpec，opencode 两条都有——**没人自建搜索引擎**。
 * 因此 hosted 路径不引入新的第三方接收方：搜索由用户本来就在对话的
 * provider 执行，所以默认可以开。
 */

/** 用户意图。`auto` = 采用该方言自己的默认值。 */
export type WebSearchIntent = 'on' | 'off' | 'auto'

export type WebSearchDialectId =
  | 'anthropic-hosted'
  | 'openai-responses-hosted'
  | 'openrouter-plugin'
  | 'off'

export type WebSearchDialect = {
  id: WebSearchDialectId
  /**
   * `auto` 时是否启用。
   *
   * hosted 两轨为 true：搜索在用户已经在对话的 provider 侧执行，
   * 没有新增接收方，关掉只是白白削功能。
   * openrouter 为 false：它把 query 转给 Exa 之类的**新**后端，且按次计费。
   */
  defaultEnabled: boolean
  /** 人类可读，用于 `/doctor` 与状态行 */
  label: string
}

export const WEB_SEARCH_DIALECTS: Readonly<
  Record<WebSearchDialectId, WebSearchDialect>
> = {
  'anthropic-hosted': {
    id: 'anthropic-hosted',
    defaultEnabled: true,
    label: 'Anthropic server-side web search',
  },
  'openai-responses-hosted': {
    id: 'openai-responses-hosted',
    defaultEnabled: true,
    label: 'OpenAI hosted web search',
  },
  'openrouter-plugin': {
    id: 'openrouter-plugin',
    // 新第三方接收方 + 按次计费 → 不替用户默认外发
    defaultEnabled: false,
    label: 'OpenRouter web plugin (billed per request)',
  },
  off: {
    id: 'off',
    defaultEnabled: false,
    label: 'no hosted web search on this endpoint',
  },
}

/**
 * Anthropic 服务端搜索工具条目。
 *
 * **不带** `input_schema` / `description`——那是客户端工具的形状；
 * 服务端工具只给 `type` + `name`，由 Anthropic 侧执行。
 *
 * `max_uses` 是常量：这个对象会进 prompt cache 前缀，
 * 任何按调用变化的字段（域过滤、动态上限）都会每次击穿缓存。
 */
export const ANTHROPIC_WEB_SEARCH_TOOL: Readonly<Record<string, unknown>> = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 8,
}

/** OpenAI Responses hosted 搜索条目（最小体；不发未经证实的字段） */
export const OPENAI_RESPONSES_WEB_SEARCH_TOOL: Readonly<
  Record<string, unknown>
> = {
  type: 'web_search',
}

export type DetectWebSearchDialectInput = {
  kind?: string
  baseUrl?: string
  model?: string
}

/**
 * 按 provider kind + baseUrl 指纹选方言（同 `detectEffortDialectId` 手法）。
 * 认不出就是 `off`——**没有这个能力**，不是坏了。
 */
export function detectWebSearchDialectId(
  input: DetectWebSearchDialectInput,
): WebSearchDialectId {
  const kind = (input.kind ?? '').toLowerCase().trim()
  const baseUrl = (input.baseUrl ?? '').toLowerCase()

  if (kind === 'anthropic') return 'anthropic-hosted'
  if (kind === 'openai-responses') return 'openai-responses-hosted'
  if (kind === 'openai-compatible') {
    // OpenRouter 是唯一在 Chat Completions 形状上提供通用 hosted 搜索的端点。
    // 严格按 baseUrl 门控：把 `plugins` 发给不认识它的端点可能直接 400。
    if (baseUrl.includes('openrouter.ai')) return 'openrouter-plugin'
    return 'off'
  }
  return 'off'
}

export type WebSearchPlan = {
  enabled: boolean
  dialect: WebSearchDialect
  /** 追加到 `body.tools` 的 hosted 条目（可为空） */
  toolObjects: Array<Readonly<Record<string, unknown>>>
  /** 合并进请求体顶层的片段（OpenRouter 的 `plugins`） */
  bodyPatch?: Readonly<Record<string, unknown>>
  /**
   * 用户明确要开、但这条线路给不了时的原因。
   * 有了它，CLI 才能解释而不是静默无反应。
   */
  unsupportedReason?: string
}

export type ResolveWebSearchOptions = {
  model?: string
}

/**
 * 把意图解成具体 wire 片段。
 *
 * 刻意**乐观**：model 门控留给 CX2 能力表与上游 400 回退。
 * 在这里硬编码 model 矩阵会随厂商改名迅速过期，
 * 而错判「不支持」是静默削功能——比一个可诊断的 400 更糟。
 */
export function resolveWebSearchPlan(
  dialectId: WebSearchDialectId,
  intent: WebSearchIntent,
  _options: ResolveWebSearchOptions = {},
): WebSearchPlan {
  const dialect = WEB_SEARCH_DIALECTS[dialectId] ?? WEB_SEARCH_DIALECTS.off

  if (dialect.id === 'off') {
    return {
      enabled: false,
      dialect,
      toolObjects: [],
      ...(intent === 'on'
        ? {
            unsupportedReason:
              'this provider/endpoint has no hosted web search; configure a search MCP server to add it',
          }
        : {}),
    }
  }

  const enabled = intent === 'off' ? false : intent === 'on' ? true : dialect.defaultEnabled
  if (!enabled) return { enabled: false, dialect, toolObjects: [] }

  switch (dialect.id) {
    case 'anthropic-hosted':
      return { enabled: true, dialect, toolObjects: [ANTHROPIC_WEB_SEARCH_TOOL] }
    case 'openai-responses-hosted':
      return {
        enabled: true,
        dialect,
        toolObjects: [OPENAI_RESPONSES_WEB_SEARCH_TOOL],
      }
    case 'openrouter-plugin':
      return {
        enabled: true,
        dialect,
        toolObjects: [],
        bodyPatch: { plugins: [{ id: 'web' }] },
      }
    default:
      return { enabled: false, dialect, toolObjects: [] }
  }
}
