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
  session.permissionRules = {
    alwaysAllowToolNames: ['Bash', 'Read'],
    alwaysAllowPrefixes: ['mcp__'],
  }
  session.effortLevel = 'high'
  session.usage = {
    inputTokens: 120,
    outputTokens: 40,
    totalTokens: 160,
    calls: 2,
    estimated: true,
  }

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
  assert(
    deepEqual(snap1b.permissionRules, {
      alwaysAllowToolNames: ['Bash', 'Read'],
      alwaysAllowPrefixes: ['mcp__'],
    }),
    'permissionRules roundtrip',
  )
  assert(snap1b.effortLevel === 'high', 'effortLevel roundtrip')
  assert(
    deepEqual(snap1b.usage, {
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      calls: 2,
      estimated: true,
    }),
    'usage roundtrip',
  )

  // ── 2) save / load（T3：默认只写 jsonl）──
  const { path: savedPath, snapshot: saved, transcriptPath } = await saveSession(
    session,
    { sessionsDir },
  )
  assert(transcriptPath?.endsWith('.jsonl'), 'T3 writes jsonl')
  assert(
    savedPath === transcriptPath,
    `T3 return path is jsonl: ${savedPath}`,
  )
  assert((await fs.stat(savedPath)).isFile(), 'jsonl file exists')
  const pairedJson = resolveSessionFilePath(session.id, { sessionsDir })
  try {
    await fs.stat(pairedJson)
    assert(false, 'T3 should not write JSON by default')
  } catch (err) {
    assert(
      (err as NodeJS.ErrnoException).code === 'ENOENT',
      'JSON missing expected',
    )
  }

  const { snapshot: loaded } = await loadSession(session.id, { sessionsDir })
  assert(loaded.id === saved.id, 'load id')
  assert(deepEqual(loaded.messages, messages), 'load messages')
  assert(loaded.permissionMode === 'acceptEdits', 'load mode')
  assert(loaded.createdAt === saved.createdAt, 'createdAt stable on first save')
  assert(
    deepEqual(loaded.permissionRules, session.permissionRules),
    'load permissionRules',
  )
  assert(loaded.effortLevel === 'high', 'load effortLevel')
  assert(deepEqual(loaded.usage, session.usage), 'load usage')
  assert(
    deepEqual(loaded.systemPromptSections, ['section-a', 'section-b']),
    'load system from meta',
  )

  // 再 save：createdAt 保留，updatedAt 变
  await new Promise((r) => setTimeout(r, 5))
  const { snapshot: saved2 } = await saveSession(session, { sessionsDir })
  assert(saved2.createdAt === saved.createdAt, 'createdAt preserved')
  assert(saved2.updatedAt >= saved.updatedAt, 'updatedAt moves')
  assert(
    deepEqual(saved2.permissionRules, session.permissionRules),
    'save2 permissionRules',
  )
  assert(deepEqual(saved2.usage, session.usage), 'save2 usage')

  // 可选双写：writeJsonSnapshot 仍可用
  const { path: dualJson } = await saveSession(session, {
    sessionsDir,
    writeJsonSnapshot: true,
  })
  assert(dualJson.endsWith('.json'), 'opt-in JSON path')
  assert((await fs.stat(dualJson)).isFile(), 'opt-in JSON exists')

  // ── 3) resume by id（双文件时 path 为 JSON；messages 仍优先 jsonl）──
  const { session: resumed, path: resumePath } = await resumeSession({
    idOrPath: session.id,
    sessionsDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(resumePath === dualJson, 'resume path prefers json when both exist')
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
  assert(
    deepEqual(resumed.permissionRules, {
      alwaysAllowToolNames: ['Bash', 'Read'],
      alwaysAllowPrefixes: ['mcp__'],
    }),
    'resume permissionRules',
  )
  assert(resumed.effortLevel === 'high', 'resume effortLevel')
  assert(
    deepEqual(resumed.usage, {
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      calls: 2,
      estimated: true,
    }),
    'resume usage',
  )

  // ── 4) resume by absolute path ──
  const { session: r2 } = await resumeSession({
    idOrPath: dualJson,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(deepEqual(r2.messages, messages), 'resume by path')
  assert(r2.effortLevel === 'high', 'resume by path effort')
  assert(deepEqual(r2.usage, session.usage), 'resume by path usage')

  // 仅 jsonl resume path
  await fs.unlink(dualJson)
  const { path: resumeJsonlOnly } = await resumeSession({
    idOrPath: session.id,
    sessionsDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(resumeJsonlOnly === savedPath, 'resume path is jsonl when only jsonl')

  // ── 5) autoSave 接线 + resume 保留 always-allow / usage（T3 jsonl）──
  const autoDir = path.join(tmpRoot, 'auto')
  await fs.mkdir(autoDir, { recursive: true })
  const sAuto = await createSession({
    cwd,
    sessionId: 'sess_auto_save_01',
    systemPrompt: false,
    autoSave: { sessionsDir: autoDir },
  })
  sAuto.messages.push({ role: 'user', content: 'auto' })
  sAuto.permissionRules = {
    alwaysAllowToolNames: ['Write'],
  }
  sAuto.effortLevel = 'low'
  sAuto.usage = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    calls: 1,
  }
  // 直接调 maybe 路径：submitPrompt 内部会调；这里用 save 验证 meta 后手动
  const { maybeAutoSaveSession, getSessionPersistMeta, migrateSessionToJsonl } =
    await import('../packages/core/src/sessionPersist.ts')
  const meta = getSessionPersistMeta(sAuto)
  assert(meta?.autoSave === true, 'autoSave meta')
  await maybeAutoSaveSession(sAuto)
  const autoJsonl = path.join(autoDir, 'sess_auto_save_01.jsonl')
  assert((await fs.stat(autoJsonl)).isFile(), 'autoSave wrote jsonl')
  const autoLoaded = await loadSession('sess_auto_save_01', {
    sessionsDir: autoDir,
  })
  assert(autoLoaded.snapshot.messages[0]?.content === 'auto', 'auto content')
  assert(
    deepEqual(autoLoaded.snapshot.permissionRules, {
      alwaysAllowToolNames: ['Write'],
    }),
    'autoSave permissionRules',
  )
  assert(autoLoaded.snapshot.effortLevel === 'low', 'autoSave effort')
  assert(
    deepEqual(autoLoaded.snapshot.usage, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      calls: 1,
    }),
    'autoSave usage',
  )

  const { session: autoResumed } = await resumeSession({
    idOrPath: 'sess_auto_save_01',
    sessionsDir: autoDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(
    deepEqual(autoResumed.permissionRules?.alwaysAllowToolNames, ['Write']),
    'autoSave resume always-allow',
  )
  assert(autoResumed.effortLevel === 'low', 'autoSave resume effort')
  assert(autoResumed.usage?.calls === 1, 'autoSave resume usage calls')
  assert(autoResumed.usage?.totalTokens === 15, 'autoSave resume usage total')

  // ── 6) migrateSessionToJsonl（D2）：旧 JSON → 旁路 jsonl ──
  const migDir = path.join(tmpRoot, 'mig')
  await fs.mkdir(migDir, { recursive: true })
  const migId = 'sess_migrate_01'
  const migJson = path.join(migDir, `${migId}.json`)
  await fs.writeFile(
    migJson,
    JSON.stringify(
      {
        version: 1,
        id: migId,
        cwd,
        permissionMode: 'default',
        messages: [
          { role: 'user', content: 'migrate-me' },
          { role: 'assistant', content: 'ok' },
        ],
        systemPromptSections: ['sec'],
        autoCompactEnabled: false,
        contextWindowTokens: 64000,
        maxPtlRetries: 1,
        createdAt: '2021-01-01T00:00:00.000Z',
        updatedAt: '2021-01-02T00:00:00.000Z',
        model: 'mig-model',
        effortLevel: 'medium',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  const mig1 = await migrateSessionToJsonl(migId, { sessionsDir: migDir })
  assert(mig1.wrote === true, 'migrate wrote')
  assert(mig1.messageCount === 2, 'migrate count')
  assert((await fs.stat(mig1.transcriptPath)).isFile(), 'migrate jsonl exists')
  assert((await fs.stat(migJson)).isFile(), 'migrate keeps json by default')
  const migSkip = await migrateSessionToJsonl(migId, { sessionsDir: migDir })
  assert(migSkip.wrote === false, 'migrate skip when jsonl has messages')
  const { session: migResumed } = await resumeSession({
    idOrPath: migId,
    sessionsDir: migDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(migResumed.messages[0]?.content === 'migrate-me', 'migrate resume msg')
  assert(migResumed.model === 'mig-model', 'migrate model')
  assert(migResumed.effortLevel === 'medium', 'migrate effort')

  // 清理
  await fs.rm(tmpRoot, { recursive: true, force: true })

  console.log('PASS: test-session-persist')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})