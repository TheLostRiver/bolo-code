/**
 * listProjectSessions + parseArgs resume picker + 非交互 list
 * 运行：node --import tsx/esm scripts/test-session-list.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listProjectSessions,
  sessionPreviewFromMessages,
  saveSession,
  createSession,
} from '../packages/core/src/index.ts'
import {
  parseArgs,
  isResumePicker,
  formatHelp,
  formatSessionList,
  pickProjectSessionId,
  ResumePickerError,
} from '../packages/cli/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function main() {
  // ── preview helper ──
  const prev = sessionPreviewFromMessages([
    { role: 'assistant', content: 'skip' },
    { role: 'user', content: '  hello   world  ' },
  ])
  assert(prev === 'hello world', 'preview trims whitespace')

  const long = 'x'.repeat(100)
  const prevLong = sessionPreviewFromMessages([{ role: 'user', content: long }])
  assert(prevLong.length === 80, 'preview max 80')
  assert(prevLong.endsWith('…'), 'preview ellipsis')

  // ── listProjectSessions ──
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-list-'))
  const cwd = path.join(tmpRoot, 'proj')
  const sessionsDir = path.join(cwd, '.bolo', 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })

  const s1 = await createSession({
    cwd,
    sessionId: 'sess_old',
    systemPrompt: false,
    model: 'm1',
  })
  s1.messages.push({ role: 'user', content: 'first session user text' } as ChatMessage)
  await saveSession(s1, { sessionsDir })

  await sleep(25)

  const s2 = await createSession({
    cwd,
    sessionId: 'sess_new',
    systemPrompt: false,
    model: 'm2',
  })
  s2.messages.push(
    { role: 'user', content: 'newer session preview here' } as ChatMessage,
    { role: 'assistant', content: 'ok' } as ChatMessage,
  )
  await saveSession(s2, { sessionsDir })

  // 坏文件应跳过
  await fs.writeFile(path.join(sessionsDir, 'broken.json'), '{not json', 'utf8')
  await fs.writeFile(path.join(sessionsDir, 'not-a-session.txt'), 'x', 'utf8')

  const listed = await listProjectSessions({ cwd, sessionsDir })
  assert(listed.length === 2, `list length 2 got ${listed.length}`)
  assert(listed[0]!.id === 'sess_new', 'newest first by updatedAt')
  assert(listed[1]!.id === 'sess_old', 'older second')
  assert(listed[0]!.messageCount === 2, 'messageCount new')
  assert(listed[1]!.messageCount === 1, 'messageCount old')
  assert(
    listed[0]!.preview.includes('newer session'),
    `preview new: ${listed[0]!.preview}`,
  )
  assert(
    listed[1]!.preview.includes('first session'),
    `preview old: ${listed[1]!.preview}`,
  )
  assert(listed[0]!.model === 'm2', 'model field')
  assert(listed[0]!.filePath.endsWith('sess_new.json'), 'filePath')

  const limited = await listProjectSessions({ cwd, sessionsDir, limit: 1 })
  assert(limited.length === 1 && limited[0]!.id === 'sess_new', 'limit 1')

  const empty = await listProjectSessions({
    cwd: path.join(tmpRoot, 'empty'),
    sessionsDir: path.join(tmpRoot, 'no-such-dir'),
  })
  assert(empty.length === 0, 'missing dir empty list')

  // ── parseArgs picker ──
  const p1 = parseArgs(['--resume'])
  assert(p1.resume === true, '--resume alone → true')
  assert(isResumePicker(p1.resume), 'isResumePicker true')

  const p2 = parseArgs(['-r'])
  assert(p2.resume === true, '-r alone → true')

  const p3 = parseArgs(['--resume='])
  assert(p3.resume === true, '--resume= empty → picker')

  const p4 = parseArgs(['--resume', 'sess_abc'])
  assert(p4.resume === 'sess_abc', '--resume id')
  assert(!isResumePicker(p4.resume), 'string not picker')

  const p5 = parseArgs(['-r', 'sid', '--print'])
  assert(p5.resume === 'sid' && p5.print, '-r id still works')

  const help = formatHelp()
  assert(help.includes('bolo --resume'), 'help bare resume')
  assert(
    help.includes('列出') || help.toLowerCase().includes('list') || help.includes('选择'),
    'help mentions list/select',
  )

  // ── formatSessionList ──
  const listText = formatSessionList(listed)
  assert(listText.includes('sess_new'), 'format list id')
  assert(listText.includes('1.'), 'format numbered')

  // ── non-TTY picker ──
  const out: string[] = []
  const err: string[] = []
  let nonTtyCode: number | undefined
  try {
    await pickProjectSessionId({
      cwd,
      sessionsDir,
      isTty: false,
      writeOut: (s) => out.push(s),
      writeErr: (s) => err.push(s),
    })
    assert(false, 'non-tty should throw')
  } catch (e) {
    assert(e instanceof ResumePickerError, 'ResumePickerError')
    nonTtyCode = (e as ResumePickerError).exitCode
  }
  assert(nonTtyCode === 2, `non-tty exit 2 got ${nonTtyCode}`)
  assert(out.join('').includes('sess_new'), 'non-tty prints list')
  assert(
    err.join('').includes('--resume'),
    'non-tty stderr hints --resume <id>',
  )

  // ── empty list ──
  let emptyCode: number | undefined
  try {
    await pickProjectSessionId({
      cwd: path.join(tmpRoot, 'empty2'),
      sessionsDir: path.join(tmpRoot, 'empty-sessions'),
      isTty: true,
      writeOut: () => {},
      writeErr: () => {},
    })
  } catch (e) {
    assert(e instanceof ResumePickerError, 'empty ResumePickerError')
    emptyCode = (e as ResumePickerError).exitCode
    assert(
      (e as Error).message.includes('bolo'),
      'empty message mentions bolo',
    )
  }
  assert(emptyCode === 1, `empty exit 1 got ${emptyCode}`)

  // ── TTY pick via readChoice ──
  const picked = await pickProjectSessionId({
    cwd,
    sessionsDir,
    isTty: true,
    writeOut: () => {},
    writeErr: () => {},
    readChoice: async () => '2',
  })
  assert(picked === 'sess_old', `pick #2 → sess_old got ${picked}`)

  await fs.rm(tmpRoot, { recursive: true, force: true })
  console.log('PASS: test-session-list')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})