/**
 * 会话落盘 / 恢复：create → 加消息 → save → load → resume
 * 运行：npx tsx scripts/test-session-persist.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSession,
  saveSession,
  loadSession,
  resumeSession,
  toSnapshot,
  parseSessionSnapshot,
  resolveSessionFilePath,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-sess-'))
  const cwd = path.join(tmpRoot, 'proj')
  const sessionsDir = path.join(tmpRoot, 'sessions')
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  const session = await createSession({
    cwd,
    sessionId: 'sess_test_persist_01',
    systemPrompt: false,
    permissionMode: 'acceptEdits',
    autoCompactEnabled: true,
    contextWindowTokens: 64_000,
    maxPtlRetries: 2,
    model: 'mock-model',
  })

  const messages: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [
        {
          id: 'call_1',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'echo hi' }),
        },
      ],
    },
    {
      role: 'tool',
      content: 'hi\n',
      tool_call_id: 'call_1',
      name: 'Bash',
    },
    { role: 'assistant', content: 'done' },
  ]
  session.messages.push(...messages)
  session.systemPromptSections = ['section-a', 'section-b']

  // ── 1) toSnapshot / parse ──
  const snap1 = toSnapshot(session)
  const snap1b = parseSessionSnapshot(JSON.parse(JSON.stringify(snap1)))
  assert(snap1b.id === session.id, 'id')
  assert(snap1b.permissionMode === 'acceptEdits', 'permissionMode')
  assert(deepEqual(snap1b.messages, messages), 'messages roundtrip')
  assert(
    deepEqual(snap1b.systemPromptSections, ['section-a', 'section-b']),
    'system sections',
  )
  assert(snap1b.autoCompactEnabled === true, 'autoCompact')
  assert(snap1b.contextWindowTokens === 64_000, 'ctx tokens')
  assert(snap1b.maxPtlRetries === 2, 'ptl')
  assert(snap1b.model === 'mock-model', 'model')

  // ── 2) save / load ──
  const { path: savedPath, snapshot: saved } = await saveSession(session, {
    sessionsDir,
  })
  assert(
    savedPath === resolveSessionFilePath(session.id, { sessionsDir }),
    `path=${savedPath}`,
  )
  assert((await fs.stat(savedPath)).isFile(), 'file exists')

  const { snapshot: loaded } = await loadSession(session.id, { sessionsDir })
  assert(loaded.id === saved.id, 'load id')
  assert(deepEqual(loaded.messages, messages), 'load messages')
  assert(loaded.permissionMode === 'acceptEdits', 'load mode')
  assert(loaded.createdAt === saved.createdAt, 'createdAt stable on first save')

  // 再 save：createdAt 保留，updatedAt 变
  await new Promise((r) => setTimeout(r, 5))
  const { snapshot: saved2 } = await saveSession(session, { sessionsDir })
  assert(saved2.createdAt === saved.createdAt, 'createdAt preserved')
  assert(saved2.updatedAt >= saved.updatedAt, 'updatedAt moves')

  // ── 3) resume by id ──
  const { session: resumed, path: resumePath } = await resumeSession({
    idOrPath: session.id,
    sessionsDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(resumePath === savedPath, 'resume path')
  assert(resumed.id === session.id, 'resume id')
  assert(deepEqual(resumed.messages, messages), 'resume messages')
  assert(resumed.permissionMode === 'acceptEdits', 'resume mode')
  assert(resumed.cwd === cwd, 'resume cwd')
  assert(
    deepEqual(resumed.systemPromptSections, ['section-a', 'section-b']),
    'resume system snapshot',
  )
  assert(resumed.autoCompactEnabled === true, 'resume autoCompact')
  assert(resumed.maxPtlRetries === 2, 'resume ptl')

  // ── 4) resume by absolute path ──
  const { session: r2 } = await resumeSession({
    idOrPath: savedPath,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(deepEqual(r2.messages, messages), 'resume by path')

  // ── 5) autoSave 接线 ──
  const autoDir = path.join(tmpRoot, 'auto')
  await fs.mkdir(autoDir, { recursive: true })
  const sAuto = await createSession({
    cwd,
    sessionId: 'sess_auto_save_01',
    systemPrompt: false,
    autoSave: { sessionsDir: autoDir },
  })
  sAuto.messages.push({ role: 'user', content: 'auto' })
  // 直接调 maybe 路径：submitPrompt 内部会调；这里用 save 验证 meta 后手动
  const { maybeAutoSaveSession, getSessionPersistMeta } = await import(
    '../packages/core/src/sessionPersist.ts'
  )
  const meta = getSessionPersistMeta(sAuto)
  assert(meta?.autoSave === true, 'autoSave meta')
  await maybeAutoSaveSession(sAuto)
  const autoFile = resolveSessionFilePath('sess_auto_save_01', {
    sessionsDir: autoDir,
  })
  assert((await fs.stat(autoFile)).isFile(), 'autoSave wrote file')
  const autoLoaded = await loadSession('sess_auto_save_01', {
    sessionsDir: autoDir,
  })
  assert(autoLoaded.snapshot.messages[0]?.content === 'auto', 'auto content')

  // 清理
  await fs.rm(tmpRoot, { recursive: true, force: true })

  console.log('PASS: test-session-persist')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})