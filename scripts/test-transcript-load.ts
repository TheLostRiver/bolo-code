/**
 * JSONL loadTranscriptMessages（J-C 起步）
 * 运行：npx tsx scripts/test-transcript-load.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSession,
  saveSession,
  loadTranscriptMessages,
  loadTranscriptFile,
  resumeSession,
  resolveTranscriptPathFromJson,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import { createMockProvider } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function sameMessages(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.role !== y.role || x.content !== y.content) return false
    if ((x.tool_call_id ?? '') !== (y.tool_call_id ?? '')) return false
  }
  return true
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-tload-'))
  const cwd = path.join(tmpRoot, 'proj')
  const sessionsDir = path.join(tmpRoot, 'sessions')
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  const session = await createSession({
    cwd,
    sessionId: 'sess_load_01',
    systemPrompt: false,
    provider: createMockProvider(),
  })
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
    { role: 'user', content: 'again' },
  ]
  session.messages.push(...msgs)
  session.model = 'mock-model'
  session.permissionMode = 'default'

  const { path: savedPath, transcriptPath } = await saveSession(session, {
    sessionsDir,
  })
  assert(transcriptPath, 'has transcriptPath')
  const jsonl = transcriptPath!
  // 配对 JSON 路径（T3 默认不写；下面删测用 opt-in 再造）
  const jsonPath = resolveTranscriptPathFromJson(jsonl).endsWith('.jsonl')
    ? jsonl.slice(0, -'.jsonl'.length) + '.json'
    : savedPath.endsWith('.json')
      ? savedPath
      : jsonl.slice(0, -'.jsonl'.length) + '.json'

  // ── 1) loadTranscriptMessages 与内存一致 ──
  const loaded = await loadTranscriptMessages(jsonl)
  assert(sameMessages(loaded.messages, msgs), 'messages match after load')
  assert(loaded.meta?.sessionId === 'sess_load_01', 'meta sessionId')
  assert(loaded.meta?.model === 'mock-model', 'meta model')
  assert(loaded.path === path.resolve(jsonl), 'path resolved')

  // ── 2) 坏行跳过 ──
  await fs.appendFile(jsonl, 'not-json\n{"type":"message","broken":true}\n', 'utf8')
  const loaded2 = await loadTranscriptMessages(jsonl)
  assert(sameMessages(loaded2.messages, msgs), 'bad lines skipped')

  // ── 3) loadTranscriptFile entries 含 meta + messages ──
  const { entries } = await loadTranscriptFile(jsonl)
  assert(entries.some((e) => e.type === 'meta'), 'has meta entry')
  assert(
    entries.filter((e) => e.type === 'message').length === 3,
    '3 message entries',
  )

  // ── 4) JSON 删除后 resume 走 jsonl（先 opt-in 写 JSON 再删）──
  await saveSession(session, { sessionsDir, writeJsonSnapshot: true })
  assert((await fs.stat(jsonPath)).isFile(), 'opt-in json exists')
  await fs.unlink(jsonPath)
  assert(
    resolveTranscriptPathFromJson(jsonPath) === path.resolve(jsonl),
    'path pair',
  )
  const { session: resumed, snapshot } = await resumeSession({
    idOrPath: 'sess_load_01',
    sessionsDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
    provider: createMockProvider(),
  })
  assert(sameMessages(resumed.messages, msgs), 'resume from jsonl messages')
  assert(snapshot.id === 'sess_load_01', 'snapshot id')
  assert(resumed.model === 'mock-model', 'resumed model from meta')

  // ── 5) 直接路径 .jsonl ──
  const { session: r2 } = await resumeSession({
    idOrPath: jsonl,
    reassembleSystem: false,
    systemPrompt: false,
    provider: createMockProvider(),
  })
  assert(sameMessages(r2.messages, msgs), 'resume by .jsonl path')

  // ── 6) J-D R1：最后 compact_boundary 之后的 messages ──
  const r1Path = path.join(sessionsDir, 'r1_boundary.jsonl')
  await fs.writeFile(
    r1Path,
    [
      JSON.stringify({
        type: 'meta',
        sessionId: 'r1_boundary',
        timestamp: '2020-01-01T00:00:00.000Z',
        model: 'm-r1',
      }),
      JSON.stringify({
        type: 'message',
        sessionId: 'r1_boundary',
        timestamp: '2020-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'pre-compact old' },
      }),
      JSON.stringify({
        type: 'message',
        sessionId: 'r1_boundary',
        timestamp: '2020-01-01T00:00:02.000Z',
        message: { role: 'assistant', content: 'pre-compact reply' },
      }),
      JSON.stringify({
        type: 'compact_boundary',
        sessionId: 'r1_boundary',
        timestamp: '2020-01-01T00:00:03.000Z',
        summary: 'compressed summary',
      }),
      JSON.stringify({
        type: 'message',
        sessionId: 'r1_boundary',
        timestamp: '2020-01-01T00:00:04.000Z',
        message: { role: 'user', content: 'post-compact only' },
      }),
      JSON.stringify({
        type: 'message',
        sessionId: 'r1_boundary',
        timestamp: '2020-01-01T00:00:05.000Z',
        message: { role: 'assistant', content: 'post-compact ack' },
      }),
      'half-line-broken{',
      '',
    ].join('\n') + '\n',
    'utf8',
  )
  const r1 = await loadTranscriptMessages(r1Path)
  assert(r1.usedCompactBoundary === true, 'R1 used boundary')
  assert(r1.messages.length === 2, `R1 messages after boundary got ${r1.messages.length}`)
  assert(r1.messages[0]!.content === 'post-compact only', 'R1 first msg')
  assert(r1.messages[1]!.content === 'post-compact ack', 'R1 second msg')
  assert(r1.meta?.sessionId === 'r1_boundary', 'R1 meta still first')

  // ── 7) 双文件：jsonl 全坏/无 message → messages 回退 JSON ──
  const conflictId = 'sess_conflict'
  const conflictJson = path.join(sessionsDir, `${conflictId}.json`)
  const conflictJsonl = path.join(sessionsDir, `${conflictId}.jsonl`)
  await fs.writeFile(
    conflictJson,
    JSON.stringify(
      {
        version: 1,
        id: conflictId,
        cwd,
        permissionMode: 'default',
        messages: [
          { role: 'user', content: 'from-json-snapshot' },
          { role: 'assistant', content: 'json-ok' },
        ],
        systemPromptSections: [],
        autoCompactEnabled: true,
        contextWindowTokens: 128000,
        maxPtlRetries: 3,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  await fs.writeFile(
    conflictJsonl,
    [
      JSON.stringify({
        type: 'meta',
        sessionId: conflictId,
        timestamp: '2020-01-01T00:00:00.000Z',
      }),
      'not-json-line',
      '{"type":"message","broken":true}',
      'half-open{',
      '',
    ].join('\n'),
    'utf8',
  )
  const { session: conflictSess } = await resumeSession({
    idOrPath: conflictId,
    sessionsDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
    provider: createMockProvider(),
  })
  assert(
    conflictSess.messages.length === 2 &&
      conflictSess.messages[0]!.content === 'from-json-snapshot',
    'empty/bad jsonl falls back to JSON messages',
  )

  // ── 8) 双文件：jsonl 有有效 message → 优先 jsonl ──
  await fs.writeFile(
    conflictJsonl,
    [
      JSON.stringify({
        type: 'meta',
        sessionId: conflictId,
        timestamp: '2020-01-01T00:00:00.000Z',
        model: 'from-jsonl-meta',
      }),
      JSON.stringify({
        type: 'message',
        sessionId: conflictId,
        timestamp: '2020-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'from-jsonl-wins' },
      }),
      '',
    ].join('\n'),
    'utf8',
  )
  const { session: winSess, snapshot: winSnap } = await resumeSession({
    idOrPath: conflictId,
    sessionsDir,
    cwd,
    reassembleSystem: false,
    systemPrompt: false,
    provider: createMockProvider(),
  })
  assert(
    winSess.messages.length === 1 &&
      winSess.messages[0]!.content === 'from-jsonl-wins',
    'valid jsonl messages win over JSON',
  )
  assert(winSnap.id === conflictId, 'conflict snapshot id')

  await fs.rm(tmpRoot, { recursive: true, force: true })
  console.log('PASS: test-transcript-load')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})