/**
 * CMP-2 · 两遍预压缩（prefire pass1）
 *
 * 覆盖：
 * - shouldPrecompact 阈值（≥80% true / <80% false / 0 窗口 false）
 * - 预热启动（mock summarize → session.precompact 落位：count/指纹/summary）
 * - 预热跳过（进行中不重复启动 / 未达阈值不启动）
 * - commit 引用检查（预热完成前压缩清空 → 结果丢弃）
 * - buildPrecompactMessages 命中/未命中（无预热/指纹不匹配/前缀变了）
 * - compactSession 集成：预热后压缩只吃新增消息（增量第二遍）
 * - 预热失败静默（下次可再预热）
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import {
  createSession,
  compactSession,
  buildPrecompactMessages,
  startPrecompactWarmup,
  shouldPrecompact,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

const WINDOW = 128_000

const bigMessage = (tag: string): ChatMessage => ({
  role: 'user',
  content: `${tag} ${'x'.repeat(3_490)}`, // ≈ 1000 tok/条（3.5 chars/token）
})

const provider: LlmProvider = {
  id: 'mock',
  async *completeStream() {
    yield { type: 'text_delta', text: 'ok' }
    yield { type: 'done' }
  },
}

/** 预热 prompt 特征串 */
const warmupPromptMarker = 'conversation prefix'
const compactPromptMarker = 'TEXT ONLY'

function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

// --- 1. shouldPrecompact 阈值 ---
{
  assert.equal(shouldPrecompact([], WINDOW), false, 'empty: false')
  assert.equal(shouldPrecompact([bigMessage('a')], 0), false, 'zero window: false')
  // 26 条 ≈ 26_078 tok，远低于预热带 → false
  assert.equal(
    shouldPrecompact(Array.from({ length: 26 }, (_, i) => bigMessage(`m${i}`)), WINDOW),
    false,
    'below warmup band: false',
  )
  // 88 条 ≈ 88_264 tok ≥ 87_800（auto 95_800 - 8_000）→ true
  assert.equal(
    shouldPrecompact(Array.from({ length: 88 }, (_, i) => bigMessage(`m${i}`)), WINDOW),
    true,
    'inside warmup band: true',
  )
  // 96 条 ≈ 96_288 ≥ auto 阈值 → false（已到压缩区，不预热）
  assert.equal(
    shouldPrecompact(Array.from({ length: 96 }, (_, i) => bigMessage(`m${i}`)), WINDOW),
    false,
    'at auto threshold: false',
  )
}

// --- 2. buildPrecompactMessages 命中/未命中（纯函数）---
{
  const msgs = Array.from({ length: 30 }, (_, i) => bigMessage(`m${i}`))
  const state = {
    at: 1,
    count: 25,
    headFingerprint: 'f0',
    summaryText: 'prefix summary',
  }
  assert.equal(buildPrecompactMessages(msgs, undefined), undefined, 'no state: undefined')
  // 指纹不匹配（state 的指纹是假的）→ 回退
  assert.equal(buildPrecompactMessages(msgs, state), undefined, 'mismatch: undefined')
  // 构造真实指纹
  const head = msgs.slice(0, 25)
  const real = { ...state, headFingerprint: fingerprint(head) }
  const merged = buildPrecompactMessages(msgs, real)
  assert(merged, 'match: merged short chain')
  assert.equal(merged!.length, 1 + (30 - 25), 'match: summary + new tail')
  assert.equal(merged![0]!.role, 'user', 'match: summary is user message')
  assert(
    String(merged![0]!.content).includes('prefix summary'),
    'match: summary content carried',
  )
  assert.equal(merged![1]!.content, msgs[25]!.content, 'match: new messages follow')
  // 前缀被改动（插入中间）→ 回退
  const tampered = [...msgs.slice(0, 5), bigMessage('inserted'), ...msgs.slice(5)]
  assert.equal(buildPrecompactMessages(tampered, real), undefined, 'tampered: undefined')
}

function fingerprint(messages: readonly ChatMessage[]): string {
  let h = 0
  for (const m of messages) {
    const s = `${m.role}\u0000${m.content}`
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `f${h >>> 0}`
}

// --- 3. 预热启动 + 跳过 + commit 引用检查 ---
{
  const calls: string[] = []
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    contextWindowTokens: WINDOW,
    provider,
    compactSummarizer: async ({ compactPrompt }) => {
      calls.push(compactPrompt)
      return { text: `warm ${calls.length}` }
    },
  })
  // 未达 80% → 不启动
  session.messages.push(...Array.from({ length: 26 }, (_, i) => bigMessage(`m${i}`)))
  startPrecompactWarmup({
    messages: () => session.messages,
    summarize: session.compactSummarizer!,
    contextWindowTokens: WINDOW,
    current: () => session.precompact,
    commit: (s) => {
      session.precompact = s
    },
    markInFlight: () => {
      if (session.precompactInFlight) return false
      session.precompactInFlight = true
      return true
    },
    clearInFlight: () => {
      session.precompactInFlight = false
    },
    summarizeTimeoutMs: 1_000,
  })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(session.precompact, undefined, 'below threshold: no warmup')
  assert.equal(calls.length, 0, 'below threshold: summarizer untouched')
  assert.equal(session.precompactInFlight, false, 'below threshold: no in-flight left')

  // 达预热带 → 预热启动并落位
  session.messages.push(...Array.from({ length: 62 }, (_, i) => bigMessage(`w${i}`)))
  startPrecompactWarmup({
    messages: () => session.messages,
    summarize: session.compactSummarizer!,
    contextWindowTokens: WINDOW,
    current: () => session.precompact,
    commit: (s) => {
      session.precompact = s
    },
    markInFlight: () => {
      if (session.precompactInFlight) return false
      session.precompactInFlight = true
      return true
    },
    clearInFlight: () => {
      session.precompactInFlight = false
    },
    summarizeTimeoutMs: 1_000,
  })
  await waitFor(() => session.precompact !== undefined, 3_000)
  const pc = session.precompact!
  assert.equal(pc.summaryText, 'warm 1', 'warmup summary text')
  assert.equal(pc.count, 88 - 1, 'warmup count excludes keep tail')
  assert.equal(session.precompactInFlight, false, 'completed: in-flight cleared')
  assert(
    calls.every((c) => c.includes(warmupPromptMarker)),
    'warmup used precompact prompt',
  )

  // 进行中（in-flight）→ 不再启动（markInFlight 抢占拒绝）
  session.precompact = undefined
  let slowCalls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    release = r
  })
  startPrecompactWarmup({
    messages: () => session.messages,
    summarize: async () => {
      slowCalls += 1
      await gate
      return { text: 'slow warm' }
    },
    contextWindowTokens: WINDOW,
    current: () => session.precompact,
    commit: (s) => {
      session.precompact = s
    },
    markInFlight: () => {
      if (session.precompactInFlight) return false
      session.precompactInFlight = true
      return true
    },
    clearInFlight: () => {
      session.precompactInFlight = false
    },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(slowCalls, 1, 'first warmup started')
  startPrecompactWarmup({
    messages: () => session.messages,
    summarize: async () => {
      slowCalls += 1
      return { text: 'dup' }
    },
    contextWindowTokens: WINDOW,
    current: () => session.precompact,
    commit: (s) => {
      session.precompact = s
    },
    markInFlight: () => {
      if (session.precompactInFlight) return false
      session.precompactInFlight = true
      return true
    },
    clearInFlight: () => {
      session.precompactInFlight = false
    },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(slowCalls, 1, 'in-flight dedup: no second warmup')
  release!()
  await waitFor(() => session.precompact !== undefined, 3_000)
  assert.equal(session.precompact!.summaryText, 'slow warm', 'first warmup wins')

  // commit at 比较：预热进行中种下更新的状态 → 晚到旧结果不覆盖
  session.precompact = undefined
  let release2: (() => void) | undefined
  const gate2 = new Promise<void>((r) => {
    release2 = r
  })
  startPrecompactWarmup({
    messages: () => session.messages,
    summarize: async () => {
      await gate2
      return { text: 'old result' }
    },
    contextWindowTokens: WINDOW,
    current: () => session.precompact,
    commit: (s) => {
      if (!session.precompact || session.precompact.at < s.at) {
        session.precompact = s
      }
    },
    markInFlight: () => {
      if (session.precompactInFlight) return false
      session.precompactInFlight = true
      return true
    },
    clearInFlight: () => {
      session.precompactInFlight = false
    },
    summarizeTimeoutMs: 1_000,
  })
  await new Promise((r) => setTimeout(r, 30))
  // 预热仍在跑时种下更新状态（模拟压缩后新预热已占位）
  const newerAt = Date.now() + 100_000
  session.precompact = { at: newerAt, count: 0, headFingerprint: 'x', summaryText: 'newer' }
  release2!()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(
    session.precompact!.at,
    newerAt,
    'late older result rejected by at compare',
  )
  session.precompact = undefined

  // stale 防护：压缩开始后（invalidBefore）→ 压缩前启动的预热结果拒绝落槽
  let release3: (() => void) | undefined
  const gate3 = new Promise<void>((r) => {
    release3 = r
  })
  startPrecompactWarmup({
    messages: () => session.messages,
    summarize: async () => {
      await gate3
      return { text: 'stale result' }
    },
    contextWindowTokens: WINDOW,
    current: () => session.precompact,
    commit: (s) => {
      if (s.at < (session.precompactInvalidBefore ?? 0)) return
      if (!session.precompact || session.precompact.at < s.at) {
        session.precompact = s
      }
    },
    markInFlight: () => {
      if (session.precompactInFlight) return false
      session.precompactInFlight = true
      return true
    },
    clearInFlight: () => {
      session.precompactInFlight = false
    },
    summarizeTimeoutMs: 1_000,
  })
  await new Promise((r) => setTimeout(r, 30))
  // 模拟压缩开始：清状态 + 记录 invalidBefore
  session.precompact = undefined
  session.precompactInvalidBefore = Date.now()
  release3!()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(
    session.precompact,
    undefined,
    'stale warmup result rejected after compact',
  )
  session.precompactInvalidBefore = undefined
}

// --- 4. 预热失败静默 ---
{
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    contextWindowTokens: WINDOW,
    provider,
    compactSummarizer: async () => {
      throw new Error('warmup boom')
    },
  })
  session.messages.push(...Array.from({ length: 88 }, (_, i) => bigMessage(`m${i}`)))
  startPrecompactWarmup({
    messages: () => session.messages,
    summarize: session.compactSummarizer!,
    contextWindowTokens: WINDOW,
    current: () => session.precompact,
    commit: (s) => {
      session.precompact = s
    },
    markInFlight: () => {
      if (session.precompactInFlight) return false
      session.precompactInFlight = true
      return true
    },
    clearInFlight: () => {
      session.precompactInFlight = false
    },
    summarizeTimeoutMs: 500,
  })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(session.precompact, undefined, 'failure: no warmup state')
  assert.equal(session.precompactInFlight, false, 'failure: in-flight cleared')
}

// --- 5. compactSession 集成：预热后压缩只吃新增（增量第二遍）---
{
  const calls: Array<{ prompt: string; messages: ChatMessage[] }> = []
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: WINDOW,
    provider,
    compactSummarizer: async ({ compactPrompt, messages }) => {
      calls.push({ prompt: compactPrompt, messages: [...messages] })
      if (compactPrompt.includes(warmupPromptMarker)) {
        return { text: 'PREFIX SUMMARY' }
      }
      return {
        text: '<summary>\n1. Primary Request and Intent:\n   Incremental compact test.\n8. Current Work:\n   Verifying pass1 merge.\n</summary>',
      }
    },
  })
  // 88 条 ≈ 88_264（预热带）
  session.messages.push(...Array.from({ length: 88 }, (_, i) => bigMessage(`m${i}`)))
  const warm = await session.tryMidTurnCompact!()
  assert.equal(warm, false, 'below auto threshold: no compact yet')
  await waitFor(() => session.precompact !== undefined, 3_000)
  assert(session.precompact, 'precompact state landed via tryMidTurnCompact')
  const warmCall = calls.find((c) => c.prompt.includes(warmupPromptMarker))
  assert(warmCall, 'warmup summarizer call happened')
  assert(
    warmCall!.messages.length < 88,
    'warmup summarized only the prefix (keep tail excluded)',
  )

  // 再塞 8 条（≈ +8_024 → 96_288 ≥ auto 阈值 95_800）→ compact 触发
  session.messages.push(...Array.from({ length: 8 }, (_, i) => bigMessage(`n${i}`)))
  const out = await compactSession(session, 'manual')
  assert(out.ok === true, `compact ok: ${out.reason ?? ''}`)
  const compactCalls = calls.filter((c) => c.prompt.includes(compactPromptMarker))
  assert(compactCalls.length >= 1, 'compact summarizer called')
  const compactCall = compactCalls[compactCalls.length - 1]!
  // 增量第二遍：压缩调用只吃 summary 消息 + 新增 8 条 + keep 尾部，远小于全量 96
  assert(
    compactCall.messages.length <= 15,
    `incremental: compact summarizer got ${compactCall.messages.length} messages (expected ≤15)`,
  )
  assert(
    compactCall.messages.some((m) => String(m.content).includes('PREFIX SUMMARY')),
    'incremental: pass1 summary fed into pass2',
  )
  assert(session.precompact === undefined, 'compact cleared precompact state')
}

// --- 6. 预热开关关闭时不启动 ---
{
  const calls: string[] = []
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    contextWindowTokens: WINDOW,
    provider,
    compactSummarizer: async ({ compactPrompt }) => {
      calls.push(compactPrompt)
      return { text: 'warm' }
    },
  })
  session.precompactEnabled = false
  session.messages.push(...Array.from({ length: 88 }, (_, i) => bigMessage(`m${i}`)))
  await session.tryMidTurnCompact!()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(session.precompact, undefined, 'disabled: no warmup state')
  assert.equal(calls.length, 0, 'disabled: summarizer untouched')
}

await fs.rm(os.tmpdir(), { recursive: false, force: false }).catch(() => {})
console.log('PASS: CMP-2 prefire pass1 precompact')
