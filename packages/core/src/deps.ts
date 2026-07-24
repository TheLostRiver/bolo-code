/**
 * QueryDeps — 对照 HelsincyCode query/deps.ts
 * 可注入 fakes；无遥测。
 *
 * prepareMessages 链顺序（对照 HC query.ts）：
 *   microcompact → auto full compact → callModel
 * callModel 若 PTL：truncate → 再 prepare → 重试（queryLoop）
 * callModel 若 429/5xx/timeout：wrapCallModelWithRetry 退避（与 PTL 正交）
 */

import {
  estimateTokens,
  microcompactMessages,
  shouldAutoCompact,
  type ChatMessage as CompactChatMessage,
  type MicrocompactOptions,
} from '../../compact/src/index.ts'
import type { LlmProvider, ProviderStreamEvent } from '../../providers/src/index.ts'
import type { ChatMessage } from '../../shared/src/index.ts'
import type { BoloTool, ToolSpec } from '../../tools/src/index.ts'
import {
  wrapCallModelWithRetry,
  type ModelRetryInfo,
  type ModelRetryOptions,
} from './modelRetry.ts'

export type CallModelFn = (req: {
  messages: ChatMessage[]
  signal?: AbortSignal
  tools?: readonly BoloTool[] | ToolSpec[]
  disableTools?: boolean
  /** session.effortLevel；透传 provider mapEffort → max_tokens */
  effort?: string
  maxTokens?: number
  /** wrapCallModelWithRetry 退避前回调 */
  onModelRetry?: (info: ModelRetryInfo) => void
}) => AsyncIterable<ProviderStreamEvent>

export type PrepareMessagesResult = {
  messages: ChatMessage[]
  /** 仅 full compact 为 true：queryLoop 会写回 session.messages */
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

export function createCallModelFromProvider(
  provider: LlmProvider,
  retry?: ModelRetryOptions | false,
): CallModelFn {
  const base: CallModelFn = async function* ({
    messages,
    signal,
    tools,
    disableTools,
    effort,
    maxTokens,
  }) {
    yield* provider.completeStream(messages, {
      signal,
      tools,
      disableTools,
      effort,
      maxTokens,
    })
  }
  if (retry === false) return base
  return wrapCallModelWithRetry(base, retry === undefined ? {} : retry)
}

export const identityPrepareMessages: PrepareMessagesFn = async ({ messages }) => ({
  messages,
})

/**
 * 串联 prepare 步骤；任一 didCompact 则结果带 didCompact。
 * 典型：micro → auto full。
 */
export function composePrepareMessages(
  ...fns: PrepareMessagesFn[]
): PrepareMessagesFn {
  const steps = fns.filter(Boolean)
  if (steps.length === 0) return identityPrepareMessages
  if (steps.length === 1) return steps[0]!
  return async (req) => {
    let messages = req.messages
    let didCompact = false
    for (const fn of steps) {
      const r = await fn({ ...req, messages })
      messages = r.messages
      if (r.didCompact) didCompact = true
    }
    return didCompact ? { messages, didCompact: true } : { messages }
  }
}

/**
 * Microcompact 挂点：清旧 tool 正文，不写回 session（仅 API 视图），不调 LLM。
 * didCompact 始终 false，避免与 full compact 写回语义混淆。
 */
export function createMicrocompactPrepare(
  options?: MicrocompactOptions,
): PrepareMessagesFn {
  return async ({ messages }) => {
    const r = microcompactMessages(messages as CompactChatMessage[], options)
    return { messages: r.messages }
  }
}

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

export function productionDeps(
  provider: LlmProvider,
  opts?: { modelRetry?: ModelRetryOptions | false },
): QueryDeps {
  return {
    callModel: createCallModelFromProvider(provider, opts?.modelRetry),
    // 默认挂 micro（便宜、无 LLM）；auto full 由 createSession 按配置叠加
    prepareMessages: createMicrocompactPrepare(),
    uuid: () =>
      `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
  }
}

export type { ModelRetryInfo, ModelRetryOptions } from './modelRetry.ts'
export {
  wrapCallModelWithRetry,
  DEFAULT_MAX_MODEL_RETRIES,
  DEFAULT_MODEL_RETRY_BASE_DELAY_MS,
} from './modelRetry.ts'