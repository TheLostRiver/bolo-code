/**
 * CMP-1: 压缩专用模型与墙钟预算 — runFullCompact 超时回退、
 * summarizer 模型覆盖、config → session 装配。
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  runFullCompact,
  type FullCompactInput,
} from '../packages/compact/src/index.ts'
import { createCompactSummarizerFromProvider } from '../packages/providers/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function baseInput(overrides: Partial<FullCompactInput> = {}): FullCompactInput {
  return {
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ],
    trigger: 'auto',
    summarize: async () => ({ text: 'summary' }),
    ...overrides,
  }
}

function mockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'mock',
    completeStream: async function* () {
      yield { type: 'text_delta', text: 'streamed summary' }
    },
    ...overrides,
  }
}

async function main(): Promise<void> {
  // ---- wall-clock budget: hanging summarizer fails closed ----
  {
    let resolves: ((value: { text: string }) => void) | undefined
    const outcome = await runFullCompact(
      baseInput({
        summarize: () =>
          new Promise<{ text: string }>((resolve) => {
            resolves = resolve
          }),
        summarizeTimeoutMs: 50,
      }),
    )
    assert.equal(outcome.ok, false)
    if (!outcome.ok) {
      assert.equal(outcome.messagesUnchanged, true)
      assert(
        /timed out after 50ms/u.test(outcome.reason),
        `timeout reason is explicit (got ${outcome.reason})`,
      )
    }
    // 底层调用仍在挂起：settle 掉，避免悬挂 promise 影响进程退出
    resolves?.({ text: 'late result' })
  }

  // ---- wall-clock budget: fast summarizer succeeds ----
  {
    const outcome = await runFullCompact(
      baseInput({
        summarize: async () => ({ text: 'fast summary' }),
        summarizeTimeoutMs: 500,
      }),
    )
    assert.equal(outcome.ok, true)
    if (outcome.ok) {
      assert(
        outcome.apiMessages.some((m) =>
          typeof m.content === 'string'
            ? m.content.includes('fast summary')
            : false,
        ),
        'successful summary replaces history',
      )
    }
  }

  // ---- no budget: behavior unchanged ----
  {
    const outcome = await runFullCompact(baseInput())
    assert.equal(outcome.ok, true, 'no timeout keeps the previous behavior')
  }

  // ---- summarizer model override ----
  {
    let streamOptions: Record<string, unknown> | undefined
    let completeTextCalls = 0
    const provider = mockProvider({
      completeText: async () => {
        completeTextCalls += 1
        return 'text summary'
      },
      completeStream: async function* (
        _messages: ChatMessage[],
        options?: { model?: string; disableTools?: boolean },
      ) {
        streamOptions = options
        yield { type: 'text_delta', text: 'stream summary' }
      },
    })
    const withModel = createCompactSummarizerFromProvider(provider, {
      model: 'compact-lite',
    })
    const text = await withModel({
      messages: [{ role: 'user', content: 'x' }],
      compactPrompt: 'summarize',
    })
    assert.equal(text.text, 'stream summary')
    assert.equal(completeTextCalls, 0, 'model override bypasses completeText')
    assert.equal(
      (streamOptions as { model?: string } | undefined)?.model,
      'compact-lite',
      'completeStream receives the compact model override',
    )
    assert.equal(
      (streamOptions as { disableTools?: boolean } | undefined)
        ?.disableTools,
      true,
    )
  }

  {
    // no override + completeText available → completeText path
    let streamCalls = 0
    const provider = mockProvider({
      completeText: async () => 'text summary',
      completeStream: async function* () {
        streamCalls += 1
        yield { type: 'text_delta', text: 'stream' }
      },
    })
    const plain = createCompactSummarizerFromProvider(provider)
    const text = await plain({
      messages: [{ role: 'user', content: 'x' }],
      compactPrompt: 'summarize',
    })
    assert.equal(text.text, 'text summary')
    assert.equal(streamCalls, 0, 'no override keeps the completeText path')
  }

  {
    // no override + no completeText → stream path without model
    let seenModel: string | undefined = 'sentinel'
    const provider = mockProvider({
      completeStream: async function* (
        _messages: ChatMessage[],
        options?: { model?: string },
      ) {
        seenModel = options?.model
        yield { type: 'text_delta', text: 'stream' }
      },
    })
    const plain = createCompactSummarizerFromProvider(provider)
    await plain({
      messages: [{ role: 'user', content: 'x' }],
      compactPrompt: 'summarize',
    })
    assert.equal(seenModel, undefined, 'no model key is sent without override')
  }

  // ---- config → session assembly ----
  const root = path.resolve('.bolo-tmp', 'test-compact-model-budget')
  await fs.rm(root, { recursive: true, force: true })
  const cwd = path.join(root, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const userDir = path.join(root, 'user')
  await fs.mkdir(userDir, { recursive: true })
  await fs.writeFile(
    path.join(userDir, 'config.json'),
    JSON.stringify({
      version: 1,
      provider: { kind: 'mock', model: 'mock-model' },
      compactModel: 'compact-lite',
      compactTimeoutMs: 750,
    }),
    'utf8',
  )
  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = userDir
  try {
    const { createSessionFromWorkspace } = await import(
      '../packages/core/src/index.ts'
    )
    const created = await createSessionFromWorkspace({
      cwd,
      materializeUserState: true,
      systemPrompt: false,
    })
    const session = created.session
    assert.equal(session.compactModel, 'compact-lite')
    assert.equal(session.compactTimeoutMs, 750)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.BOLO_CONFIG_DIR
    } else {
      process.env.BOLO_CONFIG_DIR = previousConfigDir
    }
    await fs.rm(root, { recursive: true, force: true })
  }

  console.log('PASS: CMP-1 compact model and wall-clock budget')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
