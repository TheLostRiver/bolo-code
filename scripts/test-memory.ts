/**
 * Memory 最小：路径、截断、system 段、禁用开关
 * 运行：node --import tsx/esm scripts/test-memory.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getMemoryDir,
  getMemoryEntrypoint,
  ensureMemoryDir,
  loadMemoryEntrypoint,
  truncateMemoryEntrypoint,
  buildMemorySystemSection,
  buildMemoryGuidelines,
  formatMemoryStatus,
  isMemoryDisabled,
  MEMORY_ENTRYPOINT_NAME,
  MAX_MEMORY_ENTRYPOINT_LINES,
} from '../packages/core/src/memory.ts'
import { getVolatileSections } from '../packages/core/src/systemPrompt.ts'
import { dispatchSlashCommand } from '../packages/core/src/slash.ts'
import { createSession } from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// paths
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mem-'))
const dir = getMemoryDir({ userBoloDir: tmpHome })
assert(dir.endsWith(path.join('memory')) || dir.includes('memory'), 'dir under home')
assert(
  getMemoryEntrypoint({ userBoloDir: tmpHome }).endsWith(MEMORY_ENTRYPOINT_NAME),
  'entrypoint name',
)
const ensured = await ensureMemoryDir({ userBoloDir: tmpHome })
assert(ensured === dir, 'ensure returns dir')
const st = await fs.stat(dir)
assert(st.isDirectory(), 'dir exists')

// empty load
const empty = await loadMemoryEntrypoint({ userBoloDir: tmpHome })
assert(!empty.exists, 'no file yet')
assert(empty.content === '', 'empty content')

// write + load
const entry = getMemoryEntrypoint({ userBoloDir: tmpHome })
await fs.writeFile(
  entry,
  '- [Prefs](user_preferences.md) — uses bun\n- [Release](project_release.md) — freeze March\n',
  'utf8',
)
const loaded = await loadMemoryEntrypoint({ userBoloDir: tmpHome })
assert(loaded.exists, 'exists')
assert(loaded.content.includes('Prefs'), 'content')
assert(!loaded.wasLineTruncated, 'not truncated')

// truncate lines
const manyLines = Array.from({ length: 250 }, (_, i) => `- line ${i}`).join('\n')
const trunc = truncateMemoryEntrypoint(manyLines, { maxLines: 10, maxBytes: 100_000 })
assert(trunc.wasLineTruncated, 'line trunc')
assert(trunc.content.includes('truncated'), 'warn footer')
assert(trunc.content.split('\n').length < 20, 'few lines after trunc')

// truncate bytes
const long = 'x'.repeat(30_000)
const truncB = truncateMemoryEntrypoint(long, { maxLines: 500, maxBytes: 1000 })
assert(truncB.wasByteTruncated, 'byte trunc')

// guidelines + section
const guide = buildMemoryGuidelines(dir)
assert(guide.includes('auto memory'), 'title')
assert(guide.includes(MEMORY_ENTRYPOINT_NAME), 'mentions entry')

const section = await buildMemorySystemSection({
  userBoloDir: tmpHome,
  ensureDir: false,
})
assert(section?.includes('auto memory'), 'section title')
assert(section?.includes('Prefs'), 'section has index')

// disable
assert(
  (await buildMemorySystemSection({
    userBoloDir: tmpHome,
    env: { BOLO_DISABLE_MEMORY: '1' } as NodeJS.ProcessEnv,
  })) === undefined,
  'disabled skips',
)
assert(isMemoryDisabled({ BOLO_DISABLE_MEMORY: 'true' } as NodeJS.ProcessEnv), 'disabled flag')

// volatile sections include memory
const vols = await getVolatileSections({
  cwd: tmpHome,
  userConfigDir: tmpHome,
  loadInstructions: false,
  loadRules: false,
  skills: [],
})
assert(
  vols.some((s) => s.includes('auto memory') && s.includes('Prefs')),
  'volatile has memory',
)

// status format
const status = formatMemoryStatus(loaded)
assert(status.includes('enabled'), 'status enabled')
assert(status.includes('preview'), 'status preview')

// slash
const provider: LlmProvider = {
  id: 'mock',
  async *completeStream() {
    yield { type: 'text_delta', text: 'ok' }
    yield { type: 'done' }
  },
}
const session = await createSession({
  cwd: tmpHome,
  provider,
  systemPrompt: false,
})
// point memory at tmp via env for slash (uses process env home override)
const prevMem = process.env.BOLO_MEMORY_DIR
const prevDisable = process.env.BOLO_DISABLE_MEMORY
process.env.BOLO_MEMORY_DIR = dir
delete process.env.BOLO_DISABLE_MEMORY
const memSlash = await dispatchSlashCommand(session, 'memory', '')
assert(memSlash.ok && memSlash.message.includes('MEMORY.md'), 'slash memory')
const pathSlash = await dispatchSlashCommand(session, 'memory', 'path')
assert(pathSlash.ok && pathSlash.message.includes(dir), 'slash path')
if (prevMem === undefined) delete process.env.BOLO_MEMORY_DIR
else process.env.BOLO_MEMORY_DIR = prevMem
if (prevDisable === undefined) delete process.env.BOLO_DISABLE_MEMORY
else process.env.BOLO_DISABLE_MEMORY = prevDisable

console.log('MEMORY TESTS PASS')