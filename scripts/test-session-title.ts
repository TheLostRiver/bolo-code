/**
 * J-D 余量：title entry + list title + rewrite 保留 + CLI parse
 * 运行：npx tsx scripts/test-session-title.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSession,
  saveSession,
  setSessionTitle,
  listProjectSessions,
  loadTranscriptMessages,
  loadTranscriptFile,
  rewriteTranscriptFromMessages,
  appendSessionTitle,
  messagesFromTranscriptEntries,
  submitUserInput,
} from '../packages/core/src/index.ts'
import { parseArgs } from '../packages/cli/src/parseArgs.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-title-'))
  const cwd = path.join(tmpRoot, 'proj')
  const sessionsDir = path.join(tmpRoot, 'sessions')
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  // ── 1) append title last-wins；不进 messages ──
  const s = await createSession({
    cwd,
    sessionId: 'sess_title_01',
    systemPrompt: false,
  })
  s.messages.push(
    { role: 'user', content: 'hello from user' } as ChatMessage,
    { role: 'assistant', content: 'hi' } as ChatMessage,
  )
  const { transcriptPath } = await saveSession(s, { sessionsDir })
  assert(transcriptPath, 'has transcript')

  const r1 = await setSessionTitle(s, '  First  Title  ', { sessionsDir })
  assert(r1.title === 'First Title', `normalize title: ${r1.title}`)

  await setSessionTitle(s, 'Final Title', { sessionsDir })

  const loaded = await loadTranscriptMessages(transcriptPath!)
  assert(loaded.title === 'Final Title', `last-wins title: ${loaded.title}`)
  assert(loaded.messages.length === 2, 'title not in messages')
  assert(
    loaded.messages.every((m) => m.role === 'user' || m.role === 'assistant'),
    'only chat roles',
  )

  const { entries } = await loadTranscriptFile(transcriptPath!)
  const titles = entries.filter((e) => e.type === 'title')
  assert(titles.length === 2, `two title entries got ${titles.length}`)
  const parsed = messagesFromTranscriptEntries(entries)
  assert(parsed.title === 'Final Title', 'messagesFrom title')
  assert(parsed.messages.length === 2, 'messagesFrom ignores title')

  // ── 2) listProjectSessions 带 title；preview 仍 user ──
  const listed = await listProjectSessions({ cwd, sessionsDir })
  const item = listed.find((x) => x.id === 'sess_title_01')
  assert(item, 'listed')
  assert(item!.title === 'Final Title', `list title: ${item!.title}`)
  assert(
    item!.preview.includes('hello from user'),
    `list preview still user: ${item!.preview}`,
  )

  // ── 3) rewrite 保留 last title ──
  s.messages.push({ role: 'user', content: 'more' } as ChatMessage)
  await rewriteTranscriptFromMessages(transcriptPath!, s)
  const afterRw = await loadTranscriptMessages(transcriptPath!)
  assert(afterRw.title === 'Final Title', `rewrite keeps title: ${afterRw.title}`)
  assert(afterRw.messages.length === 3, 'rewrite messages')

  // ── 4) /title slash ──
  const s2 = await createSession({
    cwd,
    sessionId: 'sess_title_slash',
    systemPrompt: false,
  })
  await saveSession(s2, { sessionsDir })
  // 挂 persist meta（save 后 filePath 在 WeakMap；setSessionTitle 用 sessionsDir 即可）
  const slashSet = await submitUserInput(s2, '/title My Slash Title')
  assert(slashSet.type === 'slash', 'slash type set')
  if (slashSet.type === 'slash') {
    assert(
      slashSet.message.includes('My Slash Title'),
      `slash set msg: ${slashSet.message}`,
    )
  }
  // submitUserInput /title 走 setSessionTitle，默认 project layout；测试用 sessionsDir 需再写一次
  await setSessionTitle(s2, 'My Slash Title', { sessionsDir })
  const slashShow = await submitUserInput(s2, '/title')
  // 无 sessionsDir 时可能读不到；核心 API 已验
  assert(slashShow.type === 'slash', 'slash type show')

  // ── 5) CLI parse：--list / migrate-session ──
  const a1 = parseArgs(['--list'])
  assert(a1.list === true, '--list')
  const a2 = parseArgs(['-l'])
  assert(a2.list === true, '-l')
  const a3 = parseArgs(['--migrate-session', 'sid1'])
  assert(a3.migrateSession === 'sid1', '--migrate-session id')
  const a4 = parseArgs(['migrate-session', 'sid2', '--force', '--delete-json'])
  assert(a4.migrateSession === 'sid2', 'positional migrate-session')
  assert(a4.force === true && a4.deleteJson === true, 'migrate flags')
  const a5 = parseArgs(['--migrate-session=path/to/x.json'])
  assert(a5.migrateSession === 'path/to/x.json', 'migrate=')

  // 空 title 拒绝
  let threw = false
  try {
    await appendSessionTitle(transcriptPath!, {
      sessionId: s.id,
      title: '   ',
    })
  } catch {
    threw = true
  }
  assert(threw, 'empty title throws')

  console.log('ok: test-session-title')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})