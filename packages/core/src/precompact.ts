/**
 * CMP-2 · 两遍预压缩（prefire pass1）
 *
 * 接近压缩阈值时后台先总结历史前缀（pass1 预热），真正压缩时若预热仍有效
 * 只做增量第二遍（summarizer 只吃新增消息），显著缩短压缩停顿。
 *
 * 触发区间：`[autoThreshold - PRECOMPACT_AHEAD_TOKENS, autoThreshold)`——
 * auto 阈值本身 ≈ effectiveWindow - buffer（128k 窗口时约 75%），预热取
 * 阈值前 8k token 的窄带，避免与 auto compact 抢触发。
 *
 * 并发/取消语义：
 * - 预热是 fire-and-forget 低优先级任务（不阻塞主线程）。
 * - 压缩开始时 `session.precompact` 被清空；预热结果晚到时 commit 被拒
 *   （引用检查），丢弃——不会覆盖压缩后的新状态。
 * - 预热期间新消息到达：压缩时用「前 N 条指纹」验证预热仍覆盖旧前缀，
 *   不匹配则回退全量压缩（功能正确，仅预热失效）。
 * - 预热失败（summarize 抛错/超时）静默丢弃，下次进入区间再触发。
 */
import type { ChatMessage } from '../../shared/src/index.ts'
import {
  estimateTokens,
  getAutoCompactThreshold,
  getCompactUserSummaryMessage,
  resolveCompactKeepOpts,
  splitMessagesForCompactKeep,
  type CompactSummarizer,
} from '../../compact/src/index.ts'

/** 预热提前量：auto 阈值前这个 token 量即启动 pass1 */
export const PRECOMPACT_AHEAD_TOKENS = 8_000

export type PrecompactState = {
  /** 启动时间戳（诊断/去重用） */
  at: number
  /** 已总结的前缀消息条数 */
  count: number
  /** 前缀指纹（压缩时验证仍匹配，防新消息污染合并） */
  headFingerprint: string
  /** pass1 总结文本 */
  summaryText: string
}

export type PrecompactWarmupOptions = {
  messages: () => readonly ChatMessage[]
  summarize: CompactSummarizer
  contextWindowTokens: number
  /** 是否已有有效预热（已落位状态） */
  current: () => PrecompactState | undefined
  /** 提交结果：调用方做 at 比较（旧结果不覆盖新状态） */
  commit: (state: PrecompactState) => void
  /** 抢占进行中标记：返回 true 表示本任务获得运行权（否则已有任务在跑） */
  markInFlight: () => boolean
  /** 释放进行中标记（任务结束/失败/超时） */
  clearInFlight: () => void
  summarizeTimeoutMs?: number
}

/** 当前消息是否处于预热区间（auto 阈值前 PREHEAT 窄带内） */
export function shouldPrecompact(
  messages: readonly ChatMessage[],
  contextWindowTokens: number,
): boolean {
  if (contextWindowTokens <= 0) return false
  const threshold = getAutoCompactThreshold(contextWindowTokens)
  const estimate = estimateTokens([...messages])
  return estimate >= threshold - PRECOMPACT_AHEAD_TOKENS && estimate < threshold
}

/** 启动 pass1 预热（fire-and-forget；已有进行中或有效预热则跳过） */
export function startPrecompactWarmup(opts: PrecompactWarmupOptions): void {
  if (opts.current()) return
  if (!opts.markInFlight()) return // 已有进行中任务（in-flight 去重）
  try {
    const messages = opts.messages()
    if (messages.length === 0) {
      opts.clearInFlight()
      return
    }
    if (!shouldPrecompact(messages, opts.contextWindowTokens)) {
      opts.clearInFlight()
      return
    }

    // 与真正压缩相同的 split（resolveCompactKeepOpts 共用保证一致性）
    const keepOpts = resolveCompactKeepOpts({
      messages: [...messages],
      keepMaxTokens: undefined,
    })
    const split = splitMessagesForCompactKeep([...messages], keepOpts)
    if (split.toSummarize.length === 0) {
      opts.clearInFlight() // 所有早退路径都必须释放抢占标记
      return
    }

    const count = split.toSummarize.length
    const headFingerprint = fingerprintMessages(split.toSummarize)
    const at = Date.now()
    const compactPrompt =
      'Summarize the conversation prefix below for later incremental compaction. ' +
      'Keep all key facts, decisions, files, and errors. Output a single summary block.'

    // fire-and-forget：低优先级预热，不阻塞主线程
    void (async () => {
      try {
        const call = opts.summarize({
          messages: split.toSummarize,
          compactPrompt,
        })
        const timeoutMs = opts.summarizeTimeoutMs
        const out =
          timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? await withTimeout(call, timeoutMs)
            : await call
        const text = out.text?.trim() ?? ''
        if (!text) return
        // commit 由调用方做 at 比较：晚到的旧结果不覆盖新状态/新预热
        opts.commit({ at, count, headFingerprint, summaryText: text })
      } catch {
        /* 预热失败静默丢弃，下次进入区间再触发 */
      } finally {
        opts.clearInFlight()
      }
    })()
  } catch {
    // 同步段（split/估算）异常也须释放抢占标记，杜绝 in-flight 卡死
    opts.clearInFlight()
  }
}

/**
 * 压缩时合并预热结果：预热仍有效 → 返回「合成 summary 消息 + 新增消息」短链；
 * 无效（无预热/指纹不匹配/前 N 条变了）→ undefined（回退全量）。
 */
export function buildPrecompactMessages(
  messages: readonly ChatMessage[],
  precompact: PrecompactState | undefined,
): ChatMessage[] | undefined {
  if (!precompact) return undefined
  if (messages.length <= precompact.count) return undefined
  const head = messages.slice(0, precompact.count)
  if (fingerprintMessages(head) !== precompact.headFingerprint) return undefined
  // 合成 summary user 消息（isCompactSummaryMessage 识别 → 压缩时自动注入
  // COMPACT_MERGE_PRIOR_SUMMARY_HINT 合并提示），后接新增消息 + 尾部
  return [
    {
      role: 'user' as const,
      content: getCompactUserSummaryMessage(precompact.summaryText),
    },
    ...messages.slice(precompact.count),
  ]
}

/** 消息块指纹（非密码学；预热前缀验证用） */
function fingerprintMessages(messages: readonly ChatMessage[]): string {
  let h = 0
  for (const m of messages) {
    const s = `${m.role}\u0000${m.content}`
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0
    }
  }
  return `f${h >>> 0}`
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`precompact timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
