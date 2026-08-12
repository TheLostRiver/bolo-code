/**
 * OpenAI-compatible Chat Completions（stream + tools）
 * 兼容：OpenAI / 多数中转 / DeepSeek / 本地 vLLM 等
 * 无遥测。
 */

import { parseRetryAfterMs } from './retryAfter.ts'
import {
  detectWebSearchDialectId,
  resolveWebSearchPlan,
} from './webSearchDialect.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'
import { toolsToOpenAI as toolsToOpenAIImpl } from '../../tools/src/providerSchema.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
  ProviderUsage,
} from './types.ts'
import {
  DEFAULT_EFFORT_BASE_MAX_TOKENS,
  resolveRequestMaxTokens,
} from './effort.ts'
import {
  applyBodyPatches,
  detectEffortDialectId,
  resolveEffortDialect,
  resolveEffortWire,
  type EffortDialect,
} from './effortDialect.ts'
import { mergeProviderUsage, parseOpenAIStreamUsage } from './sseUsage.ts'
import {
  derivePromptCacheKey,
  isPromptCachingEnabled,
} from './promptCache.ts'

export type OpenAICompatibleConfig = {
  apiKey: string
  baseUrl?: string
  model: string
  /** 默认 max_tokens（effort 倍率基准）；默认 8192 */
  maxTokens?: number
  maxOutputTokens?: number
  /** 默认 120s */
  timeoutMs?: number
  /**
   * Effort 方言：内置 id（deepseek-chat / max-tokens / …）或内联表。
   * 缺省：detectEffortDialectId(baseUrl, model)。
   */
  effortDialect?: string | import('./effortDialect.ts').EffortDialect
}

type OaiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string }

type OaiToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 转发到 packages/tools providerSchema，避免双份 schema */
export function toolsToOpenAI(tools: ToolSpec[] | Parameters<typeof toolsToOpenAIImpl>[0]) {
  return toolsToOpenAIImpl(tools as Parameters<typeof toolsToOpenAIImpl>[0])
}

export function toOpenAIMessages(messages: ChatMessage[]): OaiMessage[] {
  const out: OaiMessage[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: m.tool_call_id ?? 'unknown',
        name: m.name,
      })
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const row: OaiMessage & { reasoning_content?: string } = {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }
      if (m.reasoning_content?.trim()) {
        ;(row as { reasoning_content?: string }).reasoning_content =
          m.reasoning_content
      }
      out.push(row)
      continue
    }
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      const row: OaiMessage & { reasoning_content?: string } = {
        role: m.role,
        content: m.content ?? '',
      }
      if (
        m.role === 'assistant' &&
        m.reasoning_content?.trim()
      ) {
        ;(row as { reasoning_content?: string }).reasoning_content =
          m.reasoning_content
      }
      out.push(row)
    }
  }
  return out
}

function normalizeBaseUrl(base?: string): string {
  const b = (base ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  return b
}

/**
 * 解析本请求应写入的 prompt_cache_key（OpenAI 可选字段）。
 * - enablePromptCaching === false → 不写
 * - promptCacheKey === '' → 显式关闭
 * - 有 promptCacheKey → 用调用方值
 * - 否则由 model + system 稳定前缀派生
 */
export function resolveOpenAIPromptCacheKey(
  messages: ChatMessage[],
  model: string,
  options?: Pick<
    CompleteStreamOptions,
    'enablePromptCaching' | 'promptCacheKey'
  >,
): string | undefined {
  if (!isPromptCachingEnabled(options)) return undefined
  if (options?.promptCacheKey === '') return undefined
  if (options?.promptCacheKey) return options.promptCacheKey
  return derivePromptCacheKey(messages, model)
}

/**
 * 从 Chat Completions `choices[0].delta` 提取 text / reasoning 事件（不含 tool）。
 * - content → text_delta
 * - reasoning_content → reasoning_delta（DeepSeek 等；无字段则零输出）
 */
export function eventsFromOpenAIChatDelta(delta: {
  content?: string | null
  reasoning_content?: string | null
}): ProviderStreamEvent[] {
  const out: ProviderStreamEvent[] = []
  if (delta.reasoning_content) {
    out.push({ type: 'reasoning_delta', text: delta.reasoning_content })
  }
  if (delta.content) {
    out.push({ type: 'text_delta', text: delta.content })
  }
  return out
}

/** 组装 Chat Completions 请求体（含可选 prompt_cache_key · effort 方言 patch） */
export function buildOpenAICompatibleRequestBody(
  messages: ChatMessage[],
  config: {
    model: string
    maxTokens: number
    maxOutputTokens?: number
    effortDialect?: string | EffortDialect | null
    /** 覆盖 detect；与 effortDialect 二选一优先 effortDialect */
    baseUrl?: string
  },
  options?: CompleteStreamOptions & {
    stream?: boolean
    /** 主 agent / 带 tools 时 true → dialect.agentDefault */
    isAgent?: boolean
  },
): Record<string, unknown> {
  const stream = options?.stream ?? true
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAIMessages(messages),
    stream,
  }
  if (stream) {
    body.stream_options = { include_usage: true }
  }
  if (!options?.disableTools && options?.tools?.length) {
    body.tools = toolsToOpenAI(options.tools)
    body.tool_choice = 'auto'
  }
  const cacheKey = resolveOpenAIPromptCacheKey(messages, config.model, options)
  if (cacheKey) body.prompt_cache_key = cacheKey

  // OpenRouter web plugin（openai-compatible 轨里唯一的 hosted 搜索）。
  // 严格按 baseUrl 门控：DeepSeek 实测证明未知 body 字段会被**静默忽略**，
  // 广撒只会让用户以为搜索开着。缺省 off——官方文档明写即使免费模型也另行计费。
  const searchPlan = resolveWebSearchPlan(
    detectWebSearchDialectId({
      kind: 'openai-compatible',
      baseUrl: config.baseUrl,
      model: config.model,
    }),
    options?.webSearch ?? 'off',
    { model: config.model },
  )
  if (searchPlan.enabled && searchPlan.bodyPatch) {
    Object.assign(body, searchPlan.bodyPatch)
  }

  // E 轨：按方言写入 reasoning_effort 等（纯表驱动）
  const dialectRaw =
    config.effortDialect ??
    detectEffortDialectId({
      kind: 'openai-compatible',
      baseUrl: config.baseUrl,
      model: config.model,
    })
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
  if (plan.ok) {
    applyBodyPatches(body, plan.patches)
  }
  body.max_tokens = maxTokens
  return body
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
): LlmProvider {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const timeoutMs = config.timeoutMs ?? 120_000
  const baseMaxTokens = config.maxTokens ?? DEFAULT_EFFORT_BASE_MAX_TOKENS
  const effortDialect =
    config.effortDialect ??
    detectEffortDialectId({
      kind: 'openai-compatible',
      baseUrl: config.baseUrl ?? baseUrl,
      model: config.model,
    })

  async function* streamChat(
    messages: ChatMessage[],
    options?: CompleteStreamOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const url = `${baseUrl}/chat/completions`
    const hasTools = Boolean(options?.tools?.length && !options?.disableTools)
    const body = buildOpenAICompatibleRequestBody(
      messages,
      {
        model: (options?.model && options.model.trim()) || config.model,
        maxTokens: baseMaxTokens,
        maxOutputTokens: config.maxOutputTokens,
        effortDialect,
        baseUrl: config.baseUrl ?? baseUrl,
      },
      { ...options, stream: true, isAgent: hasTools },
    )

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const signal = options?.signal
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        const retryAfterMs = parseRetryAfterMs(res.headers)
        yield {
          type: 'error',
          message: `OpenAI-compatible HTTP ${res.status}: ${errText.slice(0, 500)}`,
          status: res.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        }
        yield { type: 'done' }
        return
      }

      if (!res.body) {
        yield { type: 'error', message: 'No response body for stream' }
        yield { type: 'done' }
        return
      }

      // tool_calls 按 index 增量拼接
      const toolAcc = new Map<
        number,
        { id: string; name: string; arguments: string }
      >()
      let streamUsage: ProviderUsage | null = null

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const flushTools = function* (): Generator<ProviderStreamEvent> {
        for (const tc of toolAcc.values()) {
          if (tc.name) {
            yield {
              type: 'tool_call',
              id: tc.id || `call_${tc.name}`,
              name: tc.name,
              arguments: tc.arguments || '{}',
            }
          }
        }
        toolAcc.clear()
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            yield* flushTools()
            if (streamUsage) yield { type: 'usage', usage: streamUsage }
            yield { type: 'done' }
            return
          }
          let json: {
            usage?: unknown
            choices?: Array<{
              delta?: {
                content?: string | null
                reasoning_content?: string | null
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string | null
            }>
          }
          try {
            json = JSON.parse(data)
          } catch {
            continue
          }

          const u = parseOpenAIStreamUsage(json)
          if (u) streamUsage = mergeProviderUsage(streamUsage, u)

          const delta = json.choices?.[0]?.delta
          if (delta) {
            for (const ev of eventsFromOpenAIChatDelta(delta)) {
              yield ev
            }
          }

          // 引用可能挂在 delta 上（流式）或 message 上（末帧）。
          // 两处都看：漏掉就等于用户付了搜索的钱却看不到来源。
          const anns =
            (delta as { annotations?: unknown } | undefined)?.annotations ??
            (json.choices?.[0] as { message?: { annotations?: unknown } })
              ?.message?.annotations
          for (const ev of parseOpenAIAnnotations(anns)) {
            yield ev
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const cur = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' }
              if (tc.id) cur.id = tc.id
              if (tc.function?.name) cur.name += tc.function.name
              if (tc.function?.arguments) cur.arguments += tc.function.arguments
              toolAcc.set(idx, cur)
            }
          }

          const fr = json.choices?.[0]?.finish_reason
          if ((fr === 'tool_calls' || fr === 'stop') && toolAcc.size) {
            yield* flushTools()
          }
        }
      }

      // stream ended without [DONE]
      yield* flushTools()
      if (streamUsage) yield { type: 'usage', usage: streamUsage }
      yield { type: 'done' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      yield { type: 'error', message: msg }
      yield { type: 'done' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function completeText(
    messages: ChatMessage[],
    options?: {
      signal?: AbortSignal
      effort?: string
      maxTokens?: number
      enablePromptCaching?: boolean
      promptCacheKey?: string
    },
  ): Promise<string> {
    const url = `${baseUrl}/chat/completions`
    const body = buildOpenAICompatibleRequestBody(
      messages,
      {
        model: config.model,
        maxTokens: baseMaxTokens,
        maxOutputTokens: config.maxOutputTokens,
        effortDialect,
        baseUrl: config.baseUrl ?? baseUrl,
      },
      {
        stream: false,
        disableTools: true,
        enablePromptCaching: options?.enablePromptCaching,
        promptCacheKey: options?.promptCacheKey,
        effort: options?.effort,
        maxTokens: options?.maxTokens,
        isAgent: false,
      },
    )
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`OpenAI-compatible HTTP ${res.status}: ${errText.slice(0, 500)}`)
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return json.choices?.[0]?.message?.content ?? ''
  }

  return {
    id: 'openai-compatible',
    completeStream: streamChat,
    completeText,
  }
}

/**
 * OpenAI Chat Completions 的 `annotations[]` → web_search 引用事件。
 *
 * 形状与 OpenAI Responses **不同**：这里是嵌套的
 * `{ type:'url_citation', url_citation:{ url, title, ... } }`，
 * Responses 那侧是扁平的 `annotation.url`（已活体验证）。照搬会解析不出来。
 *
 * 同时容忍扁平写法：万一上游改形状，宁可多认一种，也不要静默丢引用。
 */
export function parseOpenAIAnnotations(
  annotations: unknown,
): ProviderStreamEvent[] {
  if (!Array.isArray(annotations)) return []
  const out: ProviderStreamEvent[] = []
  for (const raw of annotations) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    if (a.type !== 'url_citation') continue
    const nested =
      a.url_citation && typeof a.url_citation === 'object'
        ? (a.url_citation as Record<string, unknown>)
        : undefined
    const url =
      typeof nested?.url === 'string'
        ? nested.url
        : typeof a.url === 'string'
          ? a.url
          : undefined
    if (!url) continue
    const title =
      typeof nested?.title === 'string'
        ? nested.title
        : typeof a.title === 'string'
          ? a.title
          : undefined
    out.push({
      type: 'web_search',
      phase: 'citation',
      url,
      ...(title ? { title } : {}),
    })
  }
  return out
}
