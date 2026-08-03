/**
 * /context · /compact 输出加深（本地 token 启发式 + 压力）
 * 运行：npx tsx scripts/test-context-slash.ts
 */
import {
  estimateTokens,
  getAutoCompactThreshold,
} from '../packages/compact/src/index.ts'
import {
  createSession,
  dispatchSlashCommand,
} from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function textOnlyProvider(): LlmProvider {
  return {
    id: 'mock-text',
    async *completeStream() {
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'unused'
    },
  }
}

async function main() {
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    autoCompactEnabled: true,
    contextWindowTokens: 128_000,
    provider: textOnlyProvider(),
    compactSummarizer: async ({ compactPrompt }) => {
      if (compactPrompt.includes('memory daily log')) return { text: '' }
      return {
        text: `<summary>\n1. Primary Request and Intent:\n   Slash compact test.\n8. Current Work:\n   verifying compact slash.\n</summary>`,
      }
    },
  })
  session.systemPromptSections = ['# Stable\nkeep me']
  session.messages.push({ role: 'user', content: 'hello context' })
  session.messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 't1',
        name: 'Read',
        arguments: JSON.stringify({ path: 'a.ts' }),
      },
    ],
  })
  session.messages.push({
    role: 'tool',
    tool_call_id: 't1',
    content: '{"ok":true,"data":' + '"x"'.repeat(20) + '}',
  })

  const ctx = await dispatchSlashCommand(session, 'context', '')
  assert(ctx.ok, 'context ok')
  assert(ctx.contextView, 'default context exposes a structured view model')
  assert(
    ctx.contextView?.usage.source === 'estimated',
    'no provider usage is labeled estimated',
  )
  assert(
    ctx.contextView?.categories.map((category) => category.id).join(',') ===
      'messages,system,free',
    'context view exposes the primary breakdown',
  )
  assert(ctx.message.includes('Context usage:'), 'plain context has a summary')
  assert(
    ctx.message.includes('/context details'),
    'plain context points to diagnostics',
  )
  assert(
    !ctx.message.includes('prepare order:'),
    'default plain context keeps diagnostics collapsed',
  )

  const ctxDetails = await dispatchSlashCommand(session, 'context', 'details')
  assert(ctxDetails.ok, 'context details ok')
  assert(!ctxDetails.contextView, 'details bypasses the TTY dashboard')
  assert(ctxDetails.message.includes('pressure:'), 'details shows pressure')
  assert(
    ctxDetails.message.includes('auto threshold'),
    'details shows threshold',
  )
  assert(
    ctxDetails.message.includes('messages ~'),
    'details splits messages/system',
  )
  assert(
    ctxDetails.message.includes('heuristic:'),
    'details explains heuristic',
  )
  assert(
    ctxDetails.message.includes('prepare order:'),
    'details shows prepare order',
  )
  assert(
    ctxDetails.message.includes('autoCompact:     on'),
    'details reflects auto compact',
  )
  assert(
    ctxDetails.message.includes('pressure source:'),
    'details shows pressure source',
  )
  assert(ctxDetails.message.includes('keep policy:'), 'details shows keep policy')
  assert(ctxDetails.message.includes('~'), 'details has token estimates')
  assert(
    ctxDetails.message.includes('/autocompact'),
    'details points to toggle',
  )
  assert(
    ctxDetails.message.includes('skill catalog:     (no skills loaded)'),
    'details has an empty skill catalog line',
  )

  session.skills = [
    {
      meta: {
        id: 'ctx-skill',
        name: 'ctx',
        description: 'for context line',
        path: '/tmp/ctx-skill/SKILL.md',
      },
      source: 'user',
      body: 'body',
      frontmatter: {},
    },
  ]
  const ctxSkills = await dispatchSlashCommand(session, 'context', '')
  assert(ctxSkills.ok, 'context with skills ok')
  assert(
    ctxSkills.contextView?.skills.totalSkills === 1 &&
      ctxSkills.contextView.skills.listed === 1,
    'context view carries skill catalog stats',
  )
  const ctxSkillDetails = await dispatchSlashCommand(
    session,
    'context',
    '--details',
  )
  assert(
    ctxSkillDetails.message.includes('skill catalog:') &&
      ctxSkillDetails.message.includes('listed') &&
      ctxSkillDetails.message.includes('chars'),
    'context details keeps skill catalog diagnostics',
  )

  // 多轮：大前缀 + 小尾部 keep，确保 compact 后 messages token 下降
  const thr = getAutoCompactThreshold(8_000)
  const pad = 'p'.repeat((thr + 200) * 4)
  session.messages.push({ role: 'user', content: pad })
  session.messages.push({ role: 'assistant', content: 'ack pad' })
  session.messages.push({ role: 'user', content: 'continue after pad' })
  assert(estimateTokens(session.messages) >= thr, 'over threshold for compact demo')

  const beforeTok = estimateTokens(session.messages)
  const comp = await dispatchSlashCommand(session, 'compact', 'note-me')
  assert(comp.ok, `compact ok: ${comp.message}`)
  assert(comp.message.includes('saved ~'), 'compact reports saved tokens')
  assert(comp.message.includes('messages tokens:'), 'compact before/after')
  assert(comp.message.includes('system tokens:'), 'compact system unchanged line')
  assert(comp.message.includes('note-me') || comp.message.includes('note='), 'note echoed')
  const afterTok = estimateTokens(session.messages)
  assert(
    afterTok < beforeTok,
    `messages tokens decreased ${beforeTok}→${afterTok}`,
  )
  assert(
    session.systemPromptSections[0]?.includes('keep me'),
    'system section still present',
  )
  assert(
    Boolean((session as { lastCompact?: unknown }).lastCompact),
    'lastCompact set after manual compact',
  )

  const ctxAfter = await dispatchSlashCommand(session, 'context', '')
  assert(ctxAfter.contextView?.lastCompact, 'context view carries last compact')
  const ctxAfterDetails = await dispatchSlashCommand(
    session,
    'context',
    'details',
  )
  assert(
    ctxAfterDetails.message.includes('last compact:'),
    'context details keeps last compact line',
  )

  // ── AR2A0a：/context hybrid 来源显示 ──
  const { fingerprintMessagePrefix } = await import(
    '../packages/compact/src/index.ts'
  )
  session.usage = {
    inputTokens: 4_000,
    outputTokens: 100,
    totalTokens: 4_100,
    calls: 1,
    lastCall: {
      inputTokens: 4_000,
      outputTokens: 100,
      totalTokens: 4_100,
      at: new Date().toISOString(),
      messageCountAtCall: session.messages.length,
      messagePrefixFingerprint: fingerprintMessagePrefix(
        session.messages,
        session.messages.length,
      ),
    },
  }
  const ctxActual = await dispatchSlashCommand(session, 'context', '')
  assert(
    ctxActual.contextView?.usage.source === 'actual',
    'provider input usage is labeled actual before a local tail is added',
  )
  // 锚 == 全长 → usage；追加一条尾部消息 → hybrid
  session.messages.push({ role: 'user', content: 'tail after usage anchor' })
  const ctxHybrid = await dispatchSlashCommand(session, 'context', '')
  assert(
    ctxHybrid.contextView?.usage.source === 'hybrid',
    'context shows hybrid source with anchored tail',
  )
  const ctxHybridDetails = await dispatchSlashCommand(
    session,
    'context',
    'details',
  )
  assert(
    ctxHybridDetails.message.includes('anchor input ~4000'),
    'context shows anchor input tokens',
  )
  // 头部形状被改写（模拟 snip/compact 重排）→ 锚失效 → 不再显示 hybrid
  const savedFirst = session.messages[0]!
  session.messages[0] = {
    role: 'assistant',
    content: 'head rewritten',
    tool_calls: [{ id: 'zz', name: 'Bash', arguments: '{}' }],
  }
  const ctxStale = await dispatchSlashCommand(session, 'context', '')
  assert(
    ctxStale.contextView?.usage.source !== 'hybrid',
    'stale anchor no longer reports hybrid',
  )
  session.messages[0] = savedFirst

  // /autocompact 可见性
  const ac = await dispatchSlashCommand(session, 'autocompact', 'off')
  assert(ac.ok, 'autocompact off ok')
  assert(session.autoCompactEnabled === false, 'session auto off')
  const ctx2 = await dispatchSlashCommand(session, 'context', '')
  assert(
    ctx2.contextView?.autoCompact.enabled === false,
    'context view reflects auto compact off',
  )

  console.log('CONTEXT SLASH TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
