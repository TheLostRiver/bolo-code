/**
 * 上下文压缩 — 对照 HelsincyCode services/compact 语义
 * 详见 docs/COMPACTION.md
 * 禁止：slice 删消息冒充 compact；禁止遥测
 */

import type { ChatMessage } from '../../shared/src/index.ts'

export type { ChatMessage } from '../../shared/src/index.ts'

export type CompactTrigger = 'manual' | 'auto'

export type CompactBoundaryMessage = {
  role: 'system'
  content: string
  compactMetadata: {
    trigger: CompactTrigger
    preCompactTokenCount: number
    postCompactTokenCount: number
    timestamp: string
  }
}

export type CompactionResult = {
  boundary: CompactBoundaryMessage
  summaryMessages: ChatMessage[]
  messagesToKeep: ChatMessage[]
  attachments: ChatMessage[]
  hookResults: ChatMessage[]
  summaryText: string
  preCompactTokenCount: number
  postCompactTokenCount: number
  trigger: CompactTrigger
}

/**
 * 参考 buildPostCompactMessages 固定顺序：
 * boundary → summary → keep → attachments → hookResults
 */
export function buildPostCompactMessages(result: CompactionResult): ChatMessage[] {
  return [
    {
      role: result.boundary.role,
      content: result.boundary.content,
    },
    ...result.summaryMessages,
    ...result.messagesToKeep,
    ...result.attachments,
    ...result.hookResults,
  ]
}

export function mergeHookInstructions(
  userInstructions: string | undefined,
  hookInstructions: string | undefined,
): string | undefined {
  const u = userInstructions?.trim() || undefined
  const h = hookInstructions?.trim() || undefined
  if (!h) return u
  if (!u) return h
  return `${u}\n\n${h}`
}

/**
 * 本地启发式 token 估计（非计费、非模型 tokenizer）。
 * 对照参考 roughTokenCountEstimation：正文默认 ≈chars/4；
 * JSON/高标点密文 ≈chars/2；tool_calls 计入 name+arguments。
 */
export const DEFAULT_BYTES_PER_TOKEN = 4
/** JSON 类密文：单字符 token 更多，低估会拖晚 auto compact */
export const DENSE_BYTES_PER_TOKEN = 2
export const ROLE_OVERHEAD_TOKENS = 4
export const TOOL_CALL_OVERHEAD_TOKENS = 8

/** 是否按「密文」估（JSON / 高标点） */
export function looksDenseTokenText(text: string): boolean {
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return true
  if (text.length < 40) return false
  const sample = Math.min(text.length, 400)
  let punct = 0
  for (let i = 0; i < sample; i++) {
    const c = text[i]!
    if (
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']' ||
      c === '"' ||
      c === "'" ||
      c === ':' ||
      c === ',' ||
      c === '\\' ||
      c === ';'
    ) {
      punct += 1
    }
  }
  return punct / sample > 0.12
}

/** 单段文本粗估 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const bpt = looksDenseTokenText(text)
    ? DENSE_BYTES_PER_TOKEN
    : DEFAULT_BYTES_PER_TOKEN
  return Math.ceil(text.length / bpt)
}

/** 单条消息（含 tool_calls / tool_call_id 开销） */
export function estimateMessageTokens(m: ChatMessage): number {
  let n = ROLE_OVERHEAD_TOKENS + estimateTextTokens(m.content ?? '')
  if (m.tool_call_id) n += 2
  if (m.name) n += estimateTextTokens(m.name)
  if (m.tool_calls?.length) {
    for (const tc of m.tool_calls) {
      n += TOOL_CALL_OVERHEAD_TOKENS
      n += estimateTextTokens(tc.name ?? '')
      // arguments 多为 JSON → 密文权重
      n += estimateTextTokens(tc.arguments ?? '')
    }
  }
  return n
}

/** 对话 messages 粗估（auto compact / PTL / boundary 共用） */
export function estimateTokens(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) n += estimateMessageTokens(m)
  return n
}

/** systemPromptSections 粗估（/context 与 messages 合计压力） */
export function estimateSystemSectionsTokens(
  sections: readonly string[],
): number {
  let n = 0
  for (const s of sections) {
    n += estimateTextTokens(s) + 2
  }
  return n
}

/**
 * 去掉 analysis 草稿，提取 summary 正文
 * 对齐 formatCompactSummary
 */
export function formatCompactSummary(raw: string): string {
  let s = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, '')
  const m = s.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (m) {
    s = s.replace(/<summary>[\s\S]*?<\/summary>/i, `Summary:\n${(m[1] || '').trim()}`)
  }
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Full compact 用 prompt（语义对齐参考 BASE_COMPACT_PROMPT，自维护文案）
 * Summarizer 必须 no-tools。
 */
export function getCompactPrompt(customInstructions?: string): string {
  let prompt = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be rejected. Your entire response must be plain text:
an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of the conversation so far,
paying close attention to the user's explicit requests and your previous actions.
Capture technical details, code patterns, and decisions needed to continue work.

Before the final summary, wrap drafting in <analysis> tags. In analysis:
1. Chronologically review the conversation for user intents, your approach,
   decisions, file names, code snippets, errors and fixes, and user feedback.
2. Check technical accuracy and completeness.

Then produce <summary> with these sections:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (paths, why important, key snippets)
4. Errors and fixes
5. Problem Solving
6. All user messages (non-tool-result)
7. Pending Tasks
8. Current Work (immediately before this summary)
9. Optional Next Step (only if aligned with the user's most recent explicit request)

Example shape:
<analysis>
...
</analysis>
<summary>
1. Primary Request and Intent:
   ...
</summary>
`

  if (customInstructions?.trim()) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions.trim()}`
  }

  prompt += `\n\nAgain: TEXT ONLY. No tools. Output <analysis> then <summary>.`
  return prompt
}

export function getCompactUserSummaryMessage(
  summary: string,
  opts?: { suppressFollowUpQuestions?: boolean; recentMessagesPreserved?: boolean },
): string {
  const formatted = formatCompactSummary(summary)
  let base = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${formatted}`
  if (opts?.recentMessagesPreserved) {
    base += `\n\nRecent messages are preserved verbatim.`
  }
  if (opts?.suppressFollowUpQuestions) {
    base += `\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`
  }
  return base
}

export type CompactSummarizer = (req: {
  messages: ChatMessage[]
  compactPrompt: string
}) => Promise<{ text: string }>

export type FullCompactInput = {
  messages: ChatMessage[]
  trigger: CompactTrigger
  /** 用户 /compact 附加说明 */
  customInstructions?: string
  /** PreCompact hooks 合并后的指令 */
  hookInstructions?: string
  /** 无 summarizer 时必须失败，禁止 truncate 冒充 */
  summarize: CompactSummarizer
  /** 后缀保留条数（按 message 条，P0.5 可改为按 turn）；0 = 全量摘要 */
  keepRecentMessageCount?: number
  suppressFollowUpQuestions?: boolean
  /**
   * summarizer 自身 PTL 时截断最旧轮次再试的次数。
   * 默认 DEFAULT_MAX_PTL_RETRIES（3）；0 = 不重试。
   * 仅改 summarizer 入参副本，不改调用方 messages。
   */
  maxPtlRetries?: number
}

export type FullCompactFailure = {
  ok: false
  reason: string
  /** 始终为 true：失败不得改调用方 messages */
  messagesUnchanged: true
}

export type FullCompactSuccess = {
  ok: true
  result: CompactionResult
  apiMessages: ChatMessage[]
}

/**
 * Full compact 核心（纯管道）。
 * 不跑 hooks（由 core 调 Pre/Post 后传入 hookInstructions / 成功后再 Post）。
 */
export async function runFullCompact(
  input: FullCompactInput,
): Promise<FullCompactSuccess | FullCompactFailure> {
  if (!input.messages.length) {
    return { ok: false, reason: 'Not enough messages to compact.', messagesUnchanged: true }
  }
  if (typeof input.summarize !== 'function') {
    return {
      ok: false,
      reason: 'CompactSummarizer required; refusing to truncate messages.',
      messagesUnchanged: true,
    }
  }

  const preCompactTokenCount = estimateTokens(input.messages)
  const instructions = mergeHookInstructions(
    input.customInstructions,
    input.hookInstructions,
  )
  const compactPrompt = getCompactPrompt(instructions)
  const maxPtl =
    input.maxPtlRetries === undefined
      ? DEFAULT_MAX_PTL_RETRIES
      : Math.max(0, input.maxPtlRetries)

  // 对照 HC compactConversation：summarizer 命中 PTL 时截断最旧 API 轮次再试
  let messagesToSummarize = input.messages
  let raw: string | undefined
  let lastError: string | undefined
  let ptlAttempts = 0

  for (;;) {
    try {
      const out = await input.summarize({
        messages: messagesToSummarize,
        compactPrompt,
      })
      raw = out.text?.trim() ?? ''
      break
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      if (!isPromptTooLongError(e) || ptlAttempts >= maxPtl) {
        return {
          ok: false,
          reason: `summarizer failed: ${lastError}`,
          messagesUnchanged: true,
        }
      }
      ptlAttempts += 1
      const truncated = truncateHeadForPtlRetry(messagesToSummarize)
      if (!truncated) {
        return {
          ok: false,
          reason: `summarizer failed (PTL, cannot truncate further): ${lastError}`,
          messagesUnchanged: true,
        }
      }
      messagesToSummarize = truncated.messages
    }
  }

  if (!raw) {
    return { ok: false, reason: 'Empty compact summary.', messagesUnchanged: true }
  }

  const keepN = Math.max(0, input.keepRecentMessageCount ?? 0)
  // 后缀保留仍相对调用方原 messages（失败不毁原会话）
  const messagesToKeep =
    keepN > 0 ? input.messages.slice(-keepN) : []

  const summaryBody = getCompactUserSummaryMessage(raw, {
    suppressFollowUpQuestions: input.suppressFollowUpQuestions ?? input.trigger === 'auto',
    recentMessagesPreserved: messagesToKeep.length > 0,
  })

  const summaryMessages: ChatMessage[] = [
    { role: 'user', content: summaryBody },
  ]

  const postCompactTokenCount = estimateTokens([
    ...summaryMessages,
    ...messagesToKeep,
  ])

  const boundary: CompactBoundaryMessage = {
    role: 'system',
    content: 'Conversation compacted',
    compactMetadata: {
      trigger: input.trigger,
      preCompactTokenCount,
      postCompactTokenCount,
      timestamp: new Date().toISOString(),
    },
  }

  const result: CompactionResult = {
    boundary,
    summaryMessages,
    messagesToKeep,
    attachments: [],
    hookResults: [],
    summaryText: formatCompactSummary(raw),
    preCompactTokenCount,
    postCompactTokenCount,
    trigger: input.trigger,
  }

  return {
    ok: true,
    result,
    apiMessages: buildPostCompactMessages(result),
  }
}

/**
 * Auto 阈值纯函数（无遥测）。
 * 对照参考 autoCompact：
 *   effectiveWindow = contextWindow - reservedForSummary
 *   autoThreshold   = effectiveWindow - AUTOCOMPACT_BUFFER
 * 仅在「临近窗口」才触发，避免过早 full compact。
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
/** 为摘要输出预留的上限（与窗口 15% 取 min） */
export const RESERVED_SUMMARY_TOKENS_CAP = 20_000
export const RESERVED_SUMMARY_FRACTION = 0.15
/** 距 auto 阈值还差这么多时进入 warn（UI /context；不强制 compact） */
export const WARNING_BUFFER_TOKENS = 20_000
/** 连续 auto 失败熔断默认 */
export const DEFAULT_MAX_AUTOCOMPACT_FAILURES = 3

/** 扣掉摘要预留后的有效窗口 */
export function getEffectiveContextWindow(contextWindowTokens: number): number {
  const w = Math.max(1, Math.floor(contextWindowTokens))
  const reserved = Math.min(
    RESERVED_SUMMARY_TOKENS_CAP,
    Math.floor(w * RESERVED_SUMMARY_FRACTION),
  )
  return Math.max(1, w - reserved)
}

export function getAutoCompactThreshold(contextWindowTokens: number): number {
  const effective = getEffectiveContextWindow(contextWindowTokens)
  return Math.max(1_000, effective - AUTOCOMPACT_BUFFER_TOKENS)
}

export type ContextPressureLevel = 'ok' | 'warn' | 'critical' | 'over'

export type ContextPressure = {
  tokenCount: number
  contextWindowTokens: number
  effectiveWindow: number
  autoThreshold: number
  /** 相对配置窗口 0–100+ */
  percentOfWindow: number
  /** 相对 auto 阈值 0–100+ */
  percentOfThreshold: number
  level: ContextPressureLevel
  /** 仅阈值，不含 enabled / 熔断 / querySource */
  aboveAutoThreshold: boolean
}

/**
 * 上下文压力（/context、诊断用；无遥测）。
 * level：ok → warn（接近阈值）→ critical（达 auto 阈值）→ over（≥ 配置窗口）
 */
export function getContextPressure(opts: {
  tokenCount: number
  contextWindowTokens: number
}): ContextPressure {
  const contextWindowTokens = Math.max(1, Math.floor(opts.contextWindowTokens))
  const tokenCount = Math.max(0, Math.floor(opts.tokenCount))
  const effectiveWindow = getEffectiveContextWindow(contextWindowTokens)
  const autoThreshold = getAutoCompactThreshold(contextWindowTokens)
  const percentOfWindow = Math.round(
    (tokenCount / contextWindowTokens) * 100,
  )
  const percentOfThreshold = Math.round(
    (tokenCount / Math.max(1, autoThreshold)) * 100,
  )
  // 小窗口时 20k buffer 会盖住阈值；用 max(阈值-buffer, 80%阈值)
  const warnLine = Math.max(
    autoThreshold - WARNING_BUFFER_TOKENS,
    Math.floor(autoThreshold * 0.8),
  )
  let level: ContextPressureLevel = 'ok'
  if (tokenCount >= contextWindowTokens) level = 'over'
  else if (tokenCount >= autoThreshold) level = 'critical'
  else if (tokenCount >= warnLine) level = 'warn'

  return {
    tokenCount,
    contextWindowTokens,
    effectiveWindow,
    autoThreshold,
    percentOfWindow,
    percentOfThreshold,
    level,
    aboveAutoThreshold: tokenCount >= autoThreshold,
  }
}

export function shouldAutoCompact(opts: {
  tokenCount: number
  contextWindowTokens: number
  enabled: boolean
  consecutiveFailures: number
  maxConsecutiveFailures?: number
  querySource?: string
}): boolean {
  if (!opts.enabled) return false
  if (opts.querySource === 'compact') return false
  const maxFail = opts.maxConsecutiveFailures ?? DEFAULT_MAX_AUTOCOMPACT_FAILURES
  if (opts.consecutiveFailures >= maxFail) return false
  return opts.tokenCount >= getAutoCompactThreshold(opts.contextWindowTokens)
}

// ── PTL（prompt too long）识别 + 截断重试（对照 HC compact.ts / errors.ts）──

/** 对照 HC MAX_PTL_RETRIES；0 = 关闭 */
export const DEFAULT_MAX_PTL_RETRIES = 3

/** 截断后若以 assistant 开头，前插合成 user（对照 HC PTL_RETRY_MARKER） */
export const PTL_RETRY_MARKER =
  '[earlier conversation truncated for PTL retry]'

/**
 * 启发式：何种错误算「上下文过长」。
 *
 * 字符串（小写匹配，任一命中）：
 * - `prompt is too long`（Anthropic / Vertex）
 * - `context_length_exceeded` / `maximum context length`（OpenAI 系）
 * - `input is too long` / `request too large`
 * - `context window` 且含 exceed|over|limit
 * - `too many tokens`（输入侧）
 *
 * 可选 status：
 * - `413` 一律视为 PTL
 * - `400` 仅当正文也命中上述字符串时（避免把普通 invalid_request 当成 PTL）
 *
 * 不把纯 `max_tokens` 输出上限、鉴权/429 当成 PTL。
 */
export function isPromptTooLongError(
  error: unknown,
  opts?: { status?: number },
): boolean {
  const status =
    opts?.status ??
    (typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
      ? (error as { status: number }).status
      : extractHttpStatusFromMessage(errorToMessage(error)))

  const msg = errorToMessage(error).toLowerCase()

  if (status === 413) return true

  const stringHit = matchesPtlMessage(msg)
  if (status === 400) return stringHit
  return stringHit
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return String(error ?? '')
}

function extractHttpStatusFromMessage(message: string): number | undefined {
  // 例：OpenAI-compatible HTTP 413: ... / Anthropic HTTP 400: ...
  const m = message.match(/\bHTTP\s+(\d{3})\b/i)
  if (!m) return undefined
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : undefined
}

function matchesPtlMessage(msgLower: string): boolean {
  if (msgLower.includes('prompt is too long')) return true
  if (msgLower.includes('context_length_exceeded')) return true
  if (msgLower.includes('maximum context length')) return true
  if (msgLower.includes('input is too long')) return true
  if (msgLower.includes('request too large')) return true
  if (msgLower.includes('too many tokens')) return true
  if (
    msgLower.includes('context window') &&
    (msgLower.includes('exceed') ||
      msgLower.includes('over') ||
      msgLower.includes('limit'))
  ) {
    return true
  }
  // OpenAI 常见：input length and max_tokens exceed context limit
  if (
    msgLower.includes('exceed context limit') ||
    msgLower.includes('exceeds the context')
  ) {
    return true
  }
  return false
}

/**
 * 按「API 轮次」分组：每个新的 assistant 开启一组（含其前的 user / 后的 tool）。
 * 对照 HC groupMessagesByApiRound（Bolo 无 message.id，每条 assistant 视为新一轮）。
 */
export function groupMessagesByApiRound(
  messages: ChatMessage[],
): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  let current: ChatMessage[] = []
  let currentHasAssistant = false

  for (const msg of messages) {
    if (msg.role === 'assistant' && current.length > 0 && currentHasAssistant) {
      groups.push(current)
      current = [msg]
      currentHasAssistant = true
    } else {
      current.push(msg)
      if (msg.role === 'assistant') currentHasAssistant = true
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

export type TruncatePtlResult = {
  messages: ChatMessage[]
  /** 丢掉的消息条数 */
  droppedMessageCount: number
  /** 丢掉的 API 轮次数 */
  droppedGroupCount: number
}

/**
 * PTL 截断：丢最旧 API 轮次，保留 system 前缀 / compact boundary / 最近对话。
 *
 * 策略：
 * 1. 剥掉上次重试的合成 marker
 * 2. 前缀：连续 leading system（含 content === `Conversation compacted` 的 boundary）
 * 3. 主体按 API 轮次分组；丢掉最旧若干组
 *    - 若能解析 tokenGap：累计丢到覆盖 gap
 *    - 否则丢约 20% 组（至少 1 组）
 * 4. 至少保留 1 组主体；主体若以 assistant 开头则前插 PTL_RETRY_MARKER user
 *
 * 返回 null：无法再截（主体不足 2 组，或 drop 后为空）
 */
export function truncateHeadForPtlRetry(
  messages: ChatMessage[],
  opts?: {
    /** 报错里解析的超限 token 数；未知则按比例丢 */
    tokenGap?: number
    /** 无 gap 时丢弃组比例，默认 0.2 */
    dropFraction?: number
  },
): TruncatePtlResult | null {
  const input = stripPtlRetryMarker(messages)

  const prefix: ChatMessage[] = []
  let i = 0
  while (i < input.length && input[i]!.role === 'system') {
    prefix.push(input[i]!)
    i += 1
  }
  const body = input.slice(i)
  if (body.length === 0) return null

  const groups = groupMessagesByApiRound(body)
  if (groups.length < 2) return null

  const tokenGap = opts?.tokenGap
  let dropCount: number
  if (tokenGap !== undefined && tokenGap > 0) {
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += estimateTokens(g)
      dropCount += 1
      if (acc >= tokenGap) break
    }
  } else {
    const frac = opts?.dropFraction ?? 0.2
    dropCount = Math.max(1, Math.floor(groups.length * frac))
  }

  // 至少留 1 组可续聊
  dropCount = Math.min(dropCount, groups.length - 1)
  if (dropCount < 1) return null

  const dropped = groups.slice(0, dropCount)
  let kept = groups.slice(dropCount).flat()
  const droppedMessageCount = dropped.reduce((n, g) => n + g.length, 0)

  if (kept.length === 0) return null

  if (kept[0]?.role === 'assistant') {
    kept = [{ role: 'user', content: PTL_RETRY_MARKER }, ...kept]
  }

  return {
    messages: [...prefix, ...kept],
    droppedMessageCount,
    droppedGroupCount: dropCount,
  }
}

function stripPtlRetryMarker(messages: ChatMessage[]): ChatMessage[] {
  // 去掉任意 leading system 之后紧跟的合成 marker（或消息[0] 即为 marker）
  let i = 0
  while (i < messages.length && messages[i]!.role === 'system') i += 1
  if (
    i < messages.length &&
    messages[i]!.role === 'user' &&
    messages[i]!.content === PTL_RETRY_MARKER
  ) {
    return [...messages.slice(0, i), ...messages.slice(i + 1)]
  }
  return messages
}

// ── Microcompact（清旧 tool_result，无 LLM）────────────────────────

/** 与 HC TIME_BASED_MC_CLEARED_MESSAGE / TOOL_RESULT_CLEARED_MESSAGE 对齐 */
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

export type MicrocompactOptions = {
  /** 默认 true */
  enabled?: boolean
  /**
   * 保留最近 N 条 role:tool 全文；更早的替换为占位。
   * 至少 1（与 HC keepRecent 下限一致）。默认 4。
   */
  keepRecentToolResults?: number
  /**
   * 单条 tool 结果超过此字符数时截断（含「最近 N 条」）。
   * 0 = 不按字符截断。默认 50_000。
   */
  maxToolResultChars?: number
  /**
   * 可选：仅清理这些工具名对应的结果（按前序 assistant.tool_calls 匹配）。
   * 未设则清理全部 role:tool。
   */
  compactableToolNames?: readonly string[]
}

export type MicrocompactResult = {
  messages: ChatMessage[]
  clearedToolUseIds: string[]
  truncatedToolUseIds: string[]
  /** 粗估节省 tokens（与 estimateTextTokens 一致） */
  tokensSavedEstimate: number
}

export const DEFAULT_MICROCOMPACT_OPTIONS: Required<
  Pick<MicrocompactOptions, 'enabled' | 'keepRecentToolResults' | 'maxToolResultChars'>
> = {
  enabled: true,
  keepRecentToolResults: 4,
  maxToolResultChars: 50_000,
}

function isClearedPlaceholder(content: string): boolean {
  return content.trim() === TOOL_RESULT_CLEARED_MESSAGE
}

function truncateToolContent(content: string, maxChars: number): string {
  if (maxChars <= 0 || content.length <= maxChars) return content
  const head = content.slice(0, maxChars)
  return `${head}\n\n…[tool result truncated: ${content.length} chars → ${maxChars}]`
}

/**
 * 解析 tool_call_id → tool name（最近一次同 id 的 assistant tool_calls 为准）
 */
function buildToolNameById(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue
    for (const tc of m.tool_calls) {
      if (tc.id) map.set(tc.id, tc.name)
    }
  }
  return map
}

/**
 * Microcompact：不调用 LLM，只清/截旧 tool 结果正文。
 * 对照 HC microcompactMessages 的 content-clear 语义（无 cache_edits / 无遥测）。
 *
 * - 保留最近 keepRecentToolResults 条可压缩 tool 全文
 * - 更早的替换为 TOOL_RESULT_CLEARED_MESSAGE
 * - 可选 maxToolResultChars 对保留条做截断
 * - 不删除消息、不改 role / tool_call_id
 */
export function microcompactMessages(
  messages: ChatMessage[],
  options?: MicrocompactOptions,
): MicrocompactResult {
  const enabled = options?.enabled ?? DEFAULT_MICROCOMPACT_OPTIONS.enabled
  if (!enabled || messages.length === 0) {
    return {
      messages,
      clearedToolUseIds: [],
      truncatedToolUseIds: [],
      tokensSavedEstimate: 0,
    }
  }

  const keepRecent = Math.max(
    1,
    options?.keepRecentToolResults ?? DEFAULT_MICROCOMPACT_OPTIONS.keepRecentToolResults,
  )
  const maxChars =
    options?.maxToolResultChars ?? DEFAULT_MICROCOMPACT_OPTIONS.maxToolResultChars
  const nameById = buildToolNameById(messages)
  const nameFilter = options?.compactableToolNames?.length
    ? new Set(options.compactableToolNames)
    : null

  type ToolHit = { index: number; id: string }
  const hits: ToolHit[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'tool') continue
    const id = m.tool_call_id ?? `idx_${i}`
    if (nameFilter) {
      const name = nameById.get(id)
      // 无法解析名时保守：仍可清理（Bolo 简化消息模型）
      if (name && !nameFilter.has(name)) continue
    }
    hits.push({ index: i, id })
  }

  if (hits.length === 0) {
    return {
      messages,
      clearedToolUseIds: [],
      truncatedToolUseIds: [],
      tokensSavedEstimate: 0,
    }
  }

  const keepSet = new Set(hits.slice(-keepRecent).map((h) => h.index))
  const clearedToolUseIds: string[] = []
  const truncatedToolUseIds: string[] = []
  let tokensSavedEstimate = 0
  let changed = false

  const next = messages.map((m, i) => {
    if (m.role !== 'tool') return m
    if (!hits.some((h) => h.index === i)) return m

    const id = m.tool_call_id ?? `idx_${i}`
    const content = m.content ?? ''

    if (!keepSet.has(i)) {
      if (isClearedPlaceholder(content)) return m
      tokensSavedEstimate += Math.max(
        0,
        estimateTextTokens(content) -
          estimateTextTokens(TOOL_RESULT_CLEARED_MESSAGE),
      )
      clearedToolUseIds.push(id)
      changed = true
      return {
        ...m,
        content: TOOL_RESULT_CLEARED_MESSAGE,
      }
    }

    // 最近 N 条：可选按字符截断
    if (maxChars > 0 && content.length > maxChars && !isClearedPlaceholder(content)) {
      const truncated = truncateToolContent(content, maxChars)
      tokensSavedEstimate += Math.max(
        0,
        estimateTextTokens(content) - estimateTextTokens(truncated),
      )
      truncatedToolUseIds.push(id)
      changed = true
      return { ...m, content: truncated }
    }

    return m
  })

  return {
    messages: changed ? next : messages,
    clearedToolUseIds,
    truncatedToolUseIds,
    tokensSavedEstimate,
  }
}