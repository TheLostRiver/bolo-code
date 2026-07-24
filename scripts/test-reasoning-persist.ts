/**
 * persistReasoning + openai-compatible reasoning_content refeed
 * 运行：node --import tsx/esm scripts/test-reasoning-persist.ts
 */
import { toOpenAIMessages } from '../packages/providers/src/openaiCompatible.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const msgs: ChatMessage[] = [
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: 'answer',
    reasoning_content: 'chain-of-thought here',
  },
]

const oai = toOpenAIMessages(msgs)
const asst = oai.find((m) => m.role === 'assistant') as {
  role: string
  content: string | null
  reasoning_content?: string
}
assert(asst?.content === 'answer', 'content')
assert(
  asst?.reasoning_content === 'chain-of-thought here',
  'reasoning_content refeed',
)

const bare = toOpenAIMessages([
  { role: 'assistant', content: 'only' },
])
const b = bare[0] as { reasoning_content?: string }
assert(b.reasoning_content === undefined, 'no field when absent')

console.log('ok: test-reasoning-persist')