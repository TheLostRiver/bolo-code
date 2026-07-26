/**
 * Anthropic SSE 单事件 → ProviderStreamEvent（不含 tool 累积）。
 *
 * 从 anthropic.ts 抽出：流解析与 HTTP 是两件事，且抽出后
 * anthropicStream.ts 才能引用它而不产生循环依赖。
 */

import type { ProviderStreamEvent } from './types.ts'

/**
 * 从 Anthropic Messages SSE 事件提取 text / reasoning（不含 tool 累积）。
 * 对照 HC：thinking / redacted_thinking / thinking_delta 与正文分离。
 * - thinking_delta → reasoning_delta
 * - content_block_start thinking 若带初始 thinking 文本 → reasoning_delta
 * - redacted_thinking 开始 → 单次占位（无明文时的简化摘要）
 * - content_block_stop 在 thinking 块后 → reasoning_end
 * 无思考内容则返回空数组（静默降级）。
 */
export function eventsFromAnthropicSseEvent(
  evt: {
    type?: string
    /** 块序号；本函数不用，但真实事件带着它 */
    index?: number
    // 上游会加新字段与新块类型，所以这里只声明用到的、其余放开。
    // 收窄到「刚好够用」会让调用方没法把真实事件原样传进来。
    content_block?: {
      type?: string
      thinking?: string
      text?: string
      [key: string]: unknown
    }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      [key: string]: unknown
    }
    [key: string]: unknown
  },
  state?: {
    inThinking?: boolean
    /** 已提示过的未知块/delta 类型；同类型只说一次，避免刷屏 */
    noticedUnknown?: Set<string>
  },
): ProviderStreamEvent[] {
  const out: ProviderStreamEvent[] = []
  const st = state ?? {}

  /**
   * 未知块只留痕、不解释。
   * 白名单不放宽（服务端块绝不能被当本地工具执行），但也不能静默吞掉。
   */
  const noticeUnknown = (what: string, type: string) => {
    if (!type) return
    const seen = (st.noticedUnknown ??= new Set<string>())
    const key = `${what}:${type}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      type: 'provider_notice',
      kind: 'unknown_block',
      detail: `unhandled anthropic ${what} "${type}" — this client did not surface its content`,
    })
  }

  switch (evt.type) {
    case 'content_block_start': {
      const block = evt.content_block
      if (block?.type === 'thinking') {
        st.inThinking = true
        if (block.thinking) {
          out.push({ type: 'reasoning_delta', text: block.thinking })
        }
      } else if (block?.type === 'redacted_thinking') {
        st.inThinking = true
        // 无明文：占位一行，对照 HC「无正文时 redacted 摘要」的简化
        out.push({ type: 'reasoning_delta', text: '[redacted thinking]' })
      } else if (block?.type === 'text' || block?.type === 'tool_use') {
        if (st.inThinking) {
          st.inThinking = false
          out.push({ type: 'reasoning_end' })
        }
      } else if (block?.type) {
        noticeUnknown('content block', block.type)
      }
      break
    }
    case 'content_block_delta': {
      const d = evt.delta
      if (!d) break
      if (d.type === 'thinking_delta' && d.thinking) {
        st.inThinking = true
        out.push({ type: 'reasoning_delta', text: d.thinking })
      } else if (d.type === 'text_delta' && d.text) {
        if (st.inThinking) {
          st.inThinking = false
          out.push({ type: 'reasoning_end' })
        }
        out.push({ type: 'text_delta', text: d.text })
      } else if (d.type && d.type !== 'input_json_delta') {
        // input_json_delta 由外层 tool 累加器消费，不算未处理
        noticeUnknown('content delta', d.type)
      }
      break
    }
    case 'content_block_stop': {
      if (st.inThinking) {
        st.inThinking = false
        out.push({ type: 'reasoning_end' })
      }
      break
    }
    default:
      break
  }
  return out
}
