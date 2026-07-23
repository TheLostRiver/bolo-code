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

  const { path: jsonPath, transcriptPath } = await saveSession(session, {
    sessionsDir,
  })
  assert(transcriptPath, 'has transcriptPath')
  const jsonl = transcriptPath!

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

  // ── 4) JSON 删除后 resume 走 jsonl ──
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

  await fs.rm(tmpRoot, { recursive: true, force: true })
  console.log('PASS: test-transcript-load')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})