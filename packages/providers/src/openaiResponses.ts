/**
 * OpenAI Responses API 原生直连（HTTP SSE）
 * 对照：OpenAI Responses 文档 + Codex codex-api responses SSE（事件名）
 * 不经 Chat Completions 伪装；无遥测。
 *
 * POST {base}/responses
 * stream events: response.output_text.delta / response.output_item.done /
 *                response.completed / response.failed …
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
import { mergeProviderUsage } from './sseUsage.ts'
import {
  derivePromptCacheKey,
  isPromptCachingEnabled,
} from './promptCache.ts'

export type OpenAIResponsesConfig = {
  apiKey: string
  baseUrl?: string
  model: string
  /** effort 基准 max_output_tokens；默认 8192 */
  maxTokens?: number
  timeoutMs?: number
  /** 默认 false：不在服务端持久化 response（agent 自管 transcript） */
  store?: boolean
}

/** Responses input item（最小子集） */
export type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'system'; content: string }
  | {
      type: 'function_call'
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

export type ResponsesRequestBody = {
  model: string
  instructions?: string
  input: ResponsesInputItem[]
  tools?: unknown[]
  tool_choice?: string
  stream: boolean
  store: boolean
  max_output_tokens?: number
  parallel_tool_calls?: boolean
  /** OpenAI prompt cache 路由键（可选；网关不支持时可忽略） */
  prompt_cache_key?: string
}

function normalizeBaseUrl(base?: string): string {
  // 允许 https://api.openai.com/v1 或 https://api.openai.com
  let b = (base ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  if (b.endsWith('/responses')) {
    b = b.slice(0, -'/responses'.length)
  }
  return b
}

/**
 * ChatMessage[] → Responses instructions + input
 * system 合并进 instructions；tool 往返用 function_call / function_call_output
 */
export function toResponsesPayload(messages: ChatMessage[]): {
  instructions: string
  input: ResponsesInputItem[]
} {
  const systemParts: string[] = []
  const input: ResponsesInputItem[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content?.trim()) systemParts.push(m.content.trim())
      continue
    }
    if (m.role === 'user') {
      input.push({ role: 'user', content: m.content ?? '' })
      continue
    }
    if (m.role === 'assistant') {
      // 先文本（若有）
      if (m.content?.trim()) {
        input.push({ role: 'assistant', content: m.content })
      }
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments ?? '{}',
          })
        }
      } else if (!m.content?.trim()) {
        // 空 assistant 跳过
      }
      continue
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? 'unknown',
        output: m.content ?? '',
      })
    }
  }

  return {
    instructions: systemParts.join('\n\n'),
    input,
  }
}

/** 工具：Responses 使用 type:function + name + parameters（与 Chat Completions function 类似） */
export function toolsToResponses(
  tools: ToolSpec[] | Parameters<typeof toolsToOpenAIImpl>[0],
): unknown[] {
  const oai = toolsToOpenAIImpl(tools as Parameters<typeof toolsToOpenAIImpl>[0])
  return oai.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    // OpenAI Responses 常用 strict 可选；缺省不强制
  }))
}

export function buildResponsesRequest(
  messages: ChatMessage[],
  config: { model: string; store?: boolean },
  options?: CompleteStreamOptions & { maxOutputTokens?: number },
): ResponsesRequestBody {
  const { instructions, input } = toResponsesPayload(messages)
  const body: ResponsesRequestBody = {
    model: config.model,
    input,
    stream: true,
    store: config.store ?? false,
    parallel_tool_calls: true,
  }
  if (instructions) body.instructions = instructions
  if (options?.maxOutputTokens != null) {
    body.max_output_tokens = options.maxOutputTokens
  }
  if (!options?.disableTools && options?.tools?.length) {
    body.tools = toolsToResponses(options.tools)
    body.tool_choice = 'auto'
  }
  // prompt_cache_key：OpenAI 可选；兼容网关不识别时通常忽略未知字段
  if (isPromptCachingEnabled(options)) {
    if (options?.promptCacheKey === '') {
      // 显式关闭
    } else if (options?.promptCacheKey) {
      body.prompt_cache_key = options.promptCacheKey
    } else {
      body.prompt_cache_key = derivePromptCacheKey(messages, config.model)
    }
  }
  return body
}

/** 从 response.completed / response 对象提取 usage */
export function parseResponsesUsage(json: unknown): ProviderUsage | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  // 事件顶层 response.usage 或 usage
  const resp =
    o.response && typeof o.response === 'object'
      ? (o.response as Record<string, unknown>)
      : o
  const u = (resp.usage ?? o.usage) as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return null
  const input =
    num(u.input_tokens) ?? num(u.prompt_tokens) ?? num(u.inputTokens)
  const output =
    num(u.output_tokens) ?? num(u.completion_tokens) ?? num(u.outputTokens)
  const total = num(u.total_tokens) ?? num(u.totalTokens)
  let cacheRead =
    num(u.cache_read_input_tokens) ??
    num(u.cacheReadInputTokens) ??
    num(u.cache_read_tokens)
  if (cacheRead == null) {
    const details = u.input_tokens_details
    if (details && typeof details === 'object') {
      const d = details as Record<string, unknown>
      cacheRead = num(d.cached_tokens) ?? num(d.cachedTokens)
    }
  }
  if (cacheRead == null) {
    const details = u.prompt_tokens_details
    if (details && typeof details === 'object') {
      const d = details as Record<string, unknown>
      cacheRead = num(d.cached_tokens) ?? num(d.cachedTokens)
    }
  }
  const cacheCreate =
    num(u.cache_creation_input_tokens) ??
    num(u.cacheCreationInputTokens) ??
    num(u.cache_creation_tokens)
  if (
    input == null &&
    output == null &&
    total == null &&
    cacheRead == null &&
    cacheCreate == null
  ) {
    return null
  }
  return {
    ...(input != null ? { inputTokens: input } : {}),
    ...(output != null ? { outputTokens: output } : {}),
    ...(total != null
      ? { totalTokens: total }
      : input != null || output != null
        ? { totalTokens: (input ?? 0) + (output ?? 0) }
        : {}),
    ...(cacheRead != null ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreate != null ? { cacheCreationInputTokens: cacheCreate } : {}),
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 解析单条 SSE JSON（data: 后的对象）→ 零或多个 ProviderStreamEvent
 * 供单测与 stream 循环共用。
 */
export function processResponsesSseJson(
  json: Record<string, unknown>,
  state: {
    toolAcc: Map<string, { id: string; name: string; arguments: string }>
  },
): {
  events: ProviderStreamEvent[]
  usage?: ProviderUsage | null
  failed?: string
  completed?: boolean
} {
  const events: ProviderStreamEvent[] = []
  const kind = String(json.type ?? '')

  if (kind === 'response.output_text.delta' || kind === 'response.text.delta') {
    const delta =
      typeof json.delta === 'string'
        ? json.delta
        : typeof (json as { text?: string }).text === 'string'
          ? (json as { text: string }).text
          : ''
    if (delta) events.push({ type: 'text_delta', text: delta })
    return { events }
  }

  // 部分网关用 content_part delta
  if (
    kind === 'response.content_part.delta' &&
    json.delta &&
    typeof json.delta === 'object'
  ) {
    const d = json.delta as Record<string, unknown>
    if (typeof d.text === 'string' && d.text) {
      events.push({ type: 'text_delta', text: d.text })
    }
    return { events }
  }

  if (
    kind === 'response.function_call_arguments.delta' ||
    kind === 'response.custom_tool_call_input.delta'
  ) {
    const itemId = String(
      json.item_id ?? json.call_id ?? json.id ?? 'call_pending',
    )
    const cur = state.toolAcc.get(itemId) ?? {
      id: itemId,
      name: '',
      arguments: '',
    }
    if (typeof json.delta === 'string') cur.arguments += json.delta
    if (typeof json.name === 'string') cur.name = json.name
    if (typeof json.call_id === 'string') cur.id = json.call_id
    state.toolAcc.set(itemId, cur)
    return { events }
  }

  if (kind === 'response.output_item.added' || kind === 'response.output_item.done') {
    const item = json.item as Record<string, unknown> | undefined
    if (item && typeof item === 'object') {
      const t = String(item.type ?? '')
      if (t === 'function_call' || t === 'custom_tool_call') {
        const callId = String(item.call_id ?? item.id ?? '')
        const name = String(item.name ?? '')
        const args =
          typeof item.arguments === 'string'
            ? item.arguments
            : item.arguments != null
              ? JSON.stringify(item.arguments)
              : ''
        if (callId || name) {
          const key = callId || name
          const cur = state.toolAcc.get(key) ?? {
            id: callId || key,
            name: '',
            arguments: '',
          }
          if (callId) cur.id = callId
          if (name) cur.name = name
          if (args) cur.arguments = args
          state.toolAcc.set(key, cur)
          // done 时刷出完整 tool_call
          if (kind === 'response.output_item.done' && cur.name) {
            events.push({
              type: 'tool_call',
              id: cur.id || key,
              name: cur.name,
              arguments: cur.arguments || '{}',
            })
            state.toolAcc.delete(key)
          }
        }
      }
      // message 完成时可能带 output_text
      if (t === 'message' && kind === 'response.output_item.done') {
        const content = item.content
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === 'object' &&
              (part as { type?: string }).type === 'output_text' &&
              typeof (part as { text?: string }).text === 'string'
            ) {
              // 若已有 delta 可能重复；仅当无流式时补全文风险高，跳过 full dump
            }
          }
        }
      }
    }
    return { events }
  }

  if (kind === 'response.completed') {
    const usage = parseResponsesUsage(json)
    return { events, usage, completed: true }
  }

  if (kind === 'response.failed' || kind === 'error') {
    let msg = 'response.failed'
    const resp = json.response as Record<string, unknown> | undefined
    const err = (resp?.error ?? json.error) as Record<string, unknown> | undefined
    if (err && typeof err.message === 'string') msg = err.message
    else if (typeof json.message === 'string') msg = json.message
    return { events, failed: msg }
  }

  if (kind === 'response.incomplete') {
    return { events, failed: 'Incomplete response from Responses API' }
  }

  return { events }
}

export function createOpenAIResponsesProvider(
  config: OpenAIResponsesConfig,
): LlmProvider {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const timeoutMs = config.timeoutMs ?? 120_000
  const baseMaxTokens = config.maxTokens ?? DEFAULT_EFFORT_BASE_MAX_TOKENS
  const store = config.store ?? false

  async function* streamResponses(
    messages: ChatMessage[],
    options?: CompleteStreamOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const url = `${baseUrl}/responses`
    const maxTokens =
      options?.maxTokens ??
      mapEffort(options?.effort, baseMaxTokens).maxTokens
    const body = buildResponsesRequest(messages, { model: config.model, store }, {
      ...options,
      maxOutputTokens: maxTokens,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const signal = options?.signal
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)

    const state = {
      toolAcc: new Map<string, { id: string; name: string; arguments: string }>(),
    }
    let streamUsage: ProviderUsage | undefined

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
          message: `OpenAI Responses HTTP ${res.status}: ${errText.slice(0, 500)}`,
        }
        yield { type: 'done' }
        return
      }

      if (!res.body) {
        yield { type: 'error', message: 'OpenAI Responses: empty body' }
        yield { type: 'done' }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false

      const flushPendingTools = function* () {
        for (const [, cur] of state.toolAcc) {
          if (cur.name) {
            yield {
              type: 'tool_call' as const,
              id: cur.id || `call_${cur.name}`,
              name: cur.name,
              arguments: cur.arguments || '{}',
            }
          }
        }
        state.toolAcc.clear()
      }

      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''

        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (trimmed === 'data: [DONE]') {
            finished = true
            break
          }
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') {
            if (data === '[DONE]') finished = true
            continue
          }
          let json: Record<string, unknown>
          try {
            json = JSON.parse(data) as Record<string, unknown>
          } catch {
            continue
          }

          const r = processResponsesSseJson(json, state)
          for (const ev of r.events) yield ev
          if (r.usage) streamUsage = mergeProviderUsage(streamUsage, r.usage)
          if (r.failed) {
            yield { type: 'error', message: r.failed }
            finished = true
            break
          }
          if (r.completed) {
            finished = true
            break
          }
        }
      }

      yield* flushPendingTools()
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
    options?: { signal?: AbortSignal; effort?: string; maxTokens?: number },
  ): Promise<string> {
    const url = `${baseUrl}/responses`
    const maxTokens =
      options?.maxTokens ??
      mapEffort(options?.effort, baseMaxTokens).maxTokens
    const body = buildResponsesRequest(
      messages,
      { model: config.model, store },
      { disableTools: true, maxOutputTokens: maxTokens },
    )
    body.stream = false

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
      throw new Error(
        `OpenAI Responses HTTP ${res.status}: ${errText.slice(0, 500)}`,
      )
    }
    const json = (await res.json()) as {
      output_text?: string
      output?: Array<{
        type?: string
        content?: Array<{ type?: string; text?: string }>
      }>
    }
    if (typeof json.output_text === 'string' && json.output_text) {
      return json.output_text
    }
    // 从 output message 拼文本
    const parts: string[] = []
    for (const item of json.output ?? []) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) parts.push(c.text)
        }
      }
    }
    return parts.join('')
  }

  return {
    id: 'openai-responses',
    completeStream: streamResponses,
    completeText,
  }
}