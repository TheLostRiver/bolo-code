/**
 * Desktop IPC 契约冒烟（不启动 Electron GUI）
 * 运行：node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
 */
import {
  createSession,
  submitUserInput,
  closeSessionMcp,
  productionDeps,
} from '../../../packages/core/src/index.ts'
import { createMockProvider } from '../../../packages/providers/src/index.ts'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function assert(c, m) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-desk-'))
const provider = createMockProvider()
const session = await createSession({
  cwd: tmp,
  provider,
  deps: productionDeps(provider),
  systemPrompt: false,
  permissionMode: 'bypassPermissions',
})

assert(session?.id, 'session id')
assert(Array.isArray(session.messages), 'messages array')

const slash = await submitUserInput(session, '/help')
assert(slash.type === 'slash', `slash type got ${slash.type}`)
assert(slash.message, 'help msg')

const turn = await submitUserInput(session, 'hello desktop')
assert(turn.type === 'prompt' || turn.type === 'turn', `turn type got ${turn.type}`)
assert(session.messages.length >= 2, 'messages grew')

await closeSessionMcp(session)
console.log('DESKTOP IPC SMOKE PASS')