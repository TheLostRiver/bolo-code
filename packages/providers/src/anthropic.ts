/**
 * Anthropic Messages API（/v1/messages + SSE）
 * 对照 HelsincyCode claude.ts 事件形态：content_block_start/delta/stop
 * 不依赖官方 SDK；无遥测。
 */

import { parseRetryAfterMs } from './retryAfter.ts'
import { streamAnthropicSse } from './anthropicStream.ts'
export { streamAnthropicSse } from './anthropicStream.ts'
import {
  detectWebSearchDialectId,
  resolveWebSearchPlan,
} from './webSearchDialect.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'
import { toolsToAnthropic as toolsToAnthropicImpl } from '../../tools/src/providerSchema.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
} from './types.ts'
import {
  DEFAULT_EFFORT_BASE_MAX_TOKENS,
  resolveRequestMaxTokens,
} from './effort.ts'
import {
  applyBodyPatches,
  detectEffortDialectId,
  mergeEffortRequestHeaders,
  resolveEffortDialect,
  resolveEffortWire,
  type EffortDialect,
} from './effortDialect.ts'
import {
  addMessageCacheBreakpoint,
  buildAnthropicSystemBlocks,
  isPromptCachingEnabled,
  withToolsCacheBreakpoint,
} from './promptCache.ts'

export type AnthropicConfig = {
  apiKey: string
  /** 默认 https://api.anthropic.com */
  baseUrl?: string
  model: string
  maxTokens?: number
  /** 模型/服务端允许的单次输出硬上限 */
  maxOutputTokens?: number
  /** 默认 2023-06-01 */
  anthropicVersion?: string
  timeoutMs?: number
  /** Effort 方言；缺省 anthropic-output */
  effortDialect?: string | EffortDialect
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/** 转发到 packages/tools providerSchema，避免双份 schema */
export function toolsToAnthropic(tools: ToolSpec[] | Parameters<typeof toolsToAnthropicImpl>[0]) {
  return toolsToAnthropicImpl(tools as Parameters<typeof toolsToAnthropicImpl>[0])
}

/**
 * Bolo ChatMessage[] → Anthropic system + messages
 * 规则：
 * - system 抽出合并为 system 字符串
 * - assistant + tool_calls → content blocks (text + tool_use)
 * - tool 结果合并进下一条 user 的 tool_result blocks
 *
 * 注意：返回的 system 仍为字符串；cache 块在 buildAnthropicRequestBody 中组装。
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: AnthropicMessage[]
} {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []

  let pendingToolResults: AnthropicContentBlock[] = []

  const flushToolResults = () => {
    if (!pendingToolResults.length) return
    out.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content?.trim()) systemParts.push(m.content.trim())
      continue
    }

    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? 'unknown',
        content: m.content ?? '',
      })
      continue
    }

    // 非 tool 消息前先冲刷 tool_result
    flushToolResults()

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' })
      continue
    }

    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        const blocks: AnthropicContentBlock[] = []
        if (m.content?.trim()) {
          blocks.push({ type: 'text', text: m.content })
        }
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
          } catch {
            input = { raw: tc.arguments }
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input,
          })
        }
        out.push({ role: 'assistant', content: blocks })
      } else {
        out.push({ role: 'assistant', content: m.content ?? '' })
      }
    }
  }

  flushToolResults()

  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages: out,
  }
}

function normalizeBaseUrl(base?: string): string {
  const b = (base ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  // 允许用户传 .../v1
  return b.endsWith('/v1') ? b : `${b}/v1`
}

// eventsFromAnthropicSseEvent 已迁至 anthropicEvents.ts；此处 re-export 保持既有导入路径
export { eventsFromAnthropicSseEvent } from './anthropicEvents.ts'

/**
 * 组装 Anthropic Messages 请求体（含最小 cache_control 断点 · effort 方言）。
 * 断点策略：system 稳定段末尾 + tools 末项（若有）+ messages 最后一条末块。
 * 可选 thinking: { type:'enabled', budget_tokens }（options.anthropicThinking）。
 * E5：output_config.effort 经 dialect `anthropic-output`（与 thinking 独立）。
 */
export function buildAnthropicRequestBody(
  messages: ChatMessage[],
  config: {
    model: string
    maxTokens: number
    maxOutputTokens?: number
    effortDialect?: string | EffortDialect | null
  },
  options?: CompleteStreamOptions & {
    stream?: boolean
    isAgent?: boolean
  },
): { body: Record<string, unknown>; requestHeaders?: Record<string, string> } {
  const { system, messages: antMessages } = toAnthropicMessages(messages)
  const caching = isPromptCachingEnabled(options)
  const body: Record<string, unknown> = {
    model: config.model,
    messages: addMessageCacheBreakpoint(antMessages, caching),
    stream: options?.stream ?? true,
  }
  const systemBlocks = buildAnthropicSystemBlocks(system, caching)
  if (systemBlocks) body.system = systemBlocks
  if (!options?.disableTools && options?.tools?.length) {
    // hosted 搜索条目必须在打 cache 断点**之前**混入，
    // 否则它落在缓存前缀之外，每轮都要重新计费。
    // 它是 tools 数组里的兄弟对象，但**不**经过客户端工具 mapper：
    // 服务端工具只有 type + name，没有 input_schema。
    const clientTools = toolsToAnthropic(options.tools) as Array<
      Record<string, unknown>
    >
    // 缺省 = 不启用。`auto` 的「默认开」必须由**会话层显式传下来**，
    // 而不是在这里替调用方决定：直接调 buildAnthropicRequestBody 的既有代码
    // 若因此静默开启搜索，用户会为自己没要求过的请求付费。
    const plan = resolveWebSearchPlan(
      detectWebSearchDialectId({
        kind: 'anthropic',
        model: config.model,
      }),
      options.webSearch ?? 'off',
      { model: config.model },
    )
    const merged = plan.enabled
      ? [...plan.toolObjects.map((t) => ({ ...t })), ...clientTools]
      : clientTools
    body.tools = withToolsCacheBreakpoint(merged, caching)
  }
  const dialectRaw =
    config.effortDialect ??
    detectEffortDialectId({ kind: 'anthropic', model: config.model })
  const dialect = resolveEffortDialect(dialectRaw)
  const hasTools = Boolean(options?.tools?.length && !options?.disableTools)
  const plan = resolveEffortWire(dialect, options?.effort, {
    isAgent: options?.isAgent ?? hasTools,
    model: config.model,
    baseMaxTokens: config.maxTokens,
  })
  const maxTokens = resolveRequestMaxTokens({
    configuredMaxTokens: config.maxTokens,
    maxOutputTokens: config.maxOutputTokens,
    explicitMaxTokens: options?.maxTokens,
    effortMaxTokens: plan.ok ? plan.maxTokens : undefined,
  })
  let requestHeaders: Record<string, string> | undefined
  if (plan.ok) {
    applyBodyPatches(body, plan.patches)
    if (plan.requestHeaders) {
      requestHeaders = { ...plan.requestHeaders }
    }
  }
  body.max_tokens = maxTokens
  const thinking = resolveAnthropicThinking(
    options?.anthropicThinking,
    maxTokens,
  )
  if (thinking) body.thinking = thinking
  return { body, ...(requestHeaders ? { requestHeaders } : {}) }
}

/** 最小 thinking 请求块；budget 必须 < max_tokens */
export function resolveAnthropicThinking(
  opt: CompleteStreamOptions['anthropicThinking'],
  maxTokens: number,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (opt === undefined || opt === false || opt === 'off') return undefined
  let budget = 10_000
  if (typeof opt === 'number' && Number.isFinite(opt)) {
    budget = Math.floor(opt)
  }
  // API 约束：max_tokens > budget_tokens
  const cap = Math.max(1024, Math.min(budget, maxTokens - 1))
  if (cap < 1024 || maxTokens <= 1024) return undefined
  return { type: 'enabled', budget_tokens: cap }
}

export function createAnthropicProvider(config: AnthropicConfig): LlmProvider {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const timeoutMs = config.timeoutMs ?? 120_000
  const baseMaxTokens = config.maxTokens ?? DEFAULT_EFFORT_BASE_MAX_TOKENS
  const version = config.anthropicVersion ?? '2023-06-01'
  const effortDialect =
    config.effortDialect ??
    detectEffortDialectId({
      kind: 'anthropic',
      baseUrl: config.baseUrl ?? baseUrl,
      model: config.model,
    })

  async function* streamMessages(
    messages: ChatMessage[],
    options?: CompleteStreamOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const url = `${baseUrl}/messages`
    const hasTools = Boolean(options?.tools?.length && !options?.disableTools)
    const built = buildAnthropicRequestBody(
      messages,
      {
        model: (options?.model && options.model.trim()) || config.model,
        maxTokens: baseMaxTokens,
        maxOutputTokens: config.maxOutputTokens,
        effortDialect,
      },
      { ...options, stream: true, isAgent: hasTools },
    )
    const body = built.body

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    options?.signal?.addEventListener('abort', onAbort)

    try {
      const headers = mergeEffortRequestHeaders(
        {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': version,
        },
        built.requestHeaders,
      )
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        const retryAfterMs = parseRetryAfterMs(res.headers)
        yield {
          type: 'error',
          message: `Anthropic HTTP ${res.status}: ${errText.slice(0, 500)}`,
          status: res.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        }
        yield { type: 'done' }
        return
      }

      if (!res.body) {
        yield { type: 'error', message: 'No response body for Anthropic stream' }
        yield { type: 'done' }
        return
      }

      // 解析已抽到 anthropicStream.ts：HTTP 与解析分开，
      // 且服务端搜索块必须走独立累加器（见该文件顶部的不变量说明）。
      yield* streamAnthropicSse(res.body)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      yield { type: 'error', message: msg }
      yield { type: 'done' }
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
    }
  }

  async function completeText(
    messages: ChatMessage[],
    options?: {
      signal?: AbortSignal
      effort?: string
      maxTokens?: number
      enablePromptCaching?: boolean
    },
  ): Promise<string> {
    const url = `${baseUrl}/messages`
    const built = buildAnthropicRequestBody(
      messages,
      {
        model: config.model,
        maxTokens: baseMaxTokens,
        maxOutputTokens: config.maxOutputTokens,
        effortDialect,
      },
      {
        stream: false,
        disableTools: true,
        enablePromptCaching: options?.enablePromptCaching,
        effort: options?.effort,
        maxTokens: options?.maxTokens,
        isAgent: false,
      },
    )
    const body = built.body

    const res = await fetch(url, {
      method: 'POST',
      headers: mergeEffortRequestHeaders(
        {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': version,
        },
        built.requestHeaders,
      ),
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 500)}`)
    }
    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>
    }
    const texts =
      json.content
        ?.filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!) ?? []
    return texts.join('')
  }

  return {
    id: 'anthropic',
    completeStream: streamMessages,
    completeText,
  }
}
