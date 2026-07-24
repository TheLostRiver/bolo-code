/**
 * JSONL transcript append（T1 双写最小测）
 * 运行：npx tsx scripts/test-transcript-append.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSession,
  saveSession,
  appendTranscriptLine,
  ensureTranscriptFile,
  recordSessionMessages,
  dualWriteSessionTranscript,
  resolveTranscriptPathFromJson,
  countTranscriptMessageEntries,
  getTranscriptWriteState,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function readLines(file: string): Promise<string[]> {
  const raw = await fs.readFile(file, 'utf8')
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-transcript-'))
  const cwd = path.join(tmpRoot, 'proj')
  const sessionsDir = path.join(tmpRoot, 'sessions')
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  const file = path.join(sessionsDir, 'unit.jsonl')

  // ── 1) ensure + append meta once ──
  const created1 = await ensureTranscriptFile(file, {
    sessionId: 'unit',
    cwd,
    permissionMode: 'default',
    model: 'mock',
  })
  assert(created1 === true, 'ensure creates file')
  const created2 = await ensureTranscriptFile(file, {
    sessionId: 'unit',
    cwd,
  })
  assert(created2 === false, 'ensure is idempotent')
  let lines = await readLines(file)
  assert(lines.length === 1, `meta only: ${lines.length}`)
  const meta = JSON.parse(lines[0]!) as { type: string; sessionId: string }
  assert(meta.type === 'meta', 'first line meta')
  assert(meta.sessionId === 'unit', 'meta sessionId')

  // ── 2) recordSessionMessages ──
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ]
  const n = await recordSessionMessages(file, msgs, { sessionId: 'unit' })
  assert(n === 2, 'recorded 2')
  lines = await readLines(file)
  assert(lines.length === 3, `meta+2 messages: ${lines.length}`)
  const m1 = JSON.parse(lines[1]!) as { type: string; message: ChatMessage }
  assert(m1.type === 'message' && m1.message.content === 'u1', 'message entry')

  // ── 3) appendTranscriptLine compact_boundary ──
  await appendTranscriptLine(file, {
    type: 'compact_boundary',
    sessionId: 'unit',
    timestamp: new Date().toISOString(),
    summary: 'test',
  })
  lines = await readLines(file)
  assert(lines.length === 4, 'boundary appended')
  assert(
    (JSON.parse(lines[3]!) as { type: string }).type === 'compact_boundary',
    'boundary type',
  )

  // ── 4) 损坏行跳过计数 ──
  await fs.appendFile(file, '{not-json\n', 'utf8')
  await appendTranscriptLine(file, {
    type: 'message',
    sessionId: 'unit',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'after-bad' },
  })
  const msgCount = await countTranscriptMessageEntries(file)
  assert(msgCount === 3, `message count ignores bad lines: ${msgCount}`)

  // ── 5) saveSession T3：默认只写 jsonl 增量 ──
  const session = await createSession({
    cwd,
    sessionId: 'sess_dual_01',
    systemPrompt: false,
  })
  session.messages.push(
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  )
  const { path: savedPath, transcriptPath } = await saveSession(session, {
    sessionsDir,
  })
  assert(savedPath.endsWith('.jsonl'), 'T3 path is jsonl')
  assert(
    transcriptPath === resolveTranscriptPathFromJson(
      savedPath.endsWith('.jsonl')
        ? savedPath.slice(0, -'.jsonl'.length) + '.json'
        : savedPath,
    ),
    'transcript path paired',
  )
  assert((await fs.stat(transcriptPath!)).isFile(), 'jsonl exists')
  const pairedJson = path.join(sessionsDir, 'sess_dual_01.json')
  try {
    await fs.stat(pairedJson)
    assert(false, 'no JSON by default')
  } catch (e) {
    assert((e as NodeJS.ErrnoException).code === 'ENOENT', 'json absent')
  }
  const tLines1 = await readLines(transcriptPath!)
  assert(tLines1.length === 3, `meta+2: ${tLines1.length}`)
  const metaLine = JSON.parse(tLines1[0]!) as {
    type: string
    autoCompactEnabled?: boolean
  }
  assert(metaLine.type === 'meta', 'meta first')
  assert(
    typeof metaLine.autoCompactEnabled === 'boolean',
    'meta carries config slice',
  )
  assert(getTranscriptWriteState(session)?.appendedMessageCount === 2, 'state 2')

  // 再加一条，应只 append 1 行
  session.messages.push({ role: 'user', content: 'round2' })
  await saveSession(session, { sessionsDir })
  const tLines2 = await readLines(transcriptPath!)
  assert(tLines2.length === 4, `incremental append: ${tLines2.length}`)
  assert(getTranscriptWriteState(session)?.appendedMessageCount === 3, 'state 3')

  // 同内容再 save：行数不变
  await saveSession(session, { sessionsDir })
  const tLines3 = await readLines(transcriptPath!)
  assert(tLines3.length === 4, 'no-op save no append')

  // ── 6) dualWrite 直接 API：messages 变短 → rewrite ──
  const jsonPathForDual = pairedJson
  session.messages.length = 0
  session.messages.push({ role: 'user', content: 'compacted' })
  const r = await dualWriteSessionTranscript(session, jsonPathForDual)
  assert(r.rewritten === true, 'rewritten after shrink')
  const tLines4 = await readLines(r.transcriptPath)
  assert(tLines4.length === 2, `rewrite meta+1: ${tLines4.length}`)
  const after = JSON.parse(tLines4[1]!) as {
    type: string
    message: ChatMessage
  }
  assert(after.message.content === 'compacted', 'rewritten content')

  // ── 7) 冷启动基线：新 session 对象无 WeakMap，按磁盘 message 行数对齐 ──
  const session2 = await createSession({
    cwd,
    sessionId: 'sess_dual_01',
    systemPrompt: false,
  })
  session2.messages.push({ role: 'user', content: 'compacted' })
  const r2 = await dualWriteSessionTranscript(session2, jsonPathForDual)
  assert(r2.appended === 0, 'cold start no re-append')
  const tLines5 = await readLines(r2.transcriptPath)
  assert(tLines5.length === 2, 'still 2 lines after cold save')

  await fs.rm(tmpRoot, { recursive: true, force: true })
  console.log('PASS: test-transcript-append')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})