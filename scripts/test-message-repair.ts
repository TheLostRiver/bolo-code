/**
 * ROB-2: 工具消息配对修复 — shared 纯契约 + loadSessionPair 恢复接线。
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  repairToolMessagePairs,
  type ChatMessage,
} from '../packages/shared/src/index.ts'
import { loadSessionPair } from '../packages/core/src/index.ts'

function assistantWithCalls(
  content: string,
  calls: Array<{ id: string; name?: string }>,
): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: calls.map((call) => ({
      id: call.id,
      name: call.name ?? 'Read',
      arguments: JSON.stringify({ path: '/a' }),
    })),
  }
}

function toolResult(id: string, content = `result of ${id}`): ChatMessage {
  return { role: 'tool', content, tool_call_id: id, name: 'Read' }
}

async function main(): Promise<void> {
  // ---- shared repair contract ----
  const user = { role: 'user' as const, content: 'question' }
  const textAnswer = { role: 'assistant' as const, content: 'answer' }

  // 1) dangling declaration without result is dropped; empty message removed
  const dangling = repairToolMessagePairs([
    user,
    assistantWithCalls('', [{ id: 'c1' }]),
    textAnswer,
  ])
  assert.deepEqual(
    dangling.map((m) => m.role),
    ['user', 'assistant'],
    'a call-only assistant message with a dangling call is removed entirely',
  )

  // 2) assistant with text + dangling call degrades to plain text
  const degraded = repairToolMessagePairs([
    assistantWithCalls('thinking out loud', [{ id: 'c1' }]),
  ])
  assert.equal(degraded.length, 1)
  assert.equal(degraded[0]!.role, 'assistant')
  assert.equal(degraded[0]!.content, 'thinking out loud')
  assert.equal(
    (degraded[0] as { tool_calls?: unknown }).tool_calls,
    undefined,
    'dangling call is stripped, text survives',
  )

  // 3) partial dangling: only the call without a result is removed
  const partial = repairToolMessagePairs([
    assistantWithCalls('', [
      { id: 'c1', name: 'Read' },
      { id: 'c2', name: 'Grep' },
    ]),
    toolResult('c1'),
  ])
  assert.equal(partial.length, 2)
  const kept = partial[0] as { tool_calls?: Array<{ id: string }> }
  assert.deepEqual(
    kept.tool_calls?.map((c) => c.id),
    ['c1'],
    'only the call with a matching result survives',
  )
  assert.equal(partial[1]!.tool_call_id, 'c1')

  // 4) orphan result without any declaration is dropped
  const orphan = repairToolMessagePairs([
    user,
    toolResult('ghost'),
    textAnswer,
  ])
  assert.deepEqual(
    orphan.map((m) => m.role),
    ['user', 'assistant'],
    'results without a declaration never enter the model view',
  )

  // 5) duplicate results keep the first
  const duplicated = repairToolMessagePairs([
    assistantWithCalls('', [{ id: 'c1' }]),
    toolResult('c1', 'first'),
    toolResult('c1', 'second'),
  ])
  assert.equal(duplicated.length, 2)
  assert.equal(duplicated[1]!.content, 'first')

  // 6) duplicate declarations keep the first
  const dupDecl = repairToolMessagePairs([
    assistantWithCalls('', [{ id: 'c1' }]),
    assistantWithCalls('', [{ id: 'c1' }]),
    toolResult('c1', 'first'),
  ])
  assert.equal(dupDecl.length, 2)
  const firstDecl = dupDecl[0] as { tool_calls?: Array<{ id: string }> }
  assert.deepEqual(
    firstDecl.tool_calls?.map((c) => c.id),
    ['c1'],
    'the first declaration keeps the call',
  )
  assert.equal(
    (dupDecl[1] as { tool_calls?: unknown }).tool_calls,
    undefined,
    'the second declaration is stripped',
  )

  // 7) a healthy pair is untouched
  const healthy = repairToolMessagePairs([
    user,
    assistantWithCalls('', [{ id: 'c1' }, { id: 'c2' }]),
    toolResult('c1'),
    toolResult('c2'),
    textAnswer,
  ])
  assert.equal(healthy.length, 5)
  assert.deepEqual(
    (healthy[1] as { tool_calls?: Array<{ id: string }> }).tool_calls?.map(
      (c) => c.id,
    ),
    ['c1', 'c2'],
  )

  // 8) idempotent
  const messy = [
    user,
    assistantWithCalls('', [{ id: 'c1' }, { id: 'c2' }]),
    toolResult('c1'),
    toolResult('c1'),
    toolResult('ghost'),
    textAnswer,
  ]
  const once = repairToolMessagePairs(messy)
  assert.deepEqual(
    repairToolMessagePairs(once),
    once,
    'repairing an already repaired table is a no-op',
  )

  // ---- loadSessionPair integration ----
  const root = path.resolve('.bolo-tmp', 'test-message-repair')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })

  const jsonPath = path.join(root, 'repair-session.json')
  await fs.writeFile(
    jsonPath,
    JSON.stringify({
      id: 'repair-session',
      version: 1,
      model: 'mock-model',
      cwd: process.cwd(),
      permissionMode: 'acceptEdits',
      messages: [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'dangling-1', name: 'Read', arguments: '{}' },
            { id: 'paired-1', name: 'Read', arguments: '{}' },
          ],
        },
        { role: 'tool', content: 'paired result', tool_call_id: 'paired-1' },
        { role: 'tool', content: 'duplicate result', tool_call_id: 'paired-1' },
        { role: 'tool', content: 'orphan result', tool_call_id: 'ghost-1' },
        { role: 'assistant', content: 'answer' },
      ],
    }),
    'utf8',
  )

  const loaded = await loadSessionPair(jsonPath)
  assert.equal(loaded.fromTranscript, false, 'loads the JSON snapshot')
  const repaired = loaded.snapshot.messages
  assert.deepEqual(
    repaired.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
    `recovery drops dangling/orphan/duplicate entries (got ${repaired.length})`,
  )
  assert.equal(
    repaired[1]!.tool_calls?.length,
    1,
    'the dangling call is removed from the assistant message',
  )
  assert.equal(repaired[2]!.content, 'paired result', 'first result wins')
  assert.equal(
    repaired[3]!.content,
    'answer',
    'the final assistant answer survives',
  )

  await fs.rm(root, { recursive: true, force: true })
  console.log('PASS: ROB-2 tool message pair repair')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
