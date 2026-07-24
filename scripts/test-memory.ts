/**
 * Memory：路径、截断、topic 扫描、相关挑选、user+project 分层
 * 运行：node --import tsx/esm scripts/test-memory.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getMemoryDir,
  getProjectMemoryDir,
  getMemoryEntrypoint,
  ensureMemoryDir,
  ensureProjectMemoryDir,
  loadMemoryEntrypoint,
  loadProjectMemoryEntrypoint,
  truncateMemoryEntrypoint,
  buildMemorySystemSection,
  buildMemoryGuidelines,
  formatMemoryStatus,
  isMemoryDisabled,
  scanMemoryTopics,
  selectRelevantMemoryTopics,
  tokenizeMemoryQuery,
  MEMORY_ENTRYPOINT_NAME,
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

// --- MEM-6 topics ---
await fs.writeFile(
  path.join(dir, 'user_preferences.md'),
  '---\ndescription: prefers bun over npm\ntitle: Prefs\n---\n\nAlways use bun.\n',
  'utf8',
)
await fs.writeFile(
  path.join(dir, 'unrelated_notes.md'),
  '# Cooking\n\npasta recipes only\n',
  'utf8',
)
const topics = await scanMemoryTopics(dir, { scope: 'user' })
assert(topics.length >= 2, 'scan topics')
assert(
  topics.some((t) => t.filename === 'user_preferences.md' && t.description?.includes('bun')),
  'frontmatter description',
)
assert(tokenizeMemoryQuery('use bun please').includes('bun'), 'tokenize')
const rel = selectRelevantMemoryTopics('please use bun not npm', topics)
assert(rel.some((r) => r.filename.includes('user_preferences')), 'relevant picks prefs')
assert(!rel.some((r) => r.filename.includes('unrelated')), 'skips cooking')

const sectionRel = await buildMemorySystemSection({
  userBoloDir: tmpHome,
  ensureDir: false,
  relevanceQuery: 'bun package manager preference',
  includeRelevantTopics: true,
})
assert(sectionRel?.includes('Related memory topics'), 'related section')
assert(sectionRel?.includes('Always use bun') || sectionRel?.includes('bun'), 'related body')

// --- MEM-7 project ---
const projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mem-proj-'))
const pdir = getProjectMemoryDir({ cwd: projRoot })
await ensureProjectMemoryDir({ cwd: projRoot })
await fs.writeFile(
  path.join(pdir, MEMORY_ENTRYPOINT_NAME),
  '- [Deadline](deadline.md) — ship April\n',
  'utf8',
)
await fs.writeFile(
  path.join(pdir, 'deadline.md'),
  '---\ndescription: release deadline April\n---\n\nFreeze March 30.\n',
  'utf8',
)
const pl = await loadProjectMemoryEntrypoint({ cwd: projRoot })
assert(pl.exists && pl.content.includes('Deadline'), 'project entry')
const both = await buildMemorySystemSection({
  userBoloDir: tmpHome,
  cwd: projRoot,
  ensureDir: false,
})
assert(both?.includes('Current user'), 'user heading')
assert(both?.includes('Current project'), 'project heading')
assert(both?.includes('Deadline') || both?.includes('ship April'), 'project index in section')

// status format
const status = formatMemoryStatus(loaded, {
  project: pl,
  topics: await scanMemoryTopics(dir, { scope: 'user' }),
})
assert(status.includes('enabled'), 'status enabled')
assert(status.includes('topics:'), 'status topics')

// slash
const provider: LlmProvider = {
  id: 'mock',
  async *completeStream() {
    yield { type: 'text_delta', text: 'ok' }
    yield { type: 'done' }
  },
}
const session = await createSession({
  cwd: projRoot,
  provider,
  systemPrompt: false,
})
const prevMem = process.env.BOLO_MEMORY_DIR
const prevDisable = process.env.BOLO_DISABLE_MEMORY
process.env.BOLO_MEMORY_DIR = dir
delete process.env.BOLO_DISABLE_MEMORY
const memSlash = await dispatchSlashCommand(session, 'memory', '')
assert(memSlash.ok && memSlash.message.includes('MEMORY.md'), 'slash memory')
const pathSlash = await dispatchSlashCommand(session, 'memory', 'path')
assert(pathSlash.ok && pathSlash.message.includes(dir), 'slash path')
assert(pathSlash.message.includes('project'), 'slash path project')
const topicsSlash = await dispatchSlashCommand(session, 'memory', 'topics')
assert(topicsSlash.ok && topicsSlash.message.includes('user_preferences'), 'slash topics')
if (prevMem === undefined) delete process.env.BOLO_MEMORY_DIR
else process.env.BOLO_MEMORY_DIR = prevMem
if (prevDisable === undefined) delete process.env.BOLO_DISABLE_MEMORY
else process.env.BOLO_DISABLE_MEMORY = prevDisable

console.log('MEMORY TESTS PASS')