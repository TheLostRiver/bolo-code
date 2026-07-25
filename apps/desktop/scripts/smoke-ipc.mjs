/**
 * Desktop IPC 契约冒烟（不启动 Electron GUI）
 * 覆盖：会话 · slash · CX7 listProviders / use / add 纯函数路径
 * 运行：node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
 */
import {
  createSession,
  createSessionFromWorkspace,
  submitUserInput,
  closeSessionMcp,
  productionDeps,
  switchSessionProvider,
  listSessionProviders,
  attachProviderRegistry,
} from '../../../packages/core/src/index.ts'
import { createMockProvider } from '../../../packages/providers/src/index.ts'
import {
  listProviderPresets,
  addProviderProfileToConfigFile,
  normalizeProviderRegistry,
  loadConfigJson,
  layoutPaths,
} from '../../../packages/config/src/index.ts'
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

// CX7：presets 可列
const presets = listProviderPresets()
assert(presets.length >= 5, 'presets >= 5')
assert(presets.some((p) => p.id === 'deepseek'), 'has deepseek preset')

// CX7：registry + list/switch（mock profiles，无真 key）
const multi = {
  defaultProvider: 'work',
  providers: {
    work: { kind: 'mock', model: 'm-work', label: 'Work' },
    other: { kind: 'mock', model: 'm-other' },
  },
}
const reg = normalizeProviderRegistry(multi)
attachProviderRegistry(session, reg, 'work')
const listed = listSessionProviders(session)
assert(listed.length === 2, 'list 2 providers')
assert(listed.some((p) => p.id === 'work' && p.isActive), 'work active')

const sw = switchSessionProvider(session, 'other')
assert(sw.ok, `switch other: ${sw.ok ? '' : sw.reason}`)
assert(session.providerId === 'other', 'switched id')
assert(/dialect=|choosable/i.test(sw.message), 'CX4 tip in switch message')

// CX7：add preset 写临时 BOLO_CONFIG_DIR
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-desk-home-'))
const prevHome = process.env.BOLO_CONFIG_DIR
process.env.BOLO_CONFIG_DIR = home
try {
  const layout = layoutPaths(home)
  await fs.mkdir(layout.root, { recursive: true })
  await fs.writeFile(layout.configJson, JSON.stringify({ version: 1 }, null, 2))
  const added = await addProviderProfileToConfigFile({
    presetId: 'anthropic',
    scope: 'user',
  })
  assert(added.ok, `add anthropic: ${added.ok ? '' : added.reason}`)
  const disk = await loadConfigJson(layout)
  assert(disk.providers?.anthropic?.apiKeyEnv === 'ANTHROPIC_API_KEY', 'env only')
  assert(!disk.providers?.anthropic?.apiKey, 'no plaintext key')
} finally {
  if (prevHome === undefined) delete process.env.BOLO_CONFIG_DIR
  else process.env.BOLO_CONFIG_DIR = prevHome
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
}

await closeSessionMcp(session)
console.log('DESKTOP IPC SMOKE PASS (incl. CX7 providers)')