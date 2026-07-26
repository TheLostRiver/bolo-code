/**
 * Anthropic Messages SSE → ProviderStreamEvent
 *
 * 从 `anthropic.ts` 抽出来，理由有两个：HTTP 与解析本就是两件事；
 * 以及服务端搜索没法离线测，把解析做成可喂字节流的纯函数才验得了。
 *
 * ## 最重要的不变量
 *
 * **客户端工具与服务端工具走两条完全独立的累加器。**
 *
 * `flushTools()` 会把 `clientToolByIndex` 里的每一项发成 `tool_call`，
 * 而 `tool_call` 的语义是「Bolo 去本地执行它」。Anthropic 的服务端搜索块
 * （`server_tool_use`）长得和 `tool_use` 很像——同样有 id/name、同样用
 * `input_json_delta` 累加参数——把它塞进同一个 map 是最省事的写法，
 * 后果是流末发出 `name:'web_search'` 的本地调用，Bolo 去执行一个不存在的工具。
 *
 * 所以：服务端块只进 `serverToolByIndex`，只产出 `web_search` 观测事件，
 * **永不**进入 `flushTools()`。
 */

import type { ProviderStreamEvent, ProviderUsage } from './types.ts'
import { eventsFromAnthropicSseEvent } from './anthropicEvents.ts'
import { mergeProviderUsage, parseAnthropicStreamUsage } from './sseUsage.ts'

type AnthropicSseEvent = {
  type?: string
  index?: number
  usage?: unknown
  message?: { usage?: unknown }
  content_block?: {
    type?: string
    id?: string
    name?: string
    text?: string
    thinking?: string
    tool_use_id?: string
    content?: unknown
    [key: string]: unknown
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    citation?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 服务端块类型：认得，但绝不本地执行 */
const SERVER_TOOL_BLOCK = 'server_tool_use'
const SERVER_TOOL_RESULT_BLOCKS = new Set([
  'web_search_tool_result',
  'web_search_result',
])

function readQuery(json: string): string | undefined {
  if (!json.trim()) return undefined
  try {
    const parsed = JSON.parse(json) as { query?: unknown }
    return typeof parsed.query === 'string' ? parsed.query : undefined
  } catch {
    return undefined
  }
}

function countResults(content: unknown): number {
  if (Array.isArray(content)) return content.length
  return 0
}

/**
 * 解析 Anthropic SSE 字节流。
 * 只做解析：不发请求、不管重试、不碰 abort。
 */
export async function* streamAnthropicSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ProviderStreamEvent> {
  // 本地工具：会被 flushTools 发成 tool_call（Bolo 去执行）
  const clientToolByIndex = new Map<
    number,
    { id: string; name: string; json: string }
  >()
  // 服务端工具：只做观测，永不进 flushTools
  const serverToolByIndex = new Map<
    number,
    { id: string; name: string; json: string }
  >()
  let streamUsage: ProviderUsage | null = null
  const thinkingState: {
    inThinking: boolean
    noticedUnknown?: Set<string>
  } = { inThinking: false }

  const flushTools = function* (): Generator<ProviderStreamEvent> {
    for (const tc of clientToolByIndex.values()) {
      if (!tc.name) continue
      yield {
        type: 'tool_call',
        id: tc.id || `toolu_${tc.name}`,
        name: tc.name,
        arguments: tc.json || '{}',
      }
    }
    clientToolByIndex.clear()
  }

  const reader = body.getReader()
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
      if (!data || data === '[DONE]') continue

      let evt: AnthropicSseEvent
      try {
        evt = JSON.parse(data) as AnthropicSseEvent
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
            if (thinkingState.inThinking) {
              thinkingState.inThinking = false
              yield { type: 'reasoning_end' }
            }
            clientToolByIndex.set(idx, {
              id: block.id ?? '',
              name: block.name ?? '',
              json: '',
            })
            break
          }

          if (block?.type === SERVER_TOOL_BLOCK) {
            // 独立通道：绝不进 clientToolByIndex
            serverToolByIndex.set(idx, {
              id: block.id ?? '',
              name: block.name ?? '',
              json: '',
            })
            break
          }

          if (block?.type && SERVER_TOOL_RESULT_BLOCKS.has(block.type)) {
            yield {
              type: 'web_search',
              phase: 'results',
              resultCount: countResults(block.content),
            }
            break
          }

          for (const ev of eventsFromAnthropicSseEvent(evt, thinkingState)) {
            yield ev
          }
          break
        }

        case 'content_block_delta': {
          const d = evt.delta
          if (!d) break
          const idx = evt.index ?? 0

          if (d.type === 'input_json_delta' && d.partial_json != null) {
            const client = clientToolByIndex.get(idx)
            if (client) {
              client.json += d.partial_json
              break
            }
            const server = serverToolByIndex.get(idx)
            if (server) {
              server.json += d.partial_json
              break
            }
            break
          }

          if (d.type === 'citations_delta') {
            const c = (d.citation ?? {}) as Record<string, unknown>
            const url = typeof c.url === 'string' ? c.url : undefined
            if (url) {
              yield {
                type: 'web_search',
                phase: 'citation',
                url,
                ...(typeof c.title === 'string' ? { title: c.title } : {}),
              }
            }
            break
          }

          for (const ev of eventsFromAnthropicSseEvent(evt, thinkingState)) {
            yield ev
          }
          break
        }

        case 'content_block_stop': {
          const idx = evt.index ?? 0
          const server = serverToolByIndex.get(idx)
          if (server) {
            // 服务端搜索的查询词：让用户看得见搜了什么。
            // 注意这里产出的是观测事件，**不是** tool_call。
            const query = readQuery(server.json)
            serverToolByIndex.delete(idx)
            yield {
              type: 'web_search',
              phase: 'query',
              ...(query ? { query } : {}),
            }
            break
          }
          for (const ev of eventsFromAnthropicSseEvent(evt, thinkingState)) {
            yield ev
          }
          break
        }

        case 'message_stop': {
          if (thinkingState.inThinking) {
            thinkingState.inThinking = false
            yield { type: 'reasoning_end' }
          }
          yield* flushTools()
          if (streamUsage) yield { type: 'usage', usage: streamUsage }
          yield { type: 'done' }
          return
        }

        case 'error': {
          yield { type: 'error', message: JSON.stringify(evt).slice(0, 400) }
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
}
