/**
 * Anthropic Messages API（/v1/messages + SSE）
 * 对照 HelsincyCode claude.ts 事件形态：content_block_start/delta/stop
 * 不依赖官方 SDK；无遥测。
 */

import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'
import { toolsToAnthropic as toolsToAnthropicImpl } from '../../tools/src/providerSchema.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
  ProviderUsage,
} from './types.ts'
import { mapEffort, DEFAULT_EFFORT_BASE_MAX_TOKENS } from './effort.ts'
import { mergeProviderUsage, parseAnthropicStreamUsage } from './sseUsage.ts'

export type AnthropicConfig = {
  apiKey: string
  /** 默认 https://api.anthropic.com */
  baseUrl?: string
  model: string
  maxTokens?: number
  /** 默认 2023-06-01 */
  anthropicVersion?: string
  timeoutMs?: number
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

export function createAnthropicProvider(config: AnthropicConfig): LlmProvider {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const timeoutMs = config.timeoutMs ?? 120_000
  const baseMaxTokens = config.maxTokens ?? DEFAULT_EFFORT_BASE_MAX_TOKENS
  const version = config.anthropicVersion ?? '2023-06-01'

  async function* streamMessages(
    messages: ChatMessage[],
    options?: CompleteStreamOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const { system, messages: antMessages } = toAnthropicMessages(messages)
    const url = `${baseUrl}/messages`
    const maxTokens =
      options?.maxTokens ??
      mapEffort(options?.effort, baseMaxTokens).maxTokens

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: maxTokens,
      messages: antMessages,
      stream: true,
    }
    if (system) body.system = system
    if (!options?.disableTools && options?.tools?.length) {
      body.tools = toolsToAnthropic(options.tools)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    options?.signal?.addEventListener('abort', onAbort)

    // index → accumulating tool_use
    const toolByIndex = new Map<
      number,
      { id: string; name: string; json: string }
    >()
    let streamUsage: ProviderUsage | null = null

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': version,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        yield {
          type: 'error',
          message: `Anthropic HTTP ${res.status}: ${errText.slice(0, 500)}`,
        }
        yield { type: 'done' }
        return
      }

      if (!res.body) {
        yield { type: 'error', message: 'No response body for Anthropic stream' }
        yield { type: 'done' }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const flushTools = function* (): Generator<ProviderStreamEvent> {
        for (const tc of toolByIndex.values()) {
          if (!tc.name) continue
          yield {
            type: 'tool_call',
            id: tc.id || `toolu_${tc.name}`,
            name: tc.name,
            arguments: tc.json || '{}',
          }
        }
        toolByIndex.clear()
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
          if (!data || data === '[DONE]') continue

          let evt: {
            type?: string
            index?: number
            usage?: unknown
            message?: {
              usage?: unknown
              content_block?: unknown
            }
            content_block?: {
              type?: string
              id?: string
              name?: string
              text?: string
              input?: unknown
            }
            delta?: {
              type?: string
              text?: string
              partial_json?: string
            }
          }
          try {
            evt = JSON.parse(data)
          } catch {
            continue
          }

          const u = parseAnthropicStreamUsage(evt)
          if (u) streamUsage = mergeProviderUsage(streamUsage, u)

          switch (evt.type) {
            case 'content_block_start': {
              const block = evt.content_block
              const idx = evt.index ?? 0
              if (block?.type === 'tool_use') {
                toolByIndex.set(idx, {
                  id: block.id ?? '',
                  name: block.name ?? '',
                  json: '',
                })
              }
              // text block: text 在 delta 里
              break
            }
            case 'content_block_delta': {
              const d = evt.delta
              if (!d) break
              if (d.type === 'text_delta' && d.text) {
                yield { type: 'text_delta', text: d.text }
              } else if (
                d.type === 'input_json_delta' &&
                d.partial_json != null
              ) {
                const idx = evt.index ?? 0
                const cur = toolByIndex.get(idx)
                if (cur) cur.json += d.partial_json
              }
              break
            }
            case 'content_block_stop': {
              // tool_use 在 message_stop 统一 flush，避免半截
              break
            }
            case 'message_stop': {
              yield* flushTools()
              if (streamUsage) yield { type: 'usage', usage: streamUsage }
              yield { type: 'done' }
              return
            }
            case 'error': {
              yield {
                type: 'error',
                message: JSON.stringify(evt).slice(0, 400),
              }
              break
            }
            default:
              break
          }
        }
      }

      yield* flushTools()
      if (streamUsage) yield { type: 'usage', usage: streamUsage }
      yield { type: 'done' }
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
    options?: { signal?: AbortSignal; effort?: string; maxTokens?: number },
  ): Promise<string> {
    const { system, messages: antMessages } = toAnthropicMessages(messages)
    const url = `${baseUrl}/messages`
    const maxTokens =
      options?.maxTokens ??
      mapEffort(options?.effort, baseMaxTokens).maxTokens
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: maxTokens,
      messages: antMessages,
      stream: false,
    }
    if (system) body.system = system

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': version,
      },
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