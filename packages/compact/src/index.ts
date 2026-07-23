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

/** 粗估：≈ chars/4，P1 可换模型 tokenizer */
export function estimateTokens(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) n += Math.ceil((m.content?.length ?? 0) / 4) + 4
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

  let raw: string
  try {
    const out = await input.summarize({
      messages: input.messages,
      compactPrompt,
    })
    raw = out.text?.trim() ?? ''
  } catch (e) {
    return {
      ok: false,
      reason: `summarizer failed: ${e instanceof Error ? e.message : String(e)}`,
      messagesUnchanged: true,
    }
  }

  if (!raw) {
    return { ok: false, reason: 'Empty compact summary.', messagesUnchanged: true }
  }

  const keepN = Math.max(0, input.keepRecentMessageCount ?? 0)
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

/** Auto 阈值纯函数（无遥测） */
export function getAutoCompactThreshold(contextWindowTokens: number): number {
  const reserved = Math.min(20_000, Math.floor(contextWindowTokens * 0.15))
  const effective = contextWindowTokens - reserved
  const buffer = 13_000
  return Math.max(1_000, effective - buffer)
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
  const maxFail = opts.maxConsecutiveFailures ?? 3
  if (opts.consecutiveFailures >= maxFail) return false
  return opts.tokenCount >= getAutoCompactThreshold(opts.contextWindowTokens)
}