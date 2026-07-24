/**
 * OpenAI Responses — WebSocket 最小传输（OR6）
 * 默认产品路径仍是 HTTP SSE（createOpenAIResponsesProvider）。
 * WS：连 BOLO_RESPONSES_WS_URL 或 {baseUrl}/responses/ws，发一条 JSON 请求，读 text 事件。
 * 无遥测；连不上则明确失败（不静默假完成）。
 */

import type { ChatMessage } from '../../shared/src/index.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
} from './types.ts'
import { toResponsesPayload } from './openaiResponses.ts'
import type { OpenAIResponsesConfig } from './openaiResponses.ts'

function resolveWsUrl(config: OpenAIResponsesConfig): string {
  const envUrl = process.env.BOLO_RESPONSES_WS_URL?.trim()
  if (envUrl) return envUrl
  let b = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  if (b.startsWith('https://')) b = 'wss://' + b.slice('https://'.length)
  else if (b.startsWith('http://')) b = 'ws://' + b.slice('http://'.length)
  if (b.endsWith('/responses')) return b + '/ws'
  return b + '/responses/ws'
}

function extractTextFromWsJson(raw: string): string | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.delta === 'string') return o.delta
    if (typeof o.text === 'string') return o.text
    if (o.type === 'response.output_text.delta' && typeof o.delta === 'string') {
      return o.delta
    }
    if (typeof o.output_text === 'string') return o.output_text
    return null
  } catch {
    return null
  }
}

/**
 * 最小 WS provider：真实 WebSocket 握手 + 请求体；协议因网关而异。
 * 测试可注入 webSocketCtor。
 */
export function createOpenAIResponsesWsProvider(
  config?: OpenAIResponsesConfig & {
    webSocketCtor?: typeof WebSocket
  },
): LlmProvider {
  const cfg = config ?? { apiKey: '', model: 'gpt-4o-mini' }
  const Ws =
    cfg.webSocketCtor ??
    (globalThis as { WebSocket?: typeof WebSocket }).WebSocket

  return {
    id: 'openai-responses-ws',
    async *completeStream(
      messages: ChatMessage[],
      options?: CompleteStreamOptions,
    ): AsyncGenerator<ProviderStreamEvent> {
      if (!cfg.apiKey?.trim()) {
        yield {
          type: 'error',
          message: 'openai-responses-ws: missing apiKey',
        }
        yield { type: 'done' }
        return
      }
      if (!Ws) {
        yield {
          type: 'error',
          message:
            'openai-responses-ws: WebSocket not available in this runtime; use HTTP SSE (openai-responses)',
        }
        yield { type: 'done' }
        return
      }

      const url = resolveWsUrl(cfg)
      const { instructions, input } = toResponsesPayload(messages)
      const body = {
        type: 'response.create',
        model: options?.model ?? cfg.model,
        instructions,
        input,
        stream: true,
      }

      const queue: ProviderStreamEvent[] = []
      let done = false
      let err: string | null = null

      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          const ws = new Ws(url, {
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
            },
          } as unknown as string)

          const timer = setTimeout(() => {
            err = `websocket timeout: ${url}`
            try {
              ws.close()
            } catch {
              /* ignore */
            }
            finish()
          }, cfg.timeoutMs ?? 30_000)

          ws.addEventListener('open', () => {
            try {
              ws.send(JSON.stringify(body))
            } catch (e) {
              err = e instanceof Error ? e.message : String(e)
              finish()
            }
          })
          ws.addEventListener('message', (ev) => {
            const data =
              typeof ev.data === 'string' ? ev.data : String(ev.data ?? '')
            if (
              data === '[DONE]' ||
              data.includes('"type":"response.completed"')
            ) {
              done = true
              clearTimeout(timer)
              try {
                ws.close()
              } catch {
                /* ignore */
              }
              finish()
              return
            }
            const text = extractTextFromWsJson(data)
            if (text) queue.push({ type: 'text_delta', text })
            if (data.includes('failed') || data.includes('"error"')) {
              try {
                const o = JSON.parse(data) as {
                  error?: { message?: string }
                }
                if (o.error?.message) err = o.error.message
              } catch {
                /* ignore */
              }
            }
          })
          ws.addEventListener('error', () => {
            err = err ?? `websocket error: ${url}`
            clearTimeout(timer)
            finish()
          })
          ws.addEventListener('close', () => {
            clearTimeout(timer)
            finish()
          })
        } catch (e) {
          err = e instanceof Error ? e.message : String(e)
          finish()
        }
      })

      for (const e of queue) yield e
      if (err) {
        yield {
          type: 'error',
          message: `${err} (HTTP SSE remains default: openai-responses)`,
        }
      } else if (!done && queue.length === 0) {
        yield {
          type: 'error',
          message: `websocket produced no output from ${url}; use HTTP SSE provider`,
        }
      }
      yield { type: 'done' }
    },
    async completeText(messages, options) {
      let text = ''
      for await (const e of this.completeStream!(messages, options)) {
        if (e.type === 'text_delta') text += e.text
        if (e.type === 'error') throw new Error(e.message)
      }
      return text
    },
  }
}