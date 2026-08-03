/**
 * auto compact 挂 prepareMessages + compactSession 接线（fake summarizer，无网络）
 * 运行：npx tsx scripts/test-auto-compact.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getAutoCompactThreshold,
  estimateTokens,
  type ChatMessage,
} from '../packages/compact/src/index.ts'
import {
  createSession,
  submitPrompt,
  compactSession,
  saveSession,
} from '../packages/core/src/index.ts'
import { createAutoCompactPrepare } from '../packages/core/src/deps.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 无 tool 的短回复，避免 mock 默认 Bash 路径 */
function textOnlyProvider(reply = 'ok-after-compact'): LlmProvider {
  return {
    id: 'mock-text',
    async *completeStream() {
      yield { type: 'text_delta', text: reply }
      yield { type: 'done' }
    },
    async completeText() {
      return 'unused'
    },
  }
}

async function main() {
  // ── 1) createAutoCompactPrepare 纯路径 ──
  let ran = 0
  const prepare = createAutoCompactPrepare({
    enabled: true,
    contextWindowTokens: 8_000,
    runAutoCompact: async () => {
      ran += 1
      return [
        { role: 'system', content: 'Conversation compacted' },
        { role: 'user', content: 'SUMMARY_BODY' },
      ]
    },
  })

  const small: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  const r0 = await prepare({
    messages: small,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(r0.didCompact !== true, 'small context no compact')
  assert(ran === 0, 'summarizer not called for small')

  const threshold = getAutoCompactThreshold(8_000)
  const pad = 'x'.repeat((threshold + 100) * 4)
  const fat: ChatMessage[] = [{ role: 'user', content: pad }]
  assert(estimateTokens(fat) >= threshold, 'fixture over threshold')

  const r1 = await prepare({
    messages: fat,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(r1.didCompact === true, 'didCompact true')
  assert(ran === 1, 'runAutoCompact once')
  assert(
    r1.messages.some((m) => m.content === 'SUMMARY_BODY'),
    'summary in prepared messages',
  )

  const r2 = await prepare({
    messages: fat,
    querySource: 'compact',
    tokenCount: 0,
  })
  assert(r2.didCompact !== true, 'no compact when querySource=compact')
  assert(ran === 1, 'still one run')

  // ── 1b) AR2A0a：getUsageAnchor 混合计数修复迟触发 ──
  const { fingerprintMessagePrefix } = await import(
    '../packages/compact/src/index.ts'
  )
  const win = 64_000
  const winThr = getAutoCompactThreshold(win)
  const anchorHead: ChatMessage[] = [
    { role: 'user', content: 'q '.repeat(40) },
    { role: 'assistant', content: 'a '.repeat(40) },
  ]
  // 尾部追加的大 tool 输出：估算 ~20k tokens，远低于阈值(~41k)
  const anchorMsgs: ChatMessage[] = [
    ...anchorHead,
    { role: 'tool', content: 'y'.repeat(80_000), tool_call_id: 'c1' },
  ]
  assert(estimateTokens(anchorMsgs) < winThr, 'pure estimate below threshold')

  let hybridRan = 0
  const hybridPrepare = createAutoCompactPrepare({
    enabled: true,
    contextWindowTokens: win,
    runAutoCompact: async () => {
      hybridRan += 1
      return [
        { role: 'system', content: 'Conversation compacted' },
        { role: 'user', content: 'HYBRID_SUMMARY' },
      ]
    },
    // 锚：上次 API input 已接近阈值，但尚未越过
    getUsageAnchor: () => ({
      anchorInputTokens: winThr - 1_000,
      anchoredMessageCount: anchorHead.length,
      fingerprint: fingerprintMessagePrefix(anchorMsgs, anchorHead.length),
    }),
  })
  const rHy = await hybridPrepare({
    messages: anchorMsgs,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(rHy.didCompact === true, 'hybrid anchor triggers compact (old path missed it)')
  assert(hybridRan === 1, 'hybrid runAutoCompact once')

  // 锚失效（消息被重写）→ 回退全量估算 → 不触发
  let staleRan = 0
  const stalePrepare = createAutoCompactPrepare({
    enabled: true,
    contextWindowTokens: win,
    runAutoCompact: async () => {
      staleRan += 1
      return null
    },
    getUsageAnchor: () => ({
      anchorInputTokens: winThr - 1_000,
      anchoredMessageCount: 2,
      fingerprint: 'stale-fingerprint',
    }),
  })
  const rStale = await stalePrepare({
    messages: anchorMsgs,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(rStale.didCompact !== true, 'stale anchor falls back to estimate (below threshold)')
  assert(staleRan === 0, 'stale anchor does not trigger compact')

  // ── 2) session：auto → compactSession + summarizer ──
  let summarizeCalls = 0
  const longContent = 'y'.repeat((getAutoCompactThreshold(8_000) + 200) * 4)
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: 8_000,
    provider: textOnlyProvider(),
    compactSummarizer: async ({ compactPrompt }) => {
      // MEM-1：压缩前 flush 用不同 prompt 复用同一 summarizer——按 prompt 区分
      if (compactPrompt.includes('memory daily log')) {
        return { text: '' } // MEM-1 flush 分支：空文本不落盘，避免污染真实 daily log
      }
      summarizeCalls += 1
      assert(compactPrompt.includes('TEXT ONLY'), 'compact prompt no-tools')
      return {
        text: `<analysis>x</analysis><summary>\n1. Primary Request and Intent:\n   Auto compact test.\n8. Current Work:\n   Wiring prepareMessages.\n</summary>`,
      }
    },
  })

  session.messages.push({ role: 'user', content: longContent })
  session.messages.push({
    role: 'assistant',
    content: 'ack ' + 'z'.repeat(200),
  })

  const beforeLen = session.messages.length
  const terminal = await submitPrompt(session, 'continue please', {
    maxTurns: 2,
  })
  assert(terminal.reason === 'completed', `terminal=${terminal.reason}`)
  assert(summarizeCalls >= 1, 'auto compact invoked summarizer')
  assert(
    session.messages.some((m) =>
      String(m.content).includes('Auto compact test'),
    ),
    'summary text in session messages',
  )
  assert(
    session.messages.some((m) => m.content === 'Conversation compacted'),
    'boundary present',
  )
  assert(
    !session.messages.some((m) => m.content === longContent),
    'fat prefix removed from API view',
  )
  assert(session.messages.length < beforeLen + 5, 'messages shortened')

  // ── 3) 无 summarizer 时即使 enabled 也不挂 auto ──
  const sessNoSum = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: 8_000,
    provider: textOnlyProvider(),
  })
  const prep = await sessNoSum.deps.prepareMessages({
    messages: fat,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(prep.didCompact !== true, 'no auto without summarizer')

  // ── 4) manual compact 仍可用 ──
  const sessManual = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: false,
    provider: textOnlyProvider(),
    compactSummarizer: async ({ compactPrompt }) => {
      if (compactPrompt.includes('memory daily log')) return { text: '' }
      return {
        text: `<summary>manual ok</summary>`,
      }
    },
  })
  sessManual.messages.push({ role: 'user', content: 'a' })
  sessManual.messages.push({ role: 'assistant', content: 'b' })
  const man = await compactSession(sessManual, 'manual')
  assert(man.ok === true, 'manual compact ok')
  assert(
    sessManual.messages.some((m) => String(m.content).includes('manual ok')),
    'manual summary',
  )

  // ── 5) compact 成功后 jsonl 含 compact_boundary ──
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-compact-jsonl-'))
  const sessionsDir = path.join(tmpRoot, 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })
  const sessDisk = await createSession({
    cwd: tmpRoot,
    sessionId: 'sess_boundary',
    systemPrompt: false,
    autoSave: { sessionsDir, scope: 'project' },
    provider: textOnlyProvider(),
    compactSummarizer: async ({ compactPrompt }) => {
      if (compactPrompt.includes('memory daily log')) return { text: '' }
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   Boundary test.\n</summary>`,
      }
    },
  })
  sessDisk.messages.push({ role: 'user', content: 'hello boundary' })
  sessDisk.messages.push({ role: 'assistant', content: 'ack boundary' })
  // opt-in JSON 以验证 compact 不改 JSON 快照
  await saveSession(sessDisk, { sessionsDir, writeJsonSnapshot: true })
  const jsonPath = path.join(sessionsDir, 'sess_boundary.json')
  const jsonlPath = path.join(sessionsDir, 'sess_boundary.jsonl')
  const jsonBefore = await fs.readFile(jsonPath, 'utf8')
  const rBound = await compactSession(sessDisk, 'manual')
  assert(rBound.ok === true, 'boundary compact ok')
  const jsonAfter = await fs.readFile(jsonPath, 'utf8')
  assert(jsonAfter === jsonBefore, 'JSON snapshot unchanged by compact boundary write')
  const jsonlRaw = await fs.readFile(jsonlPath, 'utf8')
  const boundaryLines = jsonlRaw
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type?: string; summary?: string })
  assert(
    boundaryLines.some((e) => e.type === 'compact_boundary'),
    'jsonl has compact_boundary line',
  )
  const b = boundaryLines.find((e) => e.type === 'compact_boundary')!
  assert(
    typeof b.summary === 'string' && b.summary.includes('Boundary test'),
    'boundary summary text',
  )
  assert(boundaryLines[0]?.type === 'meta', 'jsonl still starts with meta')
  assert(
    boundaryLines.some((e) => e.type === 'message'),
    'jsonl still has message entries after compact',
  )

  // ── 6) full compact 不碰 systemPromptSections 稳定前缀 ──
  const sessSys = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: false,
    provider: textOnlyProvider(),
    compactSummarizer: async ({ compactPrompt }) => {
      if (compactPrompt.includes('memory daily log')) return { text: '' }
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   Keep system.\n</summary>`,
      }
    },
  })
  sessSys.systemPromptSections = [
    '# Stable prefix\nDO NOT TOUCH',
    '# Project rules\nvolatile ok',
  ]
  const sysSnap = [...sessSys.systemPromptSections]
  sessSys.messages.push({ role: 'user', content: 'work' })
  sessSys.messages.push({ role: 'assistant', content: 'done' })
  const rSys = await compactSession(sessSys, 'manual')
  assert(rSys.ok === true, 'system prefix compact ok')
  assert(
    sessSys.systemPromptSections.length === sysSnap.length &&
      sessSys.systemPromptSections.every((s, i) => s === sysSnap[i]),
    'systemPromptSections unchanged after compact',
  )
  assert(
    sessSys.messages[0]?.content === 'Conversation compacted',
    'boundary is conversation message, not system section',
  )

  // ── 7) auto 失败不拖垮 prepare / turn ──
  let failCalls = 0
  const prepFail = createAutoCompactPrepare({
    enabled: true,
    contextWindowTokens: 8_000,
    runAutoCompact: async () => {
      failCalls += 1
      throw new Error('summarizer boom')
    },
  })
  const fatFail: ChatMessage[] = [
    {
      role: 'user',
      content: 'z'.repeat((getAutoCompactThreshold(8_000) + 50) * 4),
    },
  ]
  const rf = await prepFail({
    messages: fatFail,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(rf.didCompact !== true, 'failure → no didCompact')
  assert(rf.messages === fatFail || rf.messages[0]?.content === fatFail[0]?.content, 'messages preserved on fail')
  assert(failCalls === 1, 'one fail attempt')
  // 连续失败熔断：再两次后停止调用
  await prepFail({
    messages: fatFail,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  await prepFail({
    messages: fatFail,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  const beforeBreaker = failCalls
  await prepFail({
    messages: fatFail,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(failCalls === beforeBreaker, 'circuit breaker stops after 3 failures')

  // ── 8) 默认 auto 开 + 环境熔断 + /autocompact 运行时开关 ──
  const {
    shouldAutoCompact,
    isAutoCompactEnvDisabled,
  } = await import('../packages/compact/src/index.ts')
  const {
    setSessionAutoCompact,
    dispatchSlashCommand,
  } = await import('../packages/core/src/index.ts')

  assert(
    isAutoCompactEnvDisabled({ BOLO_DISABLE_AUTO_COMPACT: '1' }) === true,
    'env disable auto',
  )
  assert(
    isAutoCompactEnvDisabled({ BOLO_DISABLE_COMPACT: 'yes' }) === true,
    'env disable all compact auto path',
  )
  assert(isAutoCompactEnvDisabled({}) === false, 'empty env ok')

  assert(
    shouldAutoCompact({
      tokenCount: getAutoCompactThreshold(8_000) + 10,
      contextWindowTokens: 8_000,
      enabled: true,
      consecutiveFailures: 0,
      env: { BOLO_DISABLE_AUTO_COMPACT: '1' },
    }) === false,
    'shouldAutoCompact respects env',
  )

  let defSum = 0
  const sessDefault = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    // 不传 autoCompactEnabled → 默认 true
    contextWindowTokens: 8_000,
    provider: textOnlyProvider(),
    compactSummarizer: async ({ compactPrompt }) => {
      if (compactPrompt.includes('memory daily log')) {
        return { text: '' } // MEM-1 flush 分支不计入 compact 调用计数
      }
      defSum += 1
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   Default path.\n</summary>`,
      }
    },
  })
  assert(sessDefault.autoCompactEnabled === true, 'default autoCompact on')

  // 超阈值应挂 auto prepare（compactSession 读 session.messages）
  sessDefault.messages = [
    {
      role: 'user',
      content: 'd'.repeat((getAutoCompactThreshold(8_000) + 80) * 4),
    },
  ]
  const rDef = await sessDefault.deps.prepareMessages({
    messages: sessDefault.messages,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(rDef.didCompact === true, 'default-on auto fires prepare')
  assert(defSum === 1, 'default-on summarizer called')

  // 运行时 off 后不再 auto
  setSessionAutoCompact(sessDefault, false)
  assert(sessDefault.autoCompactEnabled === false, 'runtime off')
  sessDefault.messages = [
    {
      role: 'user',
      content: 'd'.repeat((getAutoCompactThreshold(8_000) + 80) * 4),
    },
  ]
  const rOff = await sessDefault.deps.prepareMessages({
    messages: sessDefault.messages,
    querySource: 'repl_main_thread',
    tokenCount: 0,
  })
  assert(rOff.didCompact !== true, 'runtime off no auto')

  // slash 开关
  const ac = await dispatchSlashCommand(sessDefault, 'autocompact', '')
  assert(ac.ok, 'autocompact status ok')
  assert(ac.message.includes('autoCompact:'), 'autocompact shows status')
  const acOn = await dispatchSlashCommand(sessDefault, 'autocompact', 'on')
  assert(acOn.ok && acOn.message.includes('on'), 'autocompact on')
  assert(sessDefault.autoCompactEnabled === true, 'slash on session')
  const acBad = await dispatchSlashCommand(sessDefault, 'autocompact', 'maybe')
  assert(acBad.ok === false, 'autocompact bad arg')

  await fs.rm(tmpRoot, { recursive: true, force: true })

  console.log('AUTO COMPACT TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})