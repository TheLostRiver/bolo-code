/**
 * OI-06A: Desktop 需要一个真正由 core session 驱动的 RuntimeTransport。
 *
 * runtimeClient 的 mock 已经证明消费侧协议成立，但生产代码没有 adapter；
 * 这意味着版本协商、snapshot 解析和 command 安全边界从未在 Desktop 路径跑过。
 *
 * 本测试只测 packages 契约，不 import Electron：
 * - hello/query 能让现有 RuntimeClient 进入 ready
 * - command 真正走 executeRuntimeCommand
 * - IPC 边界的 unknown 命令先解析，畸形输入不得进入 executor
 * - session resolver 失败必须成为明确 error，不能伪装成空会话
 */
import assert from 'node:assert/strict'

import {
  RUNTIME_PROTOCOL_VERSION,
  createRuntimeClient,
} from '../packages/shared/src/index.ts'
import {
  SessionCoordinator,
  createSession,
  createSessionRuntimeTransport,
} from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

const provider: LlmProvider = {
  id: 'runtime-core-transport-test',
  async *completeStream() {
    yield { type: 'done' }
  },
}

const session = await createSession({
  cwd: process.cwd(),
  sessionId: 'runtime_core_transport_session',
  coordinator: new SessionCoordinator(),
  provider,
  systemPrompt: false,
})

let resolveCount = 0
const transport = createSessionRuntimeTransport(async () => {
  resolveCount++
  return session
})
const client = createRuntimeClient({ transport, timeoutMs: 1_000 })

await client.connect()
assert.equal(client.getState().status, 'ready')
assert.equal(client.getSnapshot()?.session.sessionId, session.id)

const inspected = await client.send({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'runtime.command',
  requestId: 'desktop_inspect_1',
  action: 'runtime.inspect',
  target: { sessionId: session.id },
})
assert.equal(inspected.ok, true)
if (inspected.ok) {
  assert.equal(inspected.snapshot?.session.sessionId, session.id)
}
assert.ok(resolveCount >= 2, 'query and command resolve the current production session')

await assert.rejects(
  () =>
    transport.command({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command',
      requestId: 'malformed_desktop_command',
      action: 'turn.interrupt',
      target: { sessionId: session.id },
    }),
  /runtime command|turnId|expectedState/i,
  'unknown IPC payloads are parsed before reaching executeRuntimeCommand',
)

const unavailableClient = createRuntimeClient({
  transport: createSessionRuntimeTransport(async () => {
    throw new Error('desktop session unavailable')
  }),
  timeoutMs: 1_000,
})
await unavailableClient.connect()
const unavailable = unavailableClient.getState()
assert.equal(unavailable.status, 'error')
assert.match(
  unavailable.status === 'error' ? unavailable.detail : '',
  /desktop session unavailable/i,
)
assert.equal(
  unavailableClient.getSnapshot(),
  undefined,
  'resolver failure is not presented as an empty session',
)

console.log('PASS: runtime core transport')
