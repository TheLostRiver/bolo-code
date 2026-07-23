/**
 * 从 LlmProvider 生成 CompactSummarizer（no-tools 文本 completion）
 * 见 docs/COMPACTION.md
 */

import type { CompactSummarizer } from '../../compact/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { LlmProvider } from './types.ts'

export function createCompactSummarizerFromProvider(
  provider: LlmProvider,
): CompactSummarizer {
  return async ({ messages, compactPrompt }) => {
    const req: ChatMessage[] = [
      ...messages,
      { role: 'user', content: compactPrompt },
    ]

    if (provider.completeText) {
      const text = await provider.completeText(req)
      return { text }
    }

    // fallback: 流式拼文本，禁用 tools
    let text = ''
    for await (const ev of provider.completeStream(req, { disableTools: true })) {
      if (ev.type === 'text_delta') text += ev.text
      if (ev.type === 'error') throw new Error(ev.message)
    }
    return { text }
  }
}