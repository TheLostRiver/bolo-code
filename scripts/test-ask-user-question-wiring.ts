/**
 * AR-T3+ · AskUserQuestion 端到端接线
 *
 * 句柄要从 `session.askUserQuestion` 一路穿到工具的 `ctx.extras`，
 * 中间经过 queryLoop params 与 toolExecution ctx —— **六处**。
 * 任何一处漏了，工具都会以为「没人可问」，然后返回 unavailable。
 *
 * 而这个失败是**看起来正常的**：模型收到 unavailable、按提示带着假设继续，
 * 用户只会觉得「它怎么从来不问我」，不会有任何报错。
 * 上面那些单元测试全绿也照样漏——它们绕开了真实链路，直接构造 ctx。
 * 所以必须有一条真跑一轮的测试。
 *
 * 运行：npx tsx scripts/test-ask-user-question-wiring.ts
 */
import { createSession, submitPrompt } from '../packages/core/src/index.ts'
import { ASK_USER_QUESTION_TOOL_NAME } from '../packages/tools/src/index.ts'
import type {
  AskUserQuestionAskerRef,
  AskUserQuestionOutcome,
} from '../packages/tools/src/index.ts'
import type {
  LlmProvider,
  ProviderStreamEvent,
} from '../packages/providers/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const QUESTION_ARGS = JSON.stringify({
  questions: [
    {
      question: 'Which database should we use?',
      header: 'Database',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    },
  ],
})

/** 第一轮发 AskUserQuestion，拿到结果后收尾 */
function askingProvider(): LlmProvider {
  return {
    id: 'mock-ask',
    async *completeStream(
      messages: ChatMessage[],
    ): AsyncIterable<ProviderStreamEvent> {
      const done = messages.some((m) => m.role === 'tool')
      if (!done) {
        yield {
          type: 'tool_call',
          id: 'call_ask_1',
          name: ASK_USER_QUESTION_TOOL_NAME,
          arguments: QUESTION_ARGS,
        }
        yield { type: 'done' }
        return
      }
      const last = [...messages].reverse().find((m) => m.role === 'tool')
      yield { type: 'text_delta', text: `RESULT>>${last?.content ?? ''}<<` }
      yield { type: 'done' }
    },
    async completeText() {
      return 'summary'
    },
  }
}

async function runWith(
  asker: AskUserQuestionAskerRef | undefined,
): Promise<{ text: string; toolOutput: string }> {
  const log: string[] = []
  let toolOutput = ''
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    permissionMode: 'default',
    provider: askingProvider(),
    askPermission: async () => 'allow',
    onEvent: (e) => {
      if (e.type === 'text') log.push(e.text)
      if (e.type === 'tool_end' && e.name === ASK_USER_QUESTION_TOOL_NAME) {
        toolOutput = e.output
      }
    },
  })
  if (asker) session.askUserQuestion = asker
  await submitPrompt(session, 'pick a database')
  return { text: log.join(''), toolOutput }
}

async function main() {
  // ── 1) 注入了句柄 → 答案真的回到模型手里 ──
  {
    let sawQuestions = 0
    const asker: AskUserQuestionAskerRef = {
      ask: async (questions): Promise<AskUserQuestionOutcome> => {
        sawQuestions = questions.length
        assert(
          questions[0]?.question.includes('database'),
          `the asker receives the real question: ${JSON.stringify(questions[0])}`,
        )
        return { kind: 'answered', selections: [{ selected: ['SQLite'] }] }
      },
    }
    const { text, toolOutput } = await runWith(asker)
    assert(
      sawQuestions === 1,
      'the handle threaded from session → queryLoop → toolExecution → ctx.extras',
    )
    assert(
      toolOutput.includes('SQLite'),
      `the tool result carries the answer: ${toolOutput}`,
    )
    assert(
      !/unavailable/i.test(toolOutput),
      `must not report unavailable when a handle is bound: ${toolOutput}`,
    )
    assert(
      text.includes('SQLite'),
      `the model actually sees the answer in the next turn: ${text}`,
    )
  }

  // ── 2) 没注入句柄 → unavailable，且模型能继续跑（不挂死）──
  {
    const { toolOutput } = await runWith(undefined)
    assert(
      /unavailable|no user/i.test(toolOutput),
      `unbound handle reports unavailable: ${toolOutput}`,
    )
    assert(
      !/Postgres|SQLite/.test(toolOutput),
      `must not name an option — that reads as a real answer: ${toolOutput}`,
    )
  }

  // ── 3) 用户取消 → 明确的「没答」，不是编一个 ──
  {
    const asker: AskUserQuestionAskerRef = {
      ask: async () => ({ kind: 'cancelled' }),
    }
    const { toolOutput } = await runWith(asker)
    assert(
      /declin|cancel/i.test(toolOutput),
      `cancel surfaces as declined: ${toolOutput}`,
    )
    assert(
      !/Postgres|SQLite/.test(toolOutput),
      `cancel must not name an option: ${toolOutput}`,
    )
  }

  // ── 4) UI 交回对不上号的答案 → 整条拒绝，不进上下文 ──
  {
    const asker: AskUserQuestionAskerRef = {
      ask: async () => ({
        kind: 'answered',
        selections: [{ selected: ['MongoDB'] }],
      }),
    }
    const { toolOutput } = await runWith(asker)
    assert(
      !/MongoDB/.test(toolOutput) || /does not match/i.test(toolOutput),
      `an answer that was never offered must not become a fact: ${toolOutput}`,
    )
  }

  console.log('PASS: ask user question wiring')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
