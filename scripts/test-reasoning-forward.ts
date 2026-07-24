/**
 * 思考链：provider 事件 → queryLoop 转发为 SessionEvent（mock，不联网）
 * 运行：npx tsx scripts/test-reasoning-forward.ts
 */
import { queryLoop } from '../packages/core/src/queryLoop.ts'
import type { QueryDeps } from '../packages/core/src/deps.ts'
import type { ProviderStreamEvent } from '../packages/providers/src/types.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import { createMockProvider } from '../packages/providers/src/mock.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function collectFromProvider(
  events: ProviderStreamEvent[],
): Promise<{ type: string; text?: string }[]> {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  const seen: { type: string; text?: string }[] = []
  const base = createMockProvider()
  const deps: QueryDeps = {
    callModel: async function* () {
      for (const ev of events) yield ev
    },
    prepareMessages: async ({ messages: m }) => ({ messages: m }),
    uuid: () => 'id-1',
  }
  await queryLoop({
    sessionId: 's1',
    cwd: process.cwd(),
    hooks: {},
    messages,
    deps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    maxTurns: 1,
    onEvent: (e) => {
      if (e.type === 'text' || e.type === 'reasoning') {
        seen.push({ type: e.type, text: e.text })
      }
    },
  })
  void base
  return seen
}

async function main() {
  const withReason = await collectFromProvider([
    { type: 'reasoning_delta', text: 'think1' },
    { type: 'reasoning_delta', text: 'think2' },
    { type: 'reasoning_end' },
    { type: 'text_delta', text: 'hello' },
    { type: 'done' },
  ])
  assert(
    withReason.some((e) => e.type === 'reasoning' && e.text === 'think1'),
    'forward reasoning_delta',
  )
  assert(
    withReason.some((e) => e.type === 'reasoning' && e.text === 'think2'),
    'forward second reasoning',
  )
  assert(
    withReason.some((e) => e.type === 'text' && e.text === 'hello'),
    'forward text after reasoning',
  )
  // reasoning_end 不产生会话噪声事件
  assert(
    !withReason.some((e) => e.type === 'reasoning' && !e.text),
    'no empty reasoning from reasoning_end',
  )

  const noReason = await collectFromProvider([
    { type: 'text_delta', text: 'plain' },
    { type: 'done' },
  ])
  assert(
    noReason.every((e) => e.type !== 'reasoning'),
    'no reasoning when provider silent',
  )
  assert(
    noReason.some((e) => e.type === 'text' && e.text === 'plain'),
    'text still works',
  )

  // assistant 消息内容不含思考链（仅 text 累计）
  const messages: ChatMessage[] = [{ role: 'user', content: 'q' }]
  const deps: QueryDeps = {
    callModel: async function* () {
      yield { type: 'reasoning_delta', text: 'secret-think' }
      yield { type: 'text_delta', text: 'visible' }
      yield { type: 'done' }
    },
    prepareMessages: async ({ messages: m }) => ({ messages: m }),
    uuid: () => 'id-2',
  }
  await queryLoop({
    sessionId: 's2',
    cwd: process.cwd(),
    hooks: {},
    messages,
    deps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    maxTurns: 1,
  })
  const asst = messages.find((m) => m.role === 'assistant')
  assert(asst?.content === 'visible', 'ChatMessage content is text only')
  assert(
    !String(asst?.content ?? '').includes('secret-think'),
    'thinking not persisted in ChatMessage',
  )

  console.log('ok: test-reasoning-forward')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})