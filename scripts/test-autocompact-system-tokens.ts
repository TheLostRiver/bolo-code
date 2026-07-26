/**
 * C3：auto-compact 阈值判断必须把 system 段算进去
 *
 * 背景：system 段不小——identity + rules + task style + task tracking + tools
 * + BOLO.md（单文件预算 32k 字符、合计 48k）+ skill catalog + memory + env。
 * 但 createAutoCompactPrepare 的估算分支只数 messages。
 *
 * 生效窗口是**冷启动**：有 usage 锚或 API usage 时走真实计数（服务端本就含
 * system），只有两者都没有时才落到估算。典型触发场景：resume 一个大会话后
 * 立刻发一句——此时本进程还没有任何 usage，估算偏小 → 判定「不用压缩」→
 * 请求超窗 → PTL → 走有损的截头重试，而不是干净的摘要压缩。
 *
 * 契约：
 * - 无锚无 usage：阈值判断 = messages + system
 * - 有锚：**不得**重复计入 system（锚的 input tokens 已含）
 * - 未提供 system 段：行为与从前一致
 *
 * 运行：npx tsx scripts/test-autocompact-system-tokens.ts
 */
import {
  estimateSystemSectionsTokens,
  estimateTokens,
  getAutoCompactThreshold,
  type ChatMessage,
} from '../packages/compact/src/index.ts'
import { createAutoCompactPrepare } from '../packages/core/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const CONTEXT_WINDOW = 64_000

/** 造一批消息，总估算 token 数接近 target */
function messagesOfTokens(target: number): ChatMessage[] {
  // estimateTextTokens 大致 chars/4；每条另有 role 开销
  const perMessageChars = 4_000
  const out: ChatMessage[] = []
  while (estimateTokens(out) < target) {
    out.push({ role: 'user', content: 'x'.repeat(perMessageChars) })
  }
  return out
}

async function main() {
  const threshold = getAutoCompactThreshold(CONTEXT_WINDOW)

  // system 段做得足够大，才能把「刚好不到阈值」推过线
  const systemSections = ['# Identity\n' + 'y'.repeat(40_000)]
  const systemTokens = estimateSystemSectionsTokens(systemSections)
  assert(systemTokens > 1_000, `system sections are substantial: ${systemTokens}`)

  // 消息本身刚好在阈值之下，但加上 system 就越线
  const messages = messagesOfTokens(threshold - Math.floor(systemTokens / 2))
  const messageTokens = estimateTokens(messages)
  assert(
    messageTokens < threshold,
    `messages alone stay under threshold (${messageTokens} < ${threshold})`,
  )
  assert(
    messageTokens + systemTokens > threshold,
    `messages plus system cross it (${messageTokens + systemTokens} > ${threshold})`,
  )

  // ── 1) 不传 system 段：维持旧行为，不触发 ──
  {
    let ran = false
    const prepare = createAutoCompactPrepare({
      enabled: true,
      contextWindowTokens: CONTEXT_WINDOW,
      runAutoCompact: async (m) => {
        ran = true
        return m
      },
    })
    await prepare({ messages: [...messages], querySource: 'repl_main_thread', tokenCount: 0 })
    assert(!ran, 'without system sections the old estimate is unchanged')
  }

  // ── 2) 传了 system 段：必须触发 ──
  {
    let ran = false
    const prepare = createAutoCompactPrepare({
      enabled: true,
      contextWindowTokens: CONTEXT_WINDOW,
      getSystemPromptSections: () => systemSections,
      runAutoCompact: async (m) => {
        ran = true
        return m
      },
    })
    await prepare({ messages: [...messages], querySource: 'repl_main_thread', tokenCount: 0 })
    assert(
      ran,
      'system prompt counts toward the threshold on the estimate path',
    )
  }

  // ── 3) 有锚时不得重复计入 system（锚的 input 已含服务端计数） ──
  {
    let ran = false
    // 锚记录的真实 input 远低于阈值；若实现把 system 又加一遍就会误触发
    const prepare = createAutoCompactPrepare({
      enabled: true,
      contextWindowTokens: CONTEXT_WINDOW,
      getSystemPromptSections: () => systemSections,
      getUsageAnchor: () => ({
        anchorInputTokens: 1_000,
        anchoredMessageCount: messages.length,
      }),
      runAutoCompact: async (m) => {
        ran = true
        return m
      },
    })
    await prepare({ messages: [...messages], querySource: 'repl_main_thread', tokenCount: 0 })
    assert(
      !ran,
      'anchor path already includes system tokens; must not double count',
    )
  }

  // ── 4) 有 API usage 时同理不得重复计入 ──
  {
    let ran = false
    const prepare = createAutoCompactPrepare({
      enabled: true,
      contextWindowTokens: CONTEXT_WINDOW,
      getSystemPromptSections: () => systemSections,
      getUsageInputTokens: () => 1_000,
      runAutoCompact: async (m) => {
        ran = true
        return m
      },
    })
    await prepare({ messages: [...messages], querySource: 'repl_main_thread', tokenCount: 0 })
    assert(!ran, 'real API usage already includes system tokens')
  }

  // ── 5) 空 / 缺失 system 段不得炸 ──
  {
    const prepare = createAutoCompactPrepare({
      enabled: true,
      contextWindowTokens: CONTEXT_WINDOW,
      getSystemPromptSections: () => undefined,
      runAutoCompact: async (m) => m,
    })
    const r = await prepare({ messages: [], querySource: 'repl_main_thread', tokenCount: 0 })
    assert(Array.isArray(r.messages), 'undefined sections handled')

    const prepare2 = createAutoCompactPrepare({
      enabled: true,
      contextWindowTokens: CONTEXT_WINDOW,
      getSystemPromptSections: () => [],
      runAutoCompact: async (m) => m,
    })
    const r2 = await prepare2({ messages: [], querySource: 'repl_main_thread', tokenCount: 0 })
    assert(Array.isArray(r2.messages), 'empty sections handled')
  }

  console.log('PASS: auto-compact counts system prompt tokens')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
