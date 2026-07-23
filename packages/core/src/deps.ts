/**
 * QueryDeps — 对照 HelsincyCode query/deps.ts
 * 可注入 fakes；无遥测。
 */

import {
  estimateTokens,
  shouldAutoCompact,
  type ChatMessage as CompactChatMessage,
} from '../../compact/src/index.ts'
import type { LlmProvider, ProviderStreamEvent } from '../../providers/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { ToolSpec } from '../../tools/src/index.ts'

export type CallModelFn = (req: {
  messages: ChatMessage[]
  signal?: AbortSignal
  tools?: ToolSpec[]
  disableTools?: boolean
}) => AsyncIterable<ProviderStreamEvent>

export type PrepareMessagesResult = {
  messages: ChatMessage[]
  didCompact?: boolean
}

export type PrepareMessagesFn = (req: {
  messages: ChatMessage[]
  querySource: string
  tokenCount: number
}) => Promise<PrepareMessagesResult>

export type QueryDeps = {
  callModel: CallModelFn
  prepareMessages: PrepareMessagesFn
  uuid: () => string
}

export function createCallModelFromProvider(provider: LlmProvider): CallModelFn {
  return async function* ({ messages, signal, tools, disableTools }) {
    yield* provider.completeStream(messages, { signal, tools, disableTools })
  }
}

export const identityPrepareMessages: PrepareMessagesFn = async ({ messages }) => ({
  messages,
})

export function createAutoCompactPrepare(opts: {
  enabled: boolean
  contextWindowTokens: number
  runAutoCompact: (messages: ChatMessage[]) => Promise<ChatMessage[] | null>
}): PrepareMessagesFn {
  let failures = 0
  return async ({ messages, querySource }) => {
    if (!opts.enabled) return { messages }
    const tokenCount = estimateTokens(messages as CompactChatMessage[])
    if (
      !shouldAutoCompact({
        tokenCount,
        contextWindowTokens: opts.contextWindowTokens,
        enabled: true,
        consecutiveFailures: failures,
        querySource,
      })
    ) {
      return { messages }
    }
    try {
      const next = await opts.runAutoCompact(messages)
      if (!next) {
        failures += 1
        return { messages }
      }
      failures = 0
      return { messages: next, didCompact: true }
    } catch {
      failures += 1
      return { messages }
    }
  }
}

export function productionDeps(provider: LlmProvider): QueryDeps {
  return {
    callModel: createCallModelFromProvider(provider),
    prepareMessages: identityPrepareMessages,
    uuid: () =>
      `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
  }
}