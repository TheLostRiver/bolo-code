/**
 * OpenAI-compatible Chat Completions（stream + tools）
 * 兼容：OpenAI / 多数中转 / DeepSeek / 本地 vLLM 等
 * 无遥测。
 */

import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'
import { toolsToOpenAI as toolsToOpenAIImpl } from '../../tools/src/providerSchema.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
  ProviderUsage,
} from './types.ts'
import { mapEffort, DEFAULT_EFFORT_BASE_MAX_TOKENS } from './effort.ts'
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
    max_tokens: config.maxTokens,
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
  if (plan.ok) {
    applyBodyPatches(body, plan.patches)
    // max-tokens 方言：用 plan 倍率覆盖（若有）
    if (plan.maxTokens != null && dialect.applyTokenScale) {
      body.max_tokens = plan.maxTokens
    }
  }
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
    const dialect = resolveEffortDialect(effortDialect)
    const hasTools = Boolean(options?.tools?.length && !options?.disableTools)
    const plan = resolveEffortWire(dialect, options?.effort, {
      isAgent: hasTools,
      model: (options?.model && options.model.trim()) || config.model,
      baseMaxTokens,
    })
    const maxTokens =
      options?.maxTokens ??
      (plan.ok && plan.maxTokens != null
        ? plan.maxTokens
        : mapEffort(options?.effort, baseMaxTokens).maxTokens)
    const body = buildOpenAICompatibleRequestBody(
      messages,
      {
        model: (options?.model && options.model.trim()) || config.model,
        maxTokens,
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
        yield {
          type: 'error',
          message: `OpenAI-compatible HTTP ${res.status}: ${errText.slice(0, 500)}`,
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
    const dialect = resolveEffortDialect(effortDialect)
    const plan = resolveEffortWire(dialect, options?.effort, {
      isAgent: false,
      model: config.model,
      baseMaxTokens,
    })
    const maxTokens =
      options?.maxTokens ??
      (plan.ok && plan.maxTokens != null
        ? plan.maxTokens
        : mapEffort(options?.effort, baseMaxTokens).maxTokens)
    const body = buildOpenAICompatibleRequestBody(
      messages,
      {
        model: config.model,
        maxTokens,
        effortDialect,
        baseUrl: config.baseUrl ?? baseUrl,
      },
      {
        stream: false,
        disableTools: true,
        enablePromptCaching: options?.enablePromptCaching,
        promptCacheKey: options?.promptCacheKey,
        effort: options?.effort,
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