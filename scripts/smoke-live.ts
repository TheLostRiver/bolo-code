/**
 * 真实 Provider 冒烟（需 API Key）
 *
 * OpenAI:
 *   BOLO_PROVIDER=openai-compatible
 *   OPENAI_API_KEY / BOLO_API_KEY
 *
 * Anthropic:
 *   BOLO_PROVIDER=anthropic
 *   ANTHROPIC_API_KEY
 *
 * 无 key 时 exit 0 跳过。运行：npx tsx scripts/smoke-live.ts
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSession,
  submitPrompt,
  compactSession,
} from '../packages/core/src/index.ts'
import {
  createProviderFromEnv,
  createCompactSummarizerFromProvider,
} from '../packages/providers/src/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cwd = path.resolve(__dirname, '..')

async function main() {
  const { provider, kind, model, baseUrl } = createProviderFromEnv()
  if (kind === 'mock') {
    console.log(
      'SKIP smoke-live: set OPENAI_API_KEY or ANTHROPIC_API_KEY (and BOLO_PROVIDER if needed)',
    )
    process.exit(0)
  }

  console.log(`live provider: ${kind} model=${model} base=${baseUrl}`)

  const log: string[] = []
  const session = await createSession({
    cwd,
    provider,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    compactSummarizer: createCompactSummarizerFromProvider(provider),
    onEvent: (e) => {
      if (e.type === 'text') process.stdout.write(e.text)
      if (e.type === 'tool_start') log.push(`tool:${e.name}`)
      if (e.type === 'tool_end') log.push(`tool_end:${e.name}:${e.ok}`)
      if (e.type === 'error') log.push(`error:${e.message}`)
      if (e.type === 'done') log.push(`done:${e.terminal?.reason}`)
    },
  })

  console.log('\n--- turn ---')
  const terminal = await submitPrompt(
    session,
    'Reply with exactly the word PONG and nothing else. Do not call tools.',
    { maxTurns: 2 },
  )
  console.log('\n--- terminal ---', terminal)

  if (terminal.reason === 'error') {
    console.error('LIVE FAIL', terminal.detail)
    process.exit(1)
  }

  const lastAssistant = [...session.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && !m.tool_calls)
  console.log('assistant:', lastAssistant?.content?.slice(0, 200))

  if (session.messages.length >= 2 && session.compactSummarizer) {
    const c = await compactSession(session, { trigger: 'manual' })
    console.log('compact:', c)
  }

  console.log('event log:', log.join(' | '))
  console.log('LIVE SMOKE PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})