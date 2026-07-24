/**
 * system_note entry + scanTranscriptLite + list 预览
 * 运行：node --import tsx/esm scripts/test-session-notes-lite.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendSystemNote,
  appendSessionTitle,
  buildMetaEntry,
  ensureTranscriptFile,
  loadTranscriptFile,
  loadTranscriptMessages,
  messagesFromTranscriptEntries,
  rewriteTranscriptFromMessages,
  scanTranscriptLite,
  systemNotesFromTranscriptEntries,
  listProjectSessions,
  createSession,
  saveSession,
  appendSessionSystemNote,
  submitUserInput,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-notes-'))
  const sessionsDir = path.join(tmp, 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })
  const file = path.join(sessionsDir, 'n1.jsonl')

  await ensureTranscriptFile(
    file,
    buildMetaEntry({
      sessionId: 'n1',
      cwd: tmp,
      model: 'm-test',
    }),
  )
  await fs.appendFile(
    file,
    JSON.stringify({
      type: 'message',
      sessionId: 'n1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello first' },
    }) + '\n',
    'utf8',
  )
  await appendSystemNote(file, {
    sessionId: 'n1',
    text: 'PTL retried once',
    kind: 'ptl',
  })
  await appendSessionTitle(file, { sessionId: 'n1', title: 'Note Session' })
  await fs.appendFile(
    file,
    JSON.stringify({
      type: 'message',
      sessionId: 'n1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'second turn near' },
    }) + '\n',
    'utf8',
  )

  const loaded = await loadTranscriptFile(file)
  const notes = systemNotesFromTranscriptEntries(loaded.entries)
  assert(notes.length === 1, 'one system_note')
  assert(notes[0]!.kind === 'ptl', 'note kind')
  assert(notes[0]!.text.includes('PTL'), 'note text')

  const rebuilt = messagesFromTranscriptEntries(loaded.entries)
  assert(rebuilt.messages.length === 2, 'messages only, notes excluded')
  assert(rebuilt.title === 'Note Session', 'title last-wins')
  assert(rebuilt.systemNotes?.length === 1, 'systemNotes on rebuild')

  const lite = await scanTranscriptLite(file)
  assert(lite.title === 'Note Session', 'lite title')
  assert(lite.messageCount === 2, 'lite messageCount')
  assert(lite.noteCount === 1, 'lite noteCount')
  assert(lite.preview.includes('second'), 'lite preview prefers last user')
  assert(lite.model === 'm-test', 'lite model')

  // rewrite 保留 note + title
  const session = {
    id: 'n1',
    cwd: tmp,
    permissionMode: 'default' as const,
    model: 'm-test',
    messages: [
      { role: 'user', content: 'after compact only' } as ChatMessage,
    ],
    systemPromptSections: [] as string[],
  }
  await rewriteTranscriptFromMessages(file, session, {
    compactBoundarySummary: 'sum',
  })
  const after = await loadTranscriptFile(file)
  const notes2 = systemNotesFromTranscriptEntries(after.entries)
  assert(notes2.length === 1, 'rewrite keeps system_note')
  assert(
    after.entries.some((e) => e.type === 'title'),
    'rewrite keeps title',
  )
  const msgs = await loadTranscriptMessages(file)
  assert(msgs.messages.length === 1, 'R1 after boundary: 1 message')
  assert(msgs.messages[0]!.content === 'after compact only', 'msg body')

  // list via session API
  const s = await createSession({
    cwd: tmp,
    sessionId: 'list_note',
    systemPrompt: false,
  })
  s.messages.push({ role: 'user', content: 'list me' } as ChatMessage)
  await saveSession(s, { sessionsDir })
  await appendSessionSystemNote(s, 'manual audit', {
    kind: 'manual',
    sessionsDir,
  })
  const items = await listProjectSessions({ cwd: tmp, sessionsDir })
  const hit = items.find((i) => i.id === 'list_note')
  assert(hit, 'listed')
  assert(hit!.messageCount >= 1, 'list messageCount')
  assert(hit!.preview.includes('list me') || hit!.preview.length > 0, 'list preview')

  // slash /note
  const s2 = await createSession({
    cwd: tmp,
    sessionId: 'slash_note',
    systemPrompt: false,
  })
  await saveSession(s2, { sessionsDir })
  const { setSessionPersistMeta } = await import(
    '../packages/core/src/sessionPersist.ts'
  )
  setSessionPersistMeta(s2, { sessionsDir, scope: 'project' })
  const r = await submitUserInput(s2, '/note ptl:hello from slash')
  assert(r.type === 'slash', 'slash note type')
  assert(
    r.type === 'slash' && r.message.includes('Note appended'),
    `slash note append: ${r.type === 'slash' ? r.message : r.type}`,
  )
  const r2 = await submitUserInput(s2, '/note')
  assert(r2.type === 'slash', 'slash note list type')
  assert(
    r2.type === 'slash' && r2.message.includes('hello from slash'),
    'slash note list content',
  )

  console.log('ok: test-session-notes-lite')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})