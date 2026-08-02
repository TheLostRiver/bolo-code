/**
 * ROB-1: 工具调用重复检测 — shared 纯契约 + queryLoop 提醒/中止接线。
 */
import { strict as assert } from 'node:assert'
import {
  TOOL_REPETITION_ABORT_THRESHOLD,
  TOOL_REPETITION_WARN_THRESHOLD,
  advanceToolRepetition,
  createToolRepetitionState,
  fingerprintToolCall,
  formatToolRepetitionReminder,
  toolRepetitionStage,
  type ChatMessage,
  type ToolCallFingerprint,
} from '../packages/shared/src/index.ts'
import {
  queryLoop,
  type CallModelFn,
  type QueryDeps,
} from '../packages/core/src/index.ts'
import type { BoloTool } from '../packages/tools/src/index.ts'

function sameArgsFingerprint(
  a: ToolCallFingerprint,
  b: ToolCallFingerprint,
): boolean {
  return a.name === b.name && a.argsHash === b.argsHash
}

function makeReadTool(): BoloTool {
  return {
    name: 'Read',
    description: 'mock read',
    inputJSONSchema: { type: 'object', properties: { path: { type: 'string' } } },
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isEnabled: () => true,
    interruptBehavior: () => 'block',
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    call: async (input) => ({
      ok: true,
      output: `content of ${String(input.path)}`,
      isError: false,
    }),
  }
}

function baseDeps(callModel: CallModelFn): QueryDeps {
  return {
    callModel,
    prepareMessages: async ({ messages }) => ({ messages }),
    uuid: () => 'id_repetition',
  }
}

async function runLoop(
  callModel: CallModelFn,
  options: {
    maxTurns: number
    onEvent?: (event: { type: string; message?: string }) => void
  },
): Promise<{ terminal: { reason: string; detail?: string }; messages: ChatMessage[] }> {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]
  const terminal = await queryLoop({
    sessionId: 'rep-session',
    cwd: process.cwd(),
    hooks: {},
    messages,
    deps: baseDeps(callModel),
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    maxTurns: options.maxTurns,
    maxPtlRetries: 0,
    tools: [makeReadTool()],
    onEvent: options.onEvent as never,
  })
  return { terminal, messages }
}

async function main(): Promise<void> {
  // ---- shared fingerprint contract ----
  const a = fingerprintToolCall('Read', '{"path":"/a","offset":10}')
  const b = fingerprintToolCall('Read', '{"offset":10,"path":"/a"}')
  assert(
    sameArgsFingerprint(a, b),
    'argument key order does not change the fingerprint',
  )
  assert(
    !sameArgsFingerprint(
      fingerprintToolCall('Read', '{"path":"/a"}'),
      fingerprintToolCall('Read', '{"path":"/b"}'),
    ),
    'different arguments produce different fingerprints',
  )
  assert(
    !sameArgsFingerprint(
      fingerprintToolCall('Read', '{"path":"/a"}'),
      fingerprintToolCall('Grep', '{"path":"/a"}'),
    ),
    'different tools produce different fingerprints',
  )
  assert(
    sameArgsFingerprint(
      fingerprintToolCall('Bash', 'not-json'),
      fingerprintToolCall('Bash', 'not-json'),
    ),
    'unparsable arguments fall back to the raw string',
  )

  // ---- shared state machine ----
  const state0 = createToolRepetitionState()
  const calls = (path: string) => [
    { name: 'Read', argumentsJson: JSON.stringify({ path }) },
  ]
  let state = advanceToolRepetition(state0, calls('/a'))
  assert.equal(state.count, 1, 'first round starts at one')
  state = advanceToolRepetition(state, calls('/a'))
  assert.equal(state.count, 2, 'identical sequence increments')
  state = advanceToolRepetition(state, calls('/b'))
  assert.equal(state.count, 1, 'argument change resets the count')
  state = advanceToolRepetition(state, [])
  assert.equal(state.count, 0, 'rounds without tools reset the count')
  assert.equal(toolRepetitionStage(0), 'none')
  assert.equal(toolRepetitionStage(TOOL_REPETITION_WARN_THRESHOLD - 1), 'none')
  assert.equal(toolRepetitionStage(TOOL_REPETITION_WARN_THRESHOLD), 'warn')
  assert.equal(toolRepetitionStage(TOOL_REPETITION_ABORT_THRESHOLD - 1), 'warn')
  assert.equal(toolRepetitionStage(TOOL_REPETITION_ABORT_THRESHOLD), 'abort')
  const reminder = formatToolRepetitionReminder(8, a)
  assert(
    reminder.includes('[Tool repetition reminder]') &&
      reminder.includes('8 times') &&
      reminder.includes('change strategy'),
    'reminder text names the count and the required behavior',
  )

  // ---- queryLoop: repeated identical calls warn then abort ----
  {
    let round = 0
    const warnings: string[] = []
    const callModel: CallModelFn = async function* () {
      round += 1
      yield {
        type: 'tool_call',
        id: `c${round}`,
        name: 'Read',
        arguments: JSON.stringify({ path: '/same' }),
      }
      yield { type: 'done' }
    }
    const { terminal, messages } = await runLoop(callModel, {
      maxTurns: 25,
      onEvent: (event) => {
        if (event.type === 'warning') warnings.push(event.message ?? '')
      },
    })
    assert.equal(
      terminal.reason,
      'tool_repetition',
      `identical calls must abort the turn (got ${terminal.reason})`,
    )
    assert(
      messages.some(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('[Tool repetition reminder]'),
      ),
      'a reminder is injected into the model messages before abort',
    )
    assert(
      warnings.some((w) => w.includes('[Tool repetition reminder]')),
      'the CLI receives the reminder as a warning event',
    )
  }

  // ---- queryLoop: argument change resets the sequence ----
  {
    let round = 0
    let warned = false
    const callModel: CallModelFn = async function* () {
      round += 1
      if (round === 5) {
        yield { type: 'text_delta', text: 'switching strategy' }
        yield { type: 'done' }
        return
      }
      if (round > 5) {
        yield {
          type: 'tool_call',
          id: `c${round}`,
          name: 'Read',
          arguments: JSON.stringify({ path: '/other' }),
        }
        yield { type: 'done' }
        return
      }
      yield {
        type: 'tool_call',
        id: `c${round}`,
        name: 'Read',
        arguments: JSON.stringify({ path: '/same' }),
      }
      yield { type: 'done' }
    }
    const { terminal, messages } = await runLoop(callModel, {
      maxTurns: 25,
      onEvent: (event) => {
        if (event.type === 'warning' && event.message?.includes('reminder')) {
          warned = true
        }
      },
    })
    assert.equal(
      terminal.reason,
      'completed',
      `strategy change must not abort (got ${terminal.reason})`,
    )
    assert(
      !warned &&
        !messages.some(
          (m) =>
            m.role === 'user' &&
            typeof m.content === 'string' &&
            m.content.includes('[Tool repetition reminder]'),
        ),
      'argument changes reset the repetition count',
    )
  }

  // ---- queryLoop: empty tool rounds reset the count ----
  {
    let round = 0
    const callModel: CallModelFn = async function* () {
      round += 1
      if (round % 3 === 0) {
        yield { type: 'text_delta', text: `answer ${round}` }
        yield { type: 'done' }
        return
      }
      yield {
        type: 'tool_call',
        id: `c${round}`,
        name: 'Read',
        arguments: JSON.stringify({ path: '/same' }),
      }
      yield { type: 'done' }
    }
    const { terminal } = await runLoop(callModel, { maxTurns: 30 })
    assert.equal(
      terminal.reason,
      'completed',
      'rounds without tool calls must reset repetition (got completed expected)',
    )
  }

  console.log('PASS: ROB-1 tool call repetition guard')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
