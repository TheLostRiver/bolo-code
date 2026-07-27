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
    /** AR2A0b：本次摘要合并了历史中的旧 summary（本地可观测，非遥测） */
    mergedPriorSummary?: boolean
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
/**
 * 非散文的非 CJK 文本每 token 约合多少字符。
 *
 * 实测（见 `scripts/live-token-calibration.ts`）三类非散文语料的真实比例：
 *
 * | 语料 | 字符/token |
 * |------|------------|
 * | JSON 工具 schema | 4.18 |
 * | TypeScript 代码 | 3.77 |
 * | 日志 / 路径 / 堆栈 | **3.31** |
 *
 * 3.5 贴着最密的那一类（日志）取，因为两个方向的代价不对称：
 * 低估会让 auto compact 迟触发、撞 provider 硬上限；高估只是提前压缩。
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.5

/**
 * 散文（自然语言）每 token 约合多少字符。
 *
 * 英文散文实测 **4.96** 字符/token，且是全部语料里唯一拿到**两家
 * tokenizer 一致读数**的（DeepSeek 56 / GPT-5.6 55，差 2%）。取 4.5
 * 留 ~9% 保守余量。
 *
 * 分这一类的理由是实测出来的：散文按 3.5 算**高估 41%**，
 * 而它在真实会话里占比不小（用户提问、模型回答、文档）。
 * 高估不会炸，但会让 auto compact 提前开火——白花摘要调用、少留原文。
 */
export const PROSE_CHARS_PER_TOKEN = 4.5

/**
 * 是否按「散文」估。
 *
 * 这里曾经是 `looksDenseTokenText`，把 JSON/高标点归为「密文」并给它更小的
 * 字符/token。**实测推翻了那个前提**：JSON 真实 4.18 字符/token，是非散文里
 * 最**稀**的一类（BPE 对重复 key 压得很好），而标点最少的日志反而最密。
 * 所以「标点多 = token 密」是错的，密文类被删除；真正分得开的是
 * **散文 4.96 vs 其余 3.3–4.2**。
 *
 * 判别器必须很紧：误判成散文意味着把 3.5 换成 4.5，是**向低估偏 29%**。
 * 而低估是会炸的那个方向。三条条件各自挡一类冒充者：
 *
 * - **标点密度 ≤ 2%**——实测散文 0.004，次低的日志 0.061，中间差 15 倍。
 * - **平均词长 3–12**——挡 base64 / 压缩后的代码（没标点，但整块是一个巨大的
 *   「词」）与 hex dump（词长 2）。这两类恰恰比日志还密。
 * - **字母占非空白字符 ≥ 60%**——挡数字表、时间戳序列、坐标转储。
 *
 * 这三条本身有单独的回归测试（`scripts/test-token-estimate-accuracy.ts`
 * 里的「冒充者」一节）：它们是本改动唯一新增的风险面。
 */
export function looksProseText(text: string): boolean {
  // 太短判不准，落回保守的默认类
  if (text.length < 40) return false

  const sample = Math.min(text.length, 400)
  let punct = 0
  let alpha = 0
  let nonSpace = 0
  let words = 0
  let inWord = false

  for (let i = 0; i < sample; i++) {
    const c = text[i]!
    // 用码点判空白：转义序列穿过多层引用时会被吃掉，字符码不会
    const code = c.charCodeAt(0)
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13
    if (isSpace) {
      inWord = false
      continue
    }
    nonSpace += 1
    if (!inWord) {
      inWord = true
      words += 1
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) alpha += 1
    // 结构性标点按码点比对——反斜杠写成字面量会被多层引用吃掉
    if (
      code === 123 || // {
      code === 125 || // }
      code === 91 ||  // [
      code === 93 ||  // ]
      code === 34 ||  // "
      code === 39 ||  // '
      code === 58 ||  // :
      code === 44 ||  // ,
      code === 92 ||  // backslash
      code === 59     // ;
    ) {
      punct += 1
    }
  }
  if (words === 0 || nonSpace === 0) return false
  if (punct / sample > 0.02) return false
  if (alpha / nonSpace < 0.6) return false

  const avgWord = nonSpace / words
  if (avgWord < 3 || avgWord > 12) return false

  return true
}

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

/**
 * CJK 每字约合多少 token。
 *
 * **两家 tokenizer 实测**（见 `scripts/live-token-calibration.ts`），同一段
 * 中文（99 CJK 字 + 18 非 CJK 字符）：
 *
 * | 端点 | 真实 token | 反推 CJK 密度 |
 * |------|-----------|--------------|
 * | DeepSeek | 62 | ≈1.73 字符/token |
 * | GPT-5.6（中转） | **79** | **≈1.34 字符/token** |
 *
 * 差异不小，所以取值必须贴着**最密的那一家**：先按 DeepSeek 定的 1.5
 * 在第二家上立刻变成低估 10%。这正是只标定一家会栽的地方。
 *
 * 不按字符类别分开数的后果同样是实测出来的：中文按默认比例算 **低估 53%**。
 * 本项目的注释、文档、交流大量是中文，这不是边缘情况。
 */
export const CJK_CHARS_PER_TOKEN = 1.3

/** CJK 及全角标点区间（够用即可，不追求 Unicode 完备） */
function isCjkChar(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xff00 && code <= 0xffef) || // 全角形式
    (code >= 0xac00 && code <= 0xd7af) // 谚文
  )
}

function countCjkChars(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (isCjkChar(text.charCodeAt(i))) n++
  }
  return n
}

/**
 * 单段文本粗估。
 *
 * 按字符类别分开数：CJK 与拉丁的 token 密度差 2 倍以上，混在一起用同一个
 * 比例必然在某一边失准，而**失准到低估那边是会炸的**。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjk = countCjkChars(text)
  const rest = text.length - cjk
  const bpt = looksProseText(text)
    ? PROSE_CHARS_PER_TOKEN
    : DEFAULT_CHARS_PER_TOKEN
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + rest / bpt)
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

// ── AR2A0b：工具输出中段截断（借鉴 Codex truncate_middle 语义；无遥测）──

/**
 * 中段截断标注前缀；truncateMiddle 用它保证幂等
 *（已截断文本再进截断层不叠加二次标注）。
 */
export const MIDDLE_TRUNCATION_MARKER = '…[truncated middle:'

/** 进模型上下文的单条工具输出默认预算（对照 Codex 默认 ~10k bytes） */
export const DEFAULT_TOOL_OUTPUT_BUDGET_BYTES = 10_000

/**
 * per-tool 输出预算表（表驱动；禁止厂商/工具 if-else 分支散落各处）。
 * 未列出的工具走 DEFAULT_TOOL_OUTPUT_BUDGET_BYTES。
 */
export const TOOL_OUTPUT_BUDGET_BYTES: Readonly<Record<string, number>> = {
  Bash: 16_000,
  Read: 40_000,
  Grep: 12_000,
  WebFetch: 8_000,
  WebSearch: 12_000,
}

/** 预算解析：显式覆盖 > per-tool 表 > 默认 */
export function toolOutputBudgetBytes(
  toolName?: string,
  override?: number,
): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  if (toolName && TOOL_OUTPUT_BUDGET_BYTES[toolName] != null) {
    return TOOL_OUTPUT_BUDGET_BYTES[toolName]!
  }
  return DEFAULT_TOOL_OUTPUT_BUDGET_BYTES
}

export type MiddleTruncateResult = {
  text: string
  truncated: boolean
  originalChars: number
  originalLines: number
  estimatedOriginalTokens: number
  omittedChars: number
}

/**
 * 中段截断：保头（默认 60%）保尾（40%），中间以一行标注原始规模。
 * - 对照 Codex `truncate_middle`：错误提示/日志通常头尾都关键（尾部常含真正的失败原因）
 * - 幂等：文本已含 MIDDLE_TRUNCATION_MARKER 时 no-op（防二次截断叠标注）
 * - 只在产出时应用一次，绝不回溯改写历史消息（prompt cache 稳定性）
 */
export function truncateMiddle(
  text: string,
  opts?: { maxChars?: number; headFraction?: number },
): MiddleTruncateResult {
  const originalChars = text.length
  const originalLines = originalChars === 0 ? 0 : text.split('\n').length
  const estimatedOriginalTokens = estimateTextTokens(text)
  const base: Omit<MiddleTruncateResult, 'text' | 'truncated' | 'omittedChars'> =
    { originalChars, originalLines, estimatedOriginalTokens }
  const maxChars = Math.max(
    0,
    Math.floor(opts?.maxChars ?? DEFAULT_TOOL_OUTPUT_BUDGET_BYTES),
  )
  if (originalChars <= maxChars || text.includes(MIDDLE_TRUNCATION_MARKER)) {
    return { ...base, text, truncated: false, omittedChars: 0 }
  }
  const headFraction = Math.min(
    0.95,
    Math.max(0.05, opts?.headFraction ?? 0.6),
  )
  const headChars = Math.floor(maxChars * headFraction)
  const tailChars = Math.max(0, maxChars - headChars)
  const marker = `\n${MIDDLE_TRUNCATION_MARKER} original ~${estimatedOriginalTokens} tokens, ${originalLines} lines (${originalChars} chars); head+tail kept; full result not stored in transcript]…\n`
  const head = text.slice(0, headChars)
  const tail = tailChars > 0 ? text.slice(-tailChars) : ''
  return {
    ...base,
    text: head + marker + tail,
    truncated: true,
    omittedChars: originalChars - headChars - tailChars,
  }
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

/**
 * AR2A0b：compact summary user-message 的稳定前缀标记（对照 Codex SUMMARY_PREFIX /
 * is_summary_message 语义）。是既有 summary 开头字面量的前缀 — 零输出变化。
 * 用于二次 compact 时识别旧 summary，注入合并提示而非重新叙述。
 */
export const COMPACT_SUMMARY_MARKER =
  'This session is being continued from a previous conversation'

/** 该消息是否为 compact 产生的 summary user-message */
export function isCompactSummaryMessage(m: ChatMessage): boolean {
  return m.role === 'user' && m.content.startsWith(COMPACT_SUMMARY_MARKER)
}

/** 历史含旧 summary 时并入 compact prompt 的合并提示（可测常量） */
export const COMPACT_MERGE_PRIOR_SUMMARY_HINT =
  'An earlier compact summary is already present in the conversation below. MERGE its facts into the new summary; do not re-narrate it or duplicate it as a separate section.'

export function getCompactUserSummaryMessage(
  summary: string,
  opts?: { suppressFollowUpQuestions?: boolean; recentMessagesPreserved?: boolean },
): string {
  const formatted = formatCompactSummary(summary)
  let base = `${COMPACT_SUMMARY_MARKER} that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${formatted}`
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

/** C1：默认保留最近 user 轮次数（对照 HC 尾部 verbatim；可 0=全量摘要） */
export const DEFAULT_KEEP_RECENT_USER_TURNS = 1

export type KeepTailOptions = {
  /**
   * 保留最近 N 个 **user 开启的 turn**（含其后 assistant/tool）。
   * 与 `keepRecentMessageCount` 二选一；同时设时 **优先本字段**。
   */
  keepRecentUserTurns?: number
  /** keep 段 token 上限；超出则从 keep 最旧 turn 再丢回 summarize */
  keepMaxTokens?: number
  /**
   * @deprecated 按 raw message 条数保留；优先改用 keepRecentUserTurns
   */
  keepRecentMessageCount?: number
}

/**
 * 按 user 轮次分组：每条 `role=user` 开启新组（含其后 assistant/tool）。
 * 开头非 user 的前缀并入第一组（不单独成 turn）。
 */
export function groupMessagesByUserTurn(
  messages: ChatMessage[],
): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  let current: ChatMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * 切点落在 tool 上时左移，避免 tool_result 与 tool_use 分家
 *（对照 HC adjustIndexToPreserveAPIInvariants 缩小版）。
 */
export function adjustCutForToolPairing(
  messages: ChatMessage[],
  cut: number,
): number {
  let c = Math.max(0, Math.min(cut, messages.length))
  // cut 指向 messages[c] 为 keep 首条；若是 tool，左移
  while (c > 0 && c < messages.length && messages[c]?.role === 'tool') {
    c -= 1
  }
  // 若 keep 从 tool 开始的前一条是带 tool_calls 的 assistant，再左移到 assistant 之前
  while (
    c > 0 &&
    messages[c]?.role === 'tool' &&
    messages[c - 1]?.role === 'assistant'
  ) {
    c -= 1
  }
  // 若 cut 落在 tool 紧跟的 assistant(tool_calls) 上，keep 应从 assistant 开始（cut=c 即可）
  // 若 assistant 有 tool_calls 且下一条是 tool，而 cut 在 tool 上已处理
  while (
    c > 0 &&
    c < messages.length &&
    messages[c - 1]?.role === 'assistant' &&
    Array.isArray(
      (messages[c - 1] as { tool_calls?: unknown }).tool_calls,
    ) &&
    ((messages[c - 1] as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) >
      0 &&
    messages[c]?.role === 'tool'
  ) {
    c -= 1
  }
  return c
}

/**
 * C1：拆分 full compact 的 summarize 前缀与 verbatim 后缀。
 * - 默认/推荐：`keepRecentUserTurns`
 * - 兼容：`keepRecentMessageCount`（仅当未设 turns）
 */
export function splitMessagesForCompactKeep(
  messages: ChatMessage[],
  opts?: KeepTailOptions,
): { toSummarize: ChatMessage[]; messagesToKeep: ChatMessage[] } {
  if (!messages.length) {
    return { toSummarize: [], messagesToKeep: [] }
  }

  const useTurns =
    opts?.keepRecentUserTurns != null &&
    Number.isFinite(opts.keepRecentUserTurns)

  if (!useTurns && opts?.keepRecentMessageCount != null) {
    const n = Math.max(0, Math.floor(opts.keepRecentMessageCount))
    if (n <= 0) return { toSummarize: [...messages], messagesToKeep: [] }
    if (n >= messages.length) {
      return { toSummarize: [], messagesToKeep: [...messages] }
    }
    let cut = messages.length - n
    cut = adjustCutForToolPairing(messages, cut)
    return {
      toSummarize: messages.slice(0, cut),
      messagesToKeep: messages.slice(cut),
    }
  }

  const turnsRaw = useTurns
    ? opts!.keepRecentUserTurns!
    : opts?.keepRecentUserTurns
  if (turnsRaw == null || !Number.isFinite(turnsRaw) || turnsRaw <= 0) {
    return { toSummarize: [...messages], messagesToKeep: [] }
  }

  const groups = groupMessagesByUserTurn(messages)
  const k = Math.min(Math.max(0, Math.floor(turnsRaw)), groups.length)
  if (k <= 0) return { toSummarize: [...messages], messagesToKeep: [] }
  if (k >= groups.length) {
    return { toSummarize: [], messagesToKeep: [...messages] }
  }

  let sumGroups = groups.slice(0, -k)
  let keepGroups = groups.slice(-k)
  let toSummarize = sumGroups.flat()
  let messagesToKeep = keepGroups.flat()

  const maxTok =
    opts?.keepMaxTokens != null && Number.isFinite(opts.keepMaxTokens)
      ? Math.max(0, Math.floor(opts.keepMaxTokens))
      : 0
  if (maxTok > 0) {
    while (
      keepGroups.length > 1 &&
      estimateTokens(messagesToKeep) > maxTok
    ) {
      const moved = keepGroups.shift()!
      sumGroups = [...sumGroups, moved]
      toSummarize = sumGroups.flat()
      messagesToKeep = keepGroups.flat()
    }
  }

  // 边界再保险（通常 user 切点已安全）
  const cut = adjustCutForToolPairing(messages, toSummarize.length)
  if (cut !== toSummarize.length) {
    return {
      toSummarize: messages.slice(0, cut),
      messagesToKeep: messages.slice(cut),
    }
  }
  return { toSummarize, messagesToKeep }
}

export type FullCompactInput = {
  messages: ChatMessage[]
  trigger: CompactTrigger
  /** 用户 /compact 附加说明 */
  customInstructions?: string
  /** PreCompact hooks 合并后的指令 */
  hookInstructions?: string
  /** 无 summarizer 时必须失败，禁止 truncate 冒充 */
  summarize: CompactSummarizer
  /**
   * C1：按 user 轮次保留尾部。未设且未设 keepRecentMessageCount 时默认
   * {@link DEFAULT_KEEP_RECENT_USER_TURNS}；显式 `0` = 全量摘要。
   */
  keepRecentUserTurns?: number
  /** keep 段 token 上限（可选） */
  keepMaxTokens?: number
  /**
   * @deprecated 按 message 条数；与 keepRecentUserTurns 同时设时后者优先
   */
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
  const maxPtl =
    input.maxPtlRetries === undefined
      ? DEFAULT_MAX_PTL_RETRIES
      : Math.max(0, input.maxPtlRetries)

  // C1：先拆 keep，summarizer 只吃前缀（降成本；尾部 verbatim）
  const keepOpts: KeepTailOptions = {
    keepMaxTokens: input.keepMaxTokens,
  }
  if (input.keepRecentUserTurns != null) {
    keepOpts.keepRecentUserTurns = input.keepRecentUserTurns
  } else if (input.keepRecentMessageCount != null) {
    keepOpts.keepRecentMessageCount = input.keepRecentMessageCount
  } else {
    // 默认：保留尾部轮次，但至少留 1 个 user turn 给摘要（短会话不 keep）
    const groups = groupMessagesByUserTurn(input.messages)
    keepOpts.keepRecentUserTurns =
      groups.length > 1
        ? Math.min(DEFAULT_KEEP_RECENT_USER_TURNS, groups.length - 1)
        : 0
  }
  const split = splitMessagesForCompactKeep(input.messages, keepOpts)
  if (split.toSummarize.length === 0) {
    return {
      ok: false,
      reason: 'Nothing to summarize (all messages kept as tail).',
      messagesUnchanged: true,
    }
  }

  // AR2A0b：待摘要前缀里已有旧 summary → 注入合并提示（防重叙述/重复段落）。
  // 只看 toSummarize：留在 keep 尾部的 summary 不会进 summarizer，无需提示。
  const hasPriorSummary = split.toSummarize.some(isCompactSummaryMessage)
  const instructions = mergeHookInstructions(
    input.customInstructions,
    hasPriorSummary
      ? mergeHookInstructions(
          input.hookInstructions,
          COMPACT_MERGE_PRIOR_SUMMARY_HINT,
        )
      : input.hookInstructions,
  )
  const compactPrompt = getCompactPrompt(instructions)

  // 对照 HC compactConversation：summarizer 命中 PTL 时截断最旧 API 轮次再试
  let messagesToSummarize = split.toSummarize
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

  const messagesToKeep = split.messagesToKeep

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
      ...(hasPriorSummary ? { mergedPriorSummary: true } : {}),
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

/**
 * 环境熔断（对照参考 DISABLE_AUTO_COMPACT / DISABLE_COMPACT）。
 * 真值：`1` / `true` / `yes` / `on`（大小写不敏感）。
 * 仅挡 auto；manual `/compact` 仍可用（便于用户显式回收上下文）。
 */
export function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** 任一为真则 auto compact 不触发 */
export function isAutoCompactEnvDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isEnvTruthy(env.BOLO_DISABLE_AUTO_COMPACT) ||
    isEnvTruthy(env.BOLO_DISABLE_COMPACT)
  )
}

export function shouldAutoCompact(opts: {
  tokenCount: number
  /**
   * C2：最近一次（或会话）API input tokens；有则**优先**于 tokenCount 做阈值判断。
   */
  usageInputTokens?: number
  /**
   * AR2A0a（opt-in）：usage 锚 + 当前 messages；两者齐备时用混合计数
   * （anchor input + 锚后尾部估算），优先于 usageInputTokens / tokenCount。
   * 锚失效则回退 estimateTokens(messages)。
   */
  anchor?: UsageAnchor
  messages?: ChatMessage[]
  /** 尾部估算是否 ×4/3 保守垫（建议 true） */
  pad?: boolean
  contextWindowTokens: number
  enabled: boolean
  consecutiveFailures: number
  maxConsecutiveFailures?: number
  querySource?: string
  /** 默认读 process.env；测试可注入 */
  env?: NodeJS.ProcessEnv
}): boolean {
  if (!opts.enabled) return false
  if (isAutoCompactEnvDisabled(opts.env)) return false
  if (opts.querySource === 'compact') return false
  // 子查询 / 摘要轮不得再 auto（对照 session_memory / compact）
  if (opts.querySource === 'session_memory') return false
  const maxFail = opts.maxConsecutiveFailures ?? DEFAULT_MAX_AUTOCOMPACT_FAILURES
  if (opts.consecutiveFailures >= maxFail) return false
  if (opts.anchor && opts.messages) {
    const h = hybridTokenCount({
      messages: opts.messages,
      anchor: opts.anchor,
      pad: opts.pad,
    })
    return h.tokenCount >= getAutoCompactThreshold(opts.contextWindowTokens)
  }
  const usage =
    opts.usageInputTokens != null &&
    Number.isFinite(opts.usageInputTokens) &&
    opts.usageInputTokens > 0
      ? Math.floor(opts.usageInputTokens)
      : undefined
  const effective = usage ?? opts.tokenCount
  return effective >= getAutoCompactThreshold(opts.contextWindowTokens)
}

/** C2：压力展示用 — usage 优先；AR2A0a：可选 anchor → hybrid */
export function resolveAutoCompactTokenCount(opts: {
  estimateTokens: number
  usageInputTokens?: number
  /** AR2A0a：usage 锚（与 messages 一起给时优先于 usageInputTokens） */
  anchor?: UsageAnchor
  messages?: ChatMessage[]
  pad?: boolean
}): { tokenCount: number; source: 'usage' | 'estimate' | 'hybrid' } {
  if (opts.anchor && opts.messages) {
    const h = hybridTokenCount({
      messages: opts.messages,
      anchor: opts.anchor,
      pad: opts.pad,
    })
    if (h.source !== 'estimate') return h
    // 锚失效 → 沿用调用方给的 estimateTokens（可能含 system 段，比 messages 更全）
    return {
      tokenCount: Math.max(0, Math.floor(opts.estimateTokens)),
      source: 'estimate',
    }
  }
  const usage =
    opts.usageInputTokens != null &&
    Number.isFinite(opts.usageInputTokens) &&
    opts.usageInputTokens > 0
      ? Math.floor(opts.usageInputTokens)
      : undefined
  if (usage != null) return { tokenCount: usage, source: 'usage' }
  return {
    tokenCount: Math.max(0, Math.floor(opts.estimateTokens)),
    source: 'estimate',
  }
}

// ── AR2A0a：混合 usage 锚定 token 计数（借鉴 HC tokenCountWithEstimation 语义）──

/**
 * 尾部增量估算的保守垫（对照参考实现 ×4/3）：
 * 宁可略早触发 auto compact，也不因低估而撞窗。
 */
export const CONSERVATIVE_ESTIMATE_PAD = 4 / 3

/**
 * usage 锚：最近一次 API 调用的真实 input tokens + 当时的消息数快照。
 * 锚之后追加的消息用启发式估算，两者相加即「混合计数」。
 */
export type UsageAnchor = {
  /** 最近一次成功 API call 的 input tokens（provider 报告，非估算） */
  anchorInputTokens: number
  /** 该 call 发起时 session.messages 的长度 */
  anchoredMessageCount: number
  /** fingerprintMessagePrefix 结果；缺省则只做长度校验 */
  fingerprint?: string
}

/**
 * 前缀形状指纹：只看 role + tool_calls 数量，**不看内容**。
 * - microcompact 只清正文 → 指纹不变，锚仍有效（头部 input 已被 API 计过）
 * - snip / full compact 改写头部（角色序列变化或变短）→ 指纹失配 → 锚失效
 */
export function fingerprintMessagePrefix(
  messages: readonly ChatMessage[],
  count: number,
): string {
  const n = Math.max(0, Math.min(Math.floor(count), messages.length))
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    const m = messages[i]!
    parts.push(`${m.role}:${m.tool_calls?.length ?? 0}`)
  }
  return hashStablePrefix(parts.join('|'))
}

/**
 * 混合计数：anchor input（真实）+ 锚后尾部估算（可选 ×4/3 垫）。
 * 锚无效（超长 / 指纹失配 / 非法值）→ 回退全量 estimateTokens。
 */
export function hybridTokenCount(opts: {
  messages: ChatMessage[]
  anchor?: UsageAnchor
  pad?: boolean
}): { tokenCount: number; source: 'hybrid' | 'estimate' | 'usage' } {
  const { messages, anchor } = opts
  const fallback = () => ({
    tokenCount: estimateTokens(messages),
    source: 'estimate' as const,
  })
  if (!anchor) return fallback()
  const count = Math.floor(anchor.anchoredMessageCount)
  const input = Math.floor(anchor.anchorInputTokens)
  if (!Number.isFinite(input) || input <= 0) return fallback()
  if (!Number.isFinite(count) || count <= 0 || count > messages.length) {
    return fallback()
  }
  if (
    anchor.fingerprint != null &&
    anchor.fingerprint !== fingerprintMessagePrefix(messages, count)
  ) {
    return fallback()
  }
  if (count === messages.length) {
    return { tokenCount: input, source: 'usage' }
  }
  let tail = estimateTokens(messages.slice(count))
  if (opts.pad) tail = Math.ceil(tail * CONSERVATIVE_ESTIMATE_PAD)
  return { tokenCount: input + tail, source: 'hybrid' }
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

// ── Snip（无 LLM：丢掉过旧前缀，保留尾部；在 micro / auto 之前）────

/**
 * 对照参考 snipCompactIfNeeded 语义（无 SnipTool / 无遥测 / 无 UUID 链）：
 * - 不调模型；只裁消息数组
 * - 与 micro 正交：先 snip 再 micro
 * - tokensFreed 供 auto 阈值扣减（prepare 链内）
 * - 边界是 system 占位文案，便于 transcript 识别
 */
export const SNIP_BOUNDARY_CONTENT = 'History snipped'

export type SnipOptions = {
  /** 默认 true */
  enabled?: boolean
  /**
   * 保留最近 N 条消息（会为 tool 配对向前多留 assistant）。
   * 默认 32。
   */
  keepRecentMessages?: number
  /**
   * 仅当 estimateTokens ≥ 此值才考虑 snip。
   * 默认 32_000（低于典型 auto 阈值，优先轻量裁剪）。
   */
  minTokensToSnip?: number
  /**
   * 至少丢掉这么多条才执行（避免无意义抖动）。
   * 默认 6。
   */
  minMessagesToRemove?: number
}

export type SnipResult = {
  messages: ChatMessage[]
  /** 粗估释放 tokens（与 estimateTokens 一致） */
  tokensFreed: number
  removedCount: number
  executed: boolean
  /** 写入链首的边界 system 消息（executed 时有） */
  boundaryMessage?: ChatMessage
}

export const DEFAULT_SNIP_OPTIONS: Required<
  Pick<
    SnipOptions,
    'enabled' | 'keepRecentMessages' | 'minTokensToSnip' | 'minMessagesToRemove'
  >
> = {
  enabled: true,
  keepRecentMessages: 32,
  minTokensToSnip: 32_000,
  minMessagesToRemove: 6,
}

/**
 * 为保留尾部找安全起点：不可从孤立 tool 结果切开；
 * 若落在 tool 上则回退到带 tool_calls 的 assistant。
 */
export function findSafeSnipCutIndex(
  messages: ChatMessage[],
  keepRecent: number,
): number {
  const n = messages.length
  if (n === 0) return 0
  const keep = Math.max(1, Math.min(keepRecent, n))
  let cut = n - keep
  // 孤立 tool：并入其前序 assistant
  while (cut > 0 && cut < n && messages[cut]!.role === 'tool') {
    cut -= 1
  }
  // 若 cut 落在 assistant.tool_calls 中间之后的「半段」已由上处理；
  // 再避免把 compact/snip 边界单独丢掉却留下无头摘要：边界可随前缀走
  return Math.max(0, cut)
}

function isSnipBoundaryMessage(m: ChatMessage): boolean {
  return m.role === 'system' && m.content.trim() === SNIP_BOUNDARY_CONTENT
}

/**
 * Snip：无 LLM。token/条数达门槛时丢掉前缀，保留尾部，链首插边界。
 * 不改 role/tool_call_id；失败路径返回原数组引用。
 */
export function snipMessagesIfNeeded(
  messages: ChatMessage[],
  options?: SnipOptions,
): SnipResult {
  const enabled = options?.enabled ?? DEFAULT_SNIP_OPTIONS.enabled
  if (!enabled || messages.length === 0) {
    return {
      messages,
      tokensFreed: 0,
      removedCount: 0,
      executed: false,
    }
  }

  const keepRecent = Math.max(
    1,
    options?.keepRecentMessages ?? DEFAULT_SNIP_OPTIONS.keepRecentMessages,
  )
  const minTokens =
    options?.minTokensToSnip ?? DEFAULT_SNIP_OPTIONS.minTokensToSnip
  const minRemove = Math.max(
    1,
    options?.minMessagesToRemove ?? DEFAULT_SNIP_OPTIONS.minMessagesToRemove,
  )

  // 去掉已有 snip 边界再估（避免重复边界叠层干扰计数）
  const stripped = messages.filter((m) => !isSnipBoundaryMessage(m))
  const tokenCount = estimateTokens(stripped)
  if (tokenCount < minTokens) {
    return {
      messages,
      tokensFreed: 0,
      removedCount: 0,
      executed: false,
    }
  }

  const cut = findSafeSnipCutIndex(stripped, keepRecent)
  if (cut < minRemove) {
    return {
      messages,
      tokensFreed: 0,
      removedCount: 0,
      executed: false,
    }
  }

  const dropped = stripped.slice(0, cut)
  const kept = stripped.slice(cut)
  if (kept.length === 0) {
    return {
      messages,
      tokensFreed: 0,
      removedCount: 0,
      executed: false,
    }
  }

  const tokensFreed = estimateTokens(dropped)
  const boundaryMessage: ChatMessage = {
    role: 'system',
    content: SNIP_BOUNDARY_CONTENT,
  }
  // 边界文案极短；不扣 tokensFreed，便于 auto 侧保守扣减
  const next = [boundaryMessage, ...kept]

  return {
    messages: next,
    tokensFreed,
    removedCount: dropped.length,
    executed: true,
    boundaryMessage,
  }
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
  // AR2A0b：与 exec 层同一中段截断语义（保头保尾 + 原始规模标注；幂等）
  return truncateMiddle(content, { maxChars }).text
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

// ── F-CP-CACHED-MC / F-CP-SNIP-UUID / F-C6 最小 ──

/** 可回放 snip 边界：带可选 snip group id（非真 SnipTool） */
export const SNIP_BOUNDARY_PREFIX = 'History snipped'

export type CachedMicrocompactResult = {
  messages: ChatMessage[]
  /** 视为「缓存友好」清理：仅清旧 tool 正文，不改条数 */
  cacheFriendly: true
  tokensSavedEstimate: number
  clearedToolUseIds: string[]
}

/**
 * F-CP-CACHED-MC：cached microcompact 语义最小。
 * 与 microcompact 相同 content-clear，标记 cacheFriendly（无 API cache_edits / 无遥测）。
 */
export function cachedMicrocompactMessages(
  messages: ChatMessage[],
  options?: MicrocompactOptions,
): CachedMicrocompactResult {
  const r = microcompactMessages(messages, options)
  return {
    messages: r.messages,
    cacheFriendly: true,
    tokensSavedEstimate: r.tokensSavedEstimate,
    clearedToolUseIds: r.clearedToolUseIds,
  }
}

export type SnipBoundaryMeta = {
  snipId: string
  removedCount: number
  at: string
}

/** 从 system 边界消息解析 snipId（若有） */
export function parseSnipBoundaryId(content: string): string | undefined {
  const m = content.match(/snip_id=([a-zA-Z0-9_-]+)/)
  return m?.[1]
}

/**
 * F-CP-SNIP-UUID：生成带 snip_id 的边界文案（可回放标记，非完整 SnipTool）。
 */
export function formatSnipBoundaryContent(meta: SnipBoundaryMeta): string {
  return `${SNIP_BOUNDARY_PREFIX} (snip_id=${meta.snipId} removed=${meta.removedCount} at=${meta.at})`
}

export function newSnipId(): string {
  return `snip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── F-C6-TTL prompt cache 可观测（对照 HC promptCacheBreakDetection，无遥测）──

export const DEFAULT_PROMPT_CACHE_TTL_MS = 60 * 60 * 1000 // 1h

/**
 * 上一轮 cache_read 明显高于本轮 → 疑似服务端 miss
 *（对照 HC prevCacheReadTokens 下跌检测，简化版）
 */
export const CACHE_READ_DROP_RATIO = 0.5

export type PromptCacheBreakReason =
  | 'ttl_expired'
  | 'system_prefix_changed'
  | 'tools_changed'
  | 'model_changed'
  | 'effort_changed'
  | 'cache_read_drop'
  | 'forced'
  | 'none'

export type PromptCacheSessionState = {
  /** 上次成功标记 cache 的时间 */
  lastCacheAt?: number
  /** 稳定 system 前缀指纹 */
  stablePrefixHash?: string
  /** tools 名序列指纹（排序后 join） */
  toolsHash?: string
  /** 上次 tools 名列表（排序；用于 break 时 diff） */
  lastToolNames?: string[]
  /** 最近一次 tools break 时：added / removed */
  lastToolsAdded?: string[]
  lastToolsRemoved?: string[]
  /** 上次 call 的 model / effort（参与 break 检测） */
  lastModel?: string
  lastEffort?: string
  /** 上一轮 provider 报告的 cache_read tokens */
  prevCacheReadTokens?: number
  ttlMs: number
  /** 最近一次 break 检测结果（本地 /cost 展示） */
  lastBreakReason?: PromptCacheBreakReason
  lastCheckedAt?: number
  /** 本会话累计 break 次数（reason≠none） */
  breakCount?: number
  /** 最近一次是否因 API 读数下跌判定 */
  lastCacheReadDrop?: boolean
  /**
   * 最近 break 人类可读说明（如 tools +Read -Write、model a→b）
   * 无遥测，仅本地 /cost
   */
  lastBreakDetail?: string
}

export function createPromptCacheSessionState(
  ttlMs = DEFAULT_PROMPT_CACHE_TTL_MS,
): PromptCacheSessionState {
  return { ttlMs, breakCount: 0 }
}

export function hashStablePrefix(text: string): string {
  // 轻量非 crypto 指纹（避免强依赖）；足够 break detection
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

/** tools 名列表 → 稳定指纹（排序） */
export function hashToolNames(names: readonly string[] | undefined | null): string {
  if (!names?.length) return hashStablePrefix('(no-tools)')
  const sorted = [...names].map((n) => n.trim()).filter(Boolean).sort()
  return hashStablePrefix(sorted.join('\0'))
}

export function normalizeToolNames(
  names: readonly string[] | undefined | null,
): string[] {
  if (!names?.length) return []
  return [...names].map((n) => n.trim()).filter(Boolean).sort()
}

/** 对照 HC addedTools/removedTools（仅名，无 schema hash） */
export function diffToolNames(
  prev: readonly string[] | undefined | null,
  next: readonly string[] | undefined | null,
): { added: string[]; removed: string[] } {
  const a = new Set(normalizeToolNames(prev))
  const b = new Set(normalizeToolNames(next))
  const added: string[] = []
  const removed: string[] = []
  for (const n of b) if (!a.has(n)) added.push(n)
  for (const n of a) if (!b.has(n)) removed.push(n)
  return { added, removed }
}

export type PromptCacheCallContext = {
  stablePrefix: string
  toolNames?: readonly string[]
  model?: string
  effort?: string
  /** 本轮 provider 报告的 cache_read；用于下跌检测 */
  cacheReadTokens?: number
}

export type PromptCacheBreakResult = {
  break: boolean
  reason: PromptCacheBreakReason
  detail?: string
  toolsAdded?: string[]
  toolsRemoved?: string[]
}

/**
 * 是否应打断 prompt cache（TTL / 前缀 / tools / model / effort / cache_read 下跌）。
 * 不修改 state。
 */
export function shouldBreakPromptCache(
  state: PromptCacheSessionState,
  stablePrefixOrCtx: string | PromptCacheCallContext,
  now = Date.now(),
): PromptCacheBreakResult {
  const ctx: PromptCacheCallContext =
    typeof stablePrefixOrCtx === 'string'
      ? { stablePrefix: stablePrefixOrCtx }
      : stablePrefixOrCtx

  const hash = hashStablePrefix(ctx.stablePrefix)
  if (state.stablePrefixHash && state.stablePrefixHash !== hash) {
    return {
      break: true,
      reason: 'system_prefix_changed',
      detail: 'stable system prefix hash changed',
    }
  }

  if (ctx.toolNames) {
    const th = hashToolNames(ctx.toolNames)
    if (state.toolsHash && state.toolsHash !== th) {
      const { added, removed } = diffToolNames(
        state.lastToolNames,
        ctx.toolNames,
      )
      const parts: string[] = []
      if (added.length) parts.push(`+${added.join(',')}`)
      if (removed.length) parts.push(`-${removed.join(',')}`)
      return {
        break: true,
        reason: 'tools_changed',
        detail: parts.length ? parts.join(' ') : 'tool set hash changed',
        toolsAdded: added,
        toolsRemoved: removed,
      }
    }
  }

  const model = ctx.model?.trim()
  if (model && state.lastModel && state.lastModel !== model) {
    return {
      break: true,
      reason: 'model_changed',
      detail: `${state.lastModel}→${model}`,
    }
  }

  const effort = ctx.effort?.trim()
  if (effort && state.lastEffort && state.lastEffort !== effort) {
    return {
      break: true,
      reason: 'effort_changed',
      detail: `${state.lastEffort}→${effort}`,
    }
  }

  if (
    state.lastCacheAt != null &&
    now - state.lastCacheAt > (state.ttlMs || DEFAULT_PROMPT_CACHE_TTL_MS)
  ) {
    const ageMin = Math.round((now - state.lastCacheAt) / 60_000)
    return {
      break: true,
      reason: 'ttl_expired',
      detail: `idle ~${ageMin}m > ttl`,
    }
  }

  // 服务端 miss 启发式：上一轮有明显 cache hit，本轮读数骤降
  const prev = state.prevCacheReadTokens
  const cur = ctx.cacheReadTokens
  if (
    prev != null &&
    prev > 100 &&
    cur != null &&
    cur < prev * CACHE_READ_DROP_RATIO
  ) {
    return {
      break: true,
      reason: 'cache_read_drop',
      detail: `cacheRead ${prev}→${cur}`,
    }
  }

  return { break: false, reason: 'none' }
}

/** 记录一次成功的 cache 标记（返回新对象） */
export function touchPromptCacheSession(
  state: PromptCacheSessionState,
  stablePrefixOrCtx: string | PromptCacheCallContext,
  now = Date.now(),
): PromptCacheSessionState {
  const ctx: PromptCacheCallContext =
    typeof stablePrefixOrCtx === 'string'
      ? { stablePrefix: stablePrefixOrCtx }
      : stablePrefixOrCtx
  const next: PromptCacheSessionState = {
    ...state,
    lastCacheAt: now,
    stablePrefixHash: hashStablePrefix(ctx.stablePrefix),
  }
  if (ctx.toolNames) {
    next.toolsHash = hashToolNames(ctx.toolNames)
    next.lastToolNames = normalizeToolNames(ctx.toolNames)
  }
  if (ctx.model?.trim()) next.lastModel = ctx.model.trim()
  if (ctx.effort?.trim()) next.lastEffort = ctx.effort.trim()
  if (ctx.cacheReadTokens != null && Number.isFinite(ctx.cacheReadTokens)) {
    next.prevCacheReadTokens = Math.max(0, Math.floor(ctx.cacheReadTokens))
  }
  return next
}

/**
 * 就地更新：检测 break → 写 lastBreakReason/detail → touch。
 * 供 queryLoop 在 callModel 成功后调用（无遥测）。
 */
export function notePromptCacheAfterModelCall(
  state: PromptCacheSessionState,
  stablePrefixOrCtx: string | PromptCacheCallContext,
  now = Date.now(),
): PromptCacheBreakResult {
  const ctx: PromptCacheCallContext =
    typeof stablePrefixOrCtx === 'string'
      ? { stablePrefix: stablePrefixOrCtx }
      : stablePrefixOrCtx
  const chk = shouldBreakPromptCache(state, ctx, now)
  state.lastBreakReason = chk.reason
  state.lastCheckedAt = now
  state.lastCacheReadDrop = chk.reason === 'cache_read_drop'
  if (chk.detail) state.lastBreakDetail = chk.detail
  else if (chk.reason === 'none') state.lastBreakDetail = undefined
  if (chk.toolsAdded) state.lastToolsAdded = chk.toolsAdded
  if (chk.toolsRemoved) state.lastToolsRemoved = chk.toolsRemoved
  if (chk.break && chk.reason !== 'none') {
    state.breakCount = (state.breakCount ?? 0) + 1
  }
  const next = touchPromptCacheSession(state, ctx, now)
  state.lastCacheAt = next.lastCacheAt
  state.stablePrefixHash = next.stablePrefixHash
  if (next.toolsHash) state.toolsHash = next.toolsHash
  if (next.lastToolNames) state.lastToolNames = next.lastToolNames
  if (next.lastModel) state.lastModel = next.lastModel
  if (next.lastEffort) state.lastEffort = next.lastEffort
  if (next.prevCacheReadTokens != null) {
    state.prevCacheReadTokens = next.prevCacheReadTokens
  }
  return chk
}

/** 可 JSON 序列化的子集（resume / 快照） */
export function serializePromptCacheSessionState(
  state: PromptCacheSessionState | undefined | null,
): Record<string, unknown> | undefined {
  if (!state) return undefined
  const o: Record<string, unknown> = {
    ttlMs: state.ttlMs || DEFAULT_PROMPT_CACHE_TTL_MS,
  }
  if (state.lastCacheAt != null) o.lastCacheAt = state.lastCacheAt
  if (state.stablePrefixHash) o.stablePrefixHash = state.stablePrefixHash
  if (state.toolsHash) o.toolsHash = state.toolsHash
  if (state.lastToolNames?.length) o.lastToolNames = [...state.lastToolNames]
  if (state.lastModel) o.lastModel = state.lastModel
  if (state.lastEffort) o.lastEffort = state.lastEffort
  if (state.prevCacheReadTokens != null) {
    o.prevCacheReadTokens = state.prevCacheReadTokens
  }
  if (state.lastBreakReason && state.lastBreakReason !== 'none') {
    o.lastBreakReason = state.lastBreakReason
  }
  if (state.lastCheckedAt != null) o.lastCheckedAt = state.lastCheckedAt
  if (state.breakCount != null && state.breakCount > 0) {
    o.breakCount = state.breakCount
  }
  if (state.lastBreakDetail) o.lastBreakDetail = state.lastBreakDetail
  if (state.lastToolsAdded?.length) o.lastToolsAdded = [...state.lastToolsAdded]
  if (state.lastToolsRemoved?.length) {
    o.lastToolsRemoved = [...state.lastToolsRemoved]
  }
  return o
}

export function parsePromptCacheSessionState(
  raw: unknown,
): PromptCacheSessionState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const ttl =
    typeof o.ttlMs === 'number' && Number.isFinite(o.ttlMs) && o.ttlMs > 0
      ? Math.floor(o.ttlMs)
      : DEFAULT_PROMPT_CACHE_TTL_MS
  const state = createPromptCacheSessionState(ttl)
  if (typeof o.lastCacheAt === 'number' && Number.isFinite(o.lastCacheAt)) {
    state.lastCacheAt = o.lastCacheAt
  }
  if (typeof o.stablePrefixHash === 'string') {
    state.stablePrefixHash = o.stablePrefixHash
  }
  if (typeof o.toolsHash === 'string') state.toolsHash = o.toolsHash
  if (Array.isArray(o.lastToolNames)) {
    state.lastToolNames = o.lastToolNames
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (typeof o.lastModel === 'string') state.lastModel = o.lastModel.trim()
  if (typeof o.lastEffort === 'string') state.lastEffort = o.lastEffort.trim()
  if (
    typeof o.prevCacheReadTokens === 'number' &&
    Number.isFinite(o.prevCacheReadTokens)
  ) {
    state.prevCacheReadTokens = Math.max(0, Math.floor(o.prevCacheReadTokens))
  }
  if (typeof o.lastBreakReason === 'string') {
    state.lastBreakReason = o.lastBreakReason as PromptCacheBreakReason
  }
  if (typeof o.lastCheckedAt === 'number' && Number.isFinite(o.lastCheckedAt)) {
    state.lastCheckedAt = o.lastCheckedAt
  }
  if (typeof o.breakCount === 'number' && Number.isFinite(o.breakCount)) {
    state.breakCount = Math.max(0, Math.floor(o.breakCount))
  }
  if (typeof o.lastBreakDetail === 'string') {
    state.lastBreakDetail = o.lastBreakDetail
  }
  if (Array.isArray(o.lastToolsAdded)) {
    state.lastToolsAdded = o.lastToolsAdded.filter(
      (x): x is string => typeof x === 'string',
    )
  }
  if (Array.isArray(o.lastToolsRemoved)) {
    state.lastToolsRemoved = o.lastToolsRemoved.filter(
      (x): x is string => typeof x === 'string',
    )
  }
  return state
}

/** /cost · /context 一行（可多行） */
export function formatPromptCacheSessionLine(
  state: PromptCacheSessionState | undefined | null,
): string | undefined {
  if (!state) return undefined
  const age =
    state.lastCacheAt != null
      ? `${Math.max(0, Math.round((Date.now() - state.lastCacheAt) / 1000))}s ago`
      : 'never'
  const br = state.lastBreakReason ?? 'none'
  const ttlMin = Math.round((state.ttlMs || DEFAULT_PROMPT_CACHE_TTL_MS) / 60_000)
  const breaks = state.breakCount ?? 0
  const parts = [
    `lastTouch ${age}`,
    `lastCheck=${br}`,
    `breaks=${breaks}`,
    `ttl=${ttlMin}m`,
  ]
  if (state.lastModel) parts.push(`model=${state.lastModel}`)
  if (state.prevCacheReadTokens != null) {
    parts.push(`prevCacheRead=${state.prevCacheReadTokens}`)
  }
  if (state.lastBreakDetail && br !== 'none') {
    parts.push(`detail=${state.lastBreakDetail}`)
  }
  return `  promptCache:   ${parts.join(' · ')} (local layout/TTL/API-read; not vendor billing)`
}
// AR2A1：partial compact 的 range / watermark 契约（纯函数，不接 provider）
export {
  findAtomicBlocks,
  deriveCompactWatermark,
  validateCompactRange,
  planPartialCompact,
  type MessageRange,
  type CompactWatermark,
  type CompactRangeRejection,
  type CompactRangeCheck,
  type CompactRangeOptions,
  type CompactPlan,
  type CompactPlanRejection,
} from './range.ts'
