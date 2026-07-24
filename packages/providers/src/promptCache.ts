/**
 * Prompt cache 请求标记（API 真·cache 接线）
 *
 * 对照 HelsincyCode：
 * - getCacheControl → ephemeral cache_control
 * - buildSystemPromptBlocks → system 文本块 + 断点
 * - addCacheBreakpoints → 消息末尾单一断点
 *
 * Bolo 最小可用：无 TTL / global scope / 遥测 / cached microcompact / break detection。
 * 前缀稳定布局仍由 core systemPrompt 负责（见 docs/PROMPT_CACHE.md）。
 */

import { createHash } from 'node:crypto'
import type { ChatMessage } from '../../shared/src/index.ts'

/** Anthropic Messages：ephemeral 缓存控制（最小形状） */
export type AnthropicCacheControl = {
  type: 'ephemeral'
}

export type AnthropicSystemTextBlock = {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

/** 与 HC getCacheControl 对齐的最小版：仅 type ephemeral */
export function getCacheControl(): AnthropicCacheControl {
  return { type: 'ephemeral' }
}

/**
 * 按 core 布局约定，在 `# Environment` 处切开 stable / volatile。
 * 无边界时整段视为可标 cache 的 system。
 */
export function partitionSystemForCache(system: string): {
  stable: string
  volatile: string
} {
  const text = system.trim()
  if (!text) return { stable: '', volatile: '' }
  const marker = '# Environment'
  const idx = text.indexOf(marker)
  if (idx <= 0) return { stable: text, volatile: '' }
  return {
    stable: text.slice(0, idx).trimEnd(),
    volatile: text.slice(idx).trim(),
  }
}

/**
 * system 字符串 → Anthropic system 文本块数组。
 * 稳定段末尾打 cache_control；volatile 接在后面（不单独再打断点，省配额）。
 */
export function buildAnthropicSystemBlocks(
  system: string | undefined,
  enablePromptCaching = true,
): AnthropicSystemTextBlock[] | undefined {
  if (!system?.trim()) return undefined
  const { stable, volatile } = partitionSystemForCache(system)
  const blocks: AnthropicSystemTextBlock[] = []
  if (stable) {
    blocks.push({
      type: 'text',
      text: stable,
      ...(enablePromptCaching ? { cache_control: getCacheControl() } : {}),
    })
  }
  if (volatile) {
    blocks.push({ type: 'text', text: volatile })
  }
  return blocks.length ? blocks : undefined
}

type ContentBlockLike = Record<string, unknown> & { type?: string }

/**
 * 在 tools 数组最后一项打 cache_control（HC 常见：tools 边界断点）。
 * 不修改入参数组引用外的原对象时可返回新数组。
 */
export function withToolsCacheBreakpoint<T extends Record<string, unknown>>(
  tools: T[],
  enablePromptCaching = true,
): T[] {
  if (!enablePromptCaching || tools.length === 0) return tools
  const last = tools.length - 1
  return tools.map((t, i) =>
    i === last ? { ...t, cache_control: getCacheControl() } : t,
  )
}

/**
 * 在 messages 最后一条的最后一个 content 块上打 cache_control。
 * 对照 HC addCacheBreakpoints：每请求恰好一个消息级断点。
 */
export function addMessageCacheBreakpoint<
  M extends { role: string; content: string | ContentBlockLike[] },
>(messages: M[], enablePromptCaching = true): M[] {
  if (!enablePromptCaching || messages.length === 0) return messages
  const idx = messages.length - 1
  return messages.map((msg, i) => {
    if (i !== idx) return msg
    if (typeof msg.content === 'string') {
      return {
        ...msg,
        content: [
          {
            type: 'text',
            text: msg.content,
            cache_control: getCacheControl(),
          },
        ],
      } as M
    }
    if (!Array.isArray(msg.content) || msg.content.length === 0) return msg
    const blocks = msg.content.map((b, bi) =>
      bi === msg.content.length - 1
        ? { ...b, cache_control: getCacheControl() }
        : b,
    )
    return { ...msg, content: blocks } as M
  })
}

/**
 * 从 messages 中的 system 内容 + model 派生稳定 prompt_cache_key。
 * OpenAI Chat Completions / Responses 可选字段；网关不支持时由调用方关闭。
 */
export function derivePromptCacheKey(
  messages: ChatMessage[],
  model: string,
): string {
  const systemParts = messages
    .filter((m) => m.role === 'system' && m.content?.trim())
    .map((m) => m.content!.trim())
  const { stable } = partitionSystemForCache(systemParts.join('\n\n'))
  const material = `${model}\n${stable || systemParts.join('\n\n') || 'empty'}`
  const hash = createHash('sha256').update(material, 'utf8').digest('hex')
  return `bolo_${hash.slice(0, 24)}`
}

/** CompleteStreamOptions / 构建 body 时是否启用 API cache 标记（默认开） */
export function isPromptCachingEnabled(options?: {
  enablePromptCaching?: boolean
}): boolean {
  return options?.enablePromptCaching !== false
}