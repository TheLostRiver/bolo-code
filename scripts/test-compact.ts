/**
 * compact 管道单测（fake summarizer，无网络）
 * 运行：npx tsx scripts/test-compact.ts
 */

import {
  buildPostCompactMessages,
  formatCompactSummary,
  mergeHookInstructions,
  runFullCompact,
  shouldAutoCompact,
  type ChatMessage,
} from '../packages/compact/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // format
  const formatted = formatCompactSummary(
    `<analysis>scratch should go</analysis>\n<summary>\n1. Intent: ship compact\n</summary>`,
  )
  assert(!formatted.includes('scratch'), 'analysis stripped')
  assert(formatted.includes('Intent'), 'summary kept')

  // merge
  assert(
    mergeHookInstructions('user', 'hook') === 'user\n\nhook',
    'merge both',
  )
  assert(mergeHookInstructions(undefined, 'h') === 'h', 'merge hook only')

  const messages: ChatMessage[] = [
    { role: 'user', content: 'Build compaction like the reference agent' },
    { role: 'assistant', content: 'I will design full compact, not slice.' },
    { role: 'user', content: 'Do not invent telemetry' },
    { role: 'assistant', content: 'Understood, no telemetry.' },
  ]

  // 拒绝无 summarizer 式截断：用错误类型模拟——runFullCompact 要求函数
  const bad = await runFullCompact({
    messages,
    trigger: 'manual',
    summarize: async () => ({ text: '' }),
  })
  assert(bad.ok === false, 'empty summary fails')
  assert(bad.ok === false && bad.messagesUnchanged, 'unchanged on fail')

  const ok = await runFullCompact({
    messages,
    trigger: 'manual',
    customInstructions: 'from-user',
    hookInstructions: 'from-precompact-hook',
    keepRecentMessageCount: 1,
    summarize: async ({ compactPrompt }) => {
      // MEM-1：压缩前 flush 用不同 prompt 复用同一 summarizer——按 prompt 区分
      if (compactPrompt.includes('memory daily log')) {
        return { text: '' } // MEM-1 flush 分支：空文本不落盘，避免污染真实 daily log
      }
      assert(compactPrompt.includes('from-user'), 'user instructions in prompt')
      assert(compactPrompt.includes('from-precompact-hook'), 'hook instructions in prompt')
      assert(compactPrompt.includes('TEXT ONLY'), 'no-tools preamble')
      assert(compactPrompt.includes('Primary Request'), 'section list')
      return {
        text: `<analysis>draft</analysis><summary>\n1. Primary Request and Intent:\n   Design proper compaction.\n8. Current Work:\n   Writing compact package.\n</summary>`,
      }
    },
  })
  assert(ok.ok === true, 'success')
  if (!ok.ok) return

  const api = ok.apiMessages
  assert(api[0]?.content === 'Conversation compacted', 'boundary first')
  assert(api.some((m) => m.content.includes('Design proper')), 'summary in api view')
  assert(api[api.length - 1]?.content === 'Understood, no telemetry.', 'kept last message')
  assert(ok.result.summaryText.includes('Primary Request'), 'summaryText set')
  assert(
    buildPostCompactMessages(ok.result).length === api.length,
    'build matches',
  )

  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
    }) === true,
    'auto threshold high usage',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
    }) === false,
    'auto not yet',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 3,
    }) === false,
    'circuit breaker',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      querySource: 'compact',
    }) === false,
    'no recurse',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      env: { BOLO_DISABLE_AUTO_COMPACT: '1' },
    }) === false,
    'env BOLO_DISABLE_AUTO_COMPACT',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      env: { BOLO_DISABLE_COMPACT: 'true' },
    }) === false,
    'env BOLO_DISABLE_COMPACT',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 100_000,
      contextWindowTokens: 100_000,
      enabled: true,
      consecutiveFailures: 0,
      env: {},
    }) === true,
    'empty env still allows when enabled',
  )

  // ── token 启发式：正文 chars/4；JSON 密文更密 ──
  const {
    estimateTextTokens,
    estimateMessageTokens,
    estimateTokens,
    getContextPressure,
    getAutoCompactThreshold,
    getEffectiveContextWindow,
    AUTOCOMPACT_BUFFER_TOKENS,
  } = await import('../packages/compact/src/index.ts')

  // 这里原本钉死 `chars/4`。实测（DeepSeek，见 live-token-calibration.ts）
  // 推翻了它作为普适常量：非 CJK 真实跨度 3.3（日志/路径）到 4.9（英文散文）
  // 字符/token，按 4 算会把日志类**低估 17%**——那是会撞 provider 硬上限的方向。
  // 数值精度改由 test-token-estimate-accuracy.ts 用真实 tokenizer 的实测值把关；
  // 这里只断言必须成立的**性质**，不再绑死某个常量。
  assert(estimateTextTokens('') === 0, 'empty text costs nothing')
  assert(estimateTextTokens('abcd') >= 1, 'any non-empty text costs at least one token')
  assert(
    estimateTextTokens('abcdefgh') >= estimateTextTokens('abcd'),
    'longer text never costs fewer tokens',
  )
  // 这一条原本断言「密文 JSON 比散文更贵」，用 `'a'.repeat()` 当散文。
  // **两个前提都被实测推翻了**：JSON 真实 4.18 字符/token，是非 CJK 里最稀的
  // 一类；而一整串 'a' 也从来不是散文（它是单个超长 token 串）。
  // 现在断言的是有实测支撑的那个方向：真正的自然语言比结构化文本更便宜。
  const realProse =
    'The runtime records every message to an append only transcript so that a session ' +
    'can be resumed after a crash without replaying any provider calls at all here.'
  const jsonish = JSON.stringify({
    tools: Array.from({ length: 4 }, (_, i) => ({ name: `t${i}`, args: { path: 'x' } })),
  }).padEnd(realProse.length, ' ')
  assert(
    jsonish.length === realProse.length,
    'setup: the two samples really are the same length, so the comparison is about class not size',
  )
  assert(
    estimateTextTokens(realProse) < estimateTextTokens(jsonish),
    'natural-language prose costs fewer tokens per character than structured text',
  )
  // 安全关键：同样字数的 CJK 必须比拉丁贵。
  // 二者同价正是此前中文被低估 53% 的根因。
  const cjk = '压缩绝不能拿可恢复性去换更高的压缩率'
  assert(
    estimateTextTokens(cjk) > estimateTextTokens('a'.repeat(cjk.length)),
    'CJK costs more per character than Latin',
  )
  const withTools: ChatMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'c1',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'echo hi' }),
      },
    ],
  }
  assert(
    estimateMessageTokens(withTools) >
      estimateMessageTokens({ role: 'assistant', content: '' }),
    'tool_calls add tokens',
  )
  assert(estimateTokens([withTools]) === estimateMessageTokens(withTools), 'sum')

  const thr = getAutoCompactThreshold(128_000)
  const eff = getEffectiveContextWindow(128_000)
  assert(eff === 128_000 - Math.min(20_000, Math.floor(128_000 * 0.15)), 'effective')
  assert(thr === Math.max(1_000, eff - AUTOCOMPACT_BUFFER_TOKENS), 'threshold formula')
  assert(thr < 128_000 - 10_000, 'threshold near window, not mid-session')

  const mid = getContextPressure({
    tokenCount: Math.floor(thr * 0.5),
    contextWindowTokens: 128_000,
  })
  assert(mid.level === 'ok', 'half threshold → ok')
  const near = getContextPressure({
    tokenCount: thr - 1,
    contextWindowTokens: 128_000,
  })
  assert(near.level === 'warn' || near.level === 'ok', 'just under threshold')
  const at = getContextPressure({
    tokenCount: thr,
    contextWindowTokens: 128_000,
  })
  assert(at.level === 'critical', 'at threshold → critical')
  assert(at.aboveAutoThreshold === true, 'aboveAutoThreshold')
  const over = getContextPressure({
    tokenCount: 128_000,
    contextWindowTokens: 128_000,
  })
  assert(over.level === 'over', 'full window → over')

  // ── AR2A0a：混合 usage 锚定 token 计数 ──
  const {
    hybridTokenCount,
    fingerprintMessagePrefix,
    resolveAutoCompactTokenCount,
    CONSERVATIVE_ESTIMATE_PAD,
  } = await import('../packages/compact/src/index.ts')

  const head: ChatMessage[] = [
    { role: 'user', content: 'question one '.repeat(20) },
    { role: 'assistant', content: 'answer one '.repeat(20) },
  ]
  const tail: ChatMessage[] = [
    { role: 'assistant', content: 'calling tool', tool_calls: [{ id: 'c9', name: 'Bash', arguments: '{"command":"ls"}' }] },
    { role: 'tool', content: 'tool output '.repeat(60), tool_call_id: 'c9' },
  ]
  const full = [...head, ...tail]
  const anchor = {
    anchorInputTokens: 5_000,
    anchoredMessageCount: head.length,
    fingerprint: fingerprintMessagePrefix(full, head.length),
  }

  // (a) 无锚 → 全量估算
  const hNo = hybridTokenCount({ messages: full })
  assert(hNo.source === 'estimate', 'no anchor → estimate source')
  assert(hNo.tokenCount === estimateTokens(full), 'no anchor equals estimateTokens')

  // (b) 锚 == 全长 → 纯 usage
  const hFull = hybridTokenCount({
    messages: head,
    anchor: { ...anchor, fingerprint: fingerprintMessagePrefix(head, head.length) },
  })
  assert(hFull.source === 'usage', 'anchor at full length → usage source')
  assert(hFull.tokenCount === 5_000, 'anchor at full length equals anchor input')

  // (c) 锚 + 尾部 → anchor + (padded) tail 估算
  const tailEst = estimateTokens(tail)
  const hPad = hybridTokenCount({ messages: full, anchor, pad: true })
  assert(hPad.source === 'hybrid', 'anchor+tail → hybrid source')
  assert(
    hPad.tokenCount === 5_000 + Math.ceil(tailEst * CONSERVATIVE_ESTIMATE_PAD),
    'hybrid = anchor + padded tail estimate',
  )
  const hNoPad = hybridTokenCount({ messages: full, anchor })
  assert(hNoPad.tokenCount === 5_000 + tailEst, 'hybrid without pad = anchor + tail estimate')

  // (d) 指纹失配（头部被 snip/compact 改写）→ 回退全量估算
  const rewrittenHead: ChatMessage[] = [
    { role: 'system', content: 'Conversation compacted' },
    { role: 'user', content: 'SUMMARY' },
  ]
  const hMismatch = hybridTokenCount({
    messages: [...rewrittenHead, ...tail],
    anchor,
  })
  assert(hMismatch.source === 'estimate', 'fingerprint mismatch → estimate fallback')
  assert(
    hMismatch.tokenCount === estimateTokens([...rewrittenHead, ...tail]),
    'mismatch equals full estimate',
  )

  // (e) micro 只改内容不改 role/tool_calls → 锚仍有效
  const microHead: ChatMessage[] = [
    { role: 'user', content: '[Old tool result content cleared]' },
    { role: 'assistant', content: 'answer one '.repeat(20) },
  ]
  const hMicro = hybridTokenCount({ messages: [...microHead, ...tail], anchor })
  assert(hMicro.source === 'hybrid', 'content-only rewrite keeps anchor valid')

  // (f) 锚超过消息数（compact 缩短）→ 回退
  const hShrunk = hybridTokenCount({
    messages: head.slice(0, 1),
    anchor,
  })
  assert(hShrunk.source === 'estimate', 'anchored count beyond length → estimate fallback')

  // resolveAutoCompactTokenCount：anchor 路径 → hybrid；旧路径不变
  const rHybrid = resolveAutoCompactTokenCount({
    estimateTokens: estimateTokens(full),
    anchor,
    messages: full,
    pad: true,
  })
  assert(rHybrid.source === 'hybrid', 'resolve reports hybrid source')
  assert(rHybrid.tokenCount === hPad.tokenCount, 'resolve matches hybridTokenCount')
  const rOld = resolveAutoCompactTokenCount({
    estimateTokens: 123,
    usageInputTokens: 456,
  })
  assert(rOld.source === 'usage' && rOld.tokenCount === 456, 'legacy usage path unchanged')

  // shouldAutoCompact：锚值低于阈值但追加尾部后 hybrid 过阈值 → 触发（修复迟触发）
  const win = 64_000
  const thr2 = getAutoCompactThreshold(win)
  const bigTail: ChatMessage[] = [
    { role: 'tool', content: 'y'.repeat(80_000), tool_call_id: 'c1' },
  ]
  const anchoredMsgs = [...head, ...bigTail]
  const nearAnchor = {
    anchorInputTokens: thr2 - 1_000,
    anchoredMessageCount: head.length,
    fingerprint: fingerprintMessagePrefix(anchoredMsgs, head.length),
  }
  assert(
    shouldAutoCompact({
      tokenCount: 0,
      usageInputTokens: nearAnchor.anchorInputTokens,
      contextWindowTokens: win,
      enabled: true,
      consecutiveFailures: 0,
    }) === false,
    'legacy usage-only path stays below threshold (documents the old gap)',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 0,
      contextWindowTokens: win,
      enabled: true,
      consecutiveFailures: 0,
      anchor: nearAnchor,
      messages: anchoredMsgs,
      pad: true,
    }) === true,
    'hybrid anchor + appended tail crosses threshold',
  )
  assert(
    shouldAutoCompact({
      tokenCount: 0,
      contextWindowTokens: win,
      enabled: true,
      consecutiveFailures: 0,
      querySource: 'compact',
      anchor: nearAnchor,
      messages: anchoredMsgs,
      pad: true,
    }) === false,
    'hybrid path still refuses compact querySource',
  )

  // ── AR2A0b：summary 标记 + 二次 compact 合并提示（防重摘要）──
  const {
    COMPACT_SUMMARY_MARKER,
    COMPACT_MERGE_PRIOR_SUMMARY_HINT,
    isCompactSummaryMessage,
    getCompactUserSummaryMessage,
  } = await import('../packages/compact/src/index.ts')

  const summaryMsg: ChatMessage = {
    role: 'user',
    content: getCompactUserSummaryMessage(
      '<summary>\n1. Primary Request and Intent:\n   earlier work.\n</summary>',
    ),
  }
  assert(
    summaryMsg.content.startsWith(COMPACT_SUMMARY_MARKER),
    'summary message carries stable marker prefix',
  )
  assert(isCompactSummaryMessage(summaryMsg), 'summary message detected')
  assert(
    !isCompactSummaryMessage({ role: 'user', content: 'normal user msg' }),
    'normal user msg not summary',
  )
  assert(
    !isCompactSummaryMessage({
      role: 'assistant',
      content: summaryMsg.content,
    }),
    'assistant echo not treated as summary',
  )

  // 二次 compact：历史含旧 summary → prompt 注入合并提示 + metadata 标记
  let capturedPrompt = ''
  const second = await runFullCompact({
    messages: [
      { role: 'system', content: 'Conversation compacted' },
      summaryMsg,
      { role: 'user', content: 'more work after first compact' },
      { role: 'assistant', content: 'did more work' },
      { role: 'user', content: 'latest question' },
      { role: 'assistant', content: 'latest answer' },
    ],
    trigger: 'auto',
    keepRecentUserTurns: 1,
    summarize: async ({ compactPrompt }) => {
      capturedPrompt = compactPrompt
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   merged summary.\n</summary>`,
      }
    },
  })
  assert(second.ok === true, 'second compact succeeds')
  assert(
    capturedPrompt.includes(COMPACT_MERGE_PRIOR_SUMMARY_HINT),
    'merge hint injected when prior summary present',
  )
  if (second.ok) {
    assert(
      second.result.boundary.compactMetadata.mergedPriorSummary === true,
      'boundary metadata marks merged prior summary',
    )
  }

  // 首次 compact（无旧 summary）→ 不注入提示
  let firstPrompt = ''
  const first = await runFullCompact({
    messages: [
      { role: 'user', content: 'fresh question' },
      { role: 'assistant', content: 'fresh answer' },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'done' },
    ],
    trigger: 'manual',
    keepRecentUserTurns: 1,
    summarize: async ({ compactPrompt }) => {
      firstPrompt = compactPrompt
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   fresh summary.\n</summary>`,
      }
    },
  })
  assert(first.ok === true, 'fresh compact succeeds')
  assert(
    !firstPrompt.includes(COMPACT_MERGE_PRIOR_SUMMARY_HINT),
    'no merge hint without prior summary',
  )
  if (first.ok) {
    assert(
      first.result.boundary.compactMetadata.mergedPriorSummary === undefined,
      'no mergedPriorSummary flag on fresh compact',
    )
  }

  console.log('COMPACT TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})