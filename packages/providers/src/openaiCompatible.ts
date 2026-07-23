/**
 * OpenAI-compatible Chat Completions（stream + tools）
 * 兼容：OpenAI / 多数中转 / DeepSeek / 本地 vLLM 等
 * 无遥测。
 */

import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
} from './types.ts'

export type OpenAICompatibleConfig = {
  apiKey: string
  baseUrl?: string
  model: string
  /** 默认 120s */
  timeoutMs?: number
}

type OaiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string }

type OaiToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

function defaultToolParameters(name: string): Record<string, unknown> {
  switch (name) {
    case 'Bash':
      return {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
        },
        required: ['command'],
      }
    case 'Read':
      return {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to cwd' },
        },
        required: ['path'],
      }
    case 'Write':
    case 'apply_patch':
      return {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      }
    case 'Glob':
      return {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      }
    case 'Grep':
      return {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      }
    case 'Skill':
      return {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Skill id from the Available Skills catalog',
          },
        },
        required: ['skill'],
      }
    default:
      return { type: 'object', properties: {} }
  }
}

export function toolsToOpenAI(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: defaultToolParameters(t.name),
    },
  }))
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
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      })
      continue
    }
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content: m.content ?? '' })
    }
  }
  return out
}

function normalizeBaseUrl(base?: string): string {
  const b = (base ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  return b
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
): LlmProvider {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const timeoutMs = config.timeoutMs ?? 120_000

  async function* streamChat(
    messages: ChatMessage[],
    options?: CompleteStreamOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const url = `${baseUrl}/chat/completions`
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOpenAIMessages(messages),
      stream: true,
    }

    if (!options?.disableTools && options?.tools?.length) {
      body.tools = toolsToOpenAI(options.tools)
      body.tool_choice = 'auto'
    }

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

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

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
            // flush tool calls
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
            yield { type: 'done' }
            return
          }
          let json: {
            choices?: Array<{
              delta?: {
                content?: string | null
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
          const delta = json.choices?.[0]?.delta
          if (!delta) continue

          if (delta.content) {
            yield { type: 'text_delta', text: delta.content }
          }

          if (delta.tool_calls) {
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
          if (fr === 'tool_calls' || fr === 'stop') {
            if (toolAcc.size) {
              for (const tc of [...toolAcc.values()].sort()) {
                // Map iteration order is insertion order
              }
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
          }
        }
      }

      // stream ended without [DONE]
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
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    const url = `${baseUrl}/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: toOpenAIMessages(messages),
        stream: false,
      }),
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