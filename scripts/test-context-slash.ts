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
    contextWindowTokens: 8_000,
    provider: textOnlyProvider(),
    compactSummarizer: async () => ({
      text: `<summary>\n1. Primary Request and Intent:\n   Slash compact test.\n</summary>`,
    }),
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
  assert(ctx.message.includes('pressure:'), 'context shows pressure')
  assert(ctx.message.includes('auto threshold'), 'context shows threshold')
  assert(ctx.message.includes('messages ~'), 'context splits messages/system')
  assert(ctx.message.includes('heuristic:'), 'context explains heuristic')
  assert(ctx.message.includes('prepare order:'), 'context shows prepare order')
  assert(ctx.message.includes('autoCompact:     on'), 'context auto on')
  assert(ctx.message.includes('~'), 'token estimates present')

  const thr = getAutoCompactThreshold(8_000)
  const pad = 'p'.repeat((thr + 200) * 4)
  session.messages.push({ role: 'user', content: pad })
  assert(estimateTokens(session.messages) >= thr, 'over threshold for compact demo')

  const beforeTok = estimateTokens(session.messages)
  const comp = await dispatchSlashCommand(session, 'compact', 'note-me')
  assert(comp.ok, `compact ok: ${comp.message}`)
  assert(comp.message.includes('saved ~'), 'compact reports saved tokens')
  assert(comp.message.includes('messages tokens:'), 'compact before/after')
  assert(comp.message.includes('system tokens:'), 'compact system unchanged line')
  assert(comp.message.includes('note-me') || comp.message.includes('note='), 'note echoed')
  const afterTok = estimateTokens(session.messages)
  assert(afterTok < beforeTok, 'messages tokens decreased')
  assert(
    session.systemPromptSections[0]?.includes('keep me'),
    'system section still present',
  )

  console.log('CONTEXT SLASH TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})