/**
 * 从 LlmProvider 生成 CompactSummarizer（no-tools 文本 completion）
 * 见 docs/COMPACTION.md
 * CMP-1：`options.model` 覆盖本轮模型（压缩专用模型）；缺省用 provider 配置。
 */

import type { CompactSummarizer } from '../../compact/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { LlmProvider } from './types.ts'

export function createCompactSummarizerFromProvider(
  provider: LlmProvider,
  options?: { model?: string },
): CompactSummarizer {
  return async ({ messages, compactPrompt }) => {
    const req: ChatMessage[] = [
      ...messages,
      { role: 'user', content: compactPrompt },
    ]

    // 指定压缩专用模型时走流式分支（completeText 不支持模型覆盖）；
    // 无覆盖时保持原有 completeText 优先语义。
    if (!options?.model) {
      if (provider.completeText) {
        const text = await provider.completeText(req)
        return { text }
      }
    }

    // fallback: 流式拼文本，禁用 tools；CMP-1 可覆盖 model
    let text = ''
    for await (const ev of provider.completeStream(req, {
      disableTools: true,
      ...(options?.model ? { model: options.model } : {}),
    })) {
      if (ev.type === 'text_delta') text += ev.text
      if (ev.type === 'error') throw new Error(ev.message)
    }
    return { text }
  }
}