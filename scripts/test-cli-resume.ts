/**
 * CLI resume：parseArgs + 写临时 session → resumeFromIdOrPath
 * 运行：npx tsx scripts/test-cli-resume.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseArgs,
  formatHelp,
  resumeFromIdOrPath,
  buildSessionSummary,
  formatSessionSummary,
  lastAssistantText,
} from '../packages/cli/src/index.ts'
import {
  createSession,
  saveSession,
  submitPrompt,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // ── 1) parseArgs ──
  const a1 = parseArgs(['--resume', 'sess_abc'])
  assert(a1.resume === 'sess_abc', 'resume space form')
  assert(a1.print === false, 'default no print')

  const a2 = parseArgs(['--resume=sess_eq', '-p', 'hello world'])
  assert(a2.resume === 'sess_eq', 'resume= form')
  assert(a2.print === true, 'print from -p')
  assert(a2.prompt === 'hello world', 'prompt from -p')

  const a3 = parseArgs(['-r', 'sid', 'follow', 'up'])
  assert(a3.resume === 'sid', '-r alias')
  assert(a3.prompt === 'follow up', 'positionals as prompt')

  const a4 = parseArgs(['--resume', 'C:\\tmp\\x.json', '--print'])
  assert(a4.resume === 'C:\\tmp\\x.json', 'path as resume')
  assert(a4.print === true, '--print')

  const a5 = parseArgs(['--cwd', '/proj', '--resume', 'id1'])
  assert(a5.cwd === '/proj', 'cwd')

  let threw = false
  try {
    parseArgs(['--resume'])
  } catch {
    threw = true
  }
  assert(threw, 'missing resume value throws')

  assert(formatHelp().includes('--resume'), 'help mentions resume')

  // ── 2) 临时 session 文件 → resume ──
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-cli-'))
  const cwd = path.join(tmpRoot, 'proj')
  const sessionsDir = path.join(cwd, '.bolo', 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })

  const messages: ChatMessage[] = [
    { role: 'user', content: 'hi from fixture' },
    { role: 'assistant', content: 'hello back' },
  ]

  const session = await createSession({
    cwd,
    sessionId: 'sess_cli_resume_01',
    systemPrompt: false,
    permissionMode: 'default',
    model: 'mock-cli',
  })
  session.messages.push(...messages)

  const { path: savedPath } = await saveSession(session, {
    sessionsDir,
  })
  assert((await fs.stat(savedPath)).isFile(), 'session file written')

  const out: string[] = []
  const err: string[] = []
  const resumed = await resumeFromIdOrPath({
    idOrPath: 'sess_cli_resume_01',
    cwd,
    forceMock: true,
    reassembleSystem: false,
    systemPrompt: false,
    writeOut: (s) => out.push(s),
    writeErr: (s) => err.push(s),
  })

  assert(resumed.session.id === 'sess_cli_resume_01', 'resume id')
  assert(resumed.session.messages.length === 2, 'resume messages count')
  assert(
    resumed.session.messages[0]?.content === 'hi from fixture',
    'resume first message',
  )
  assert(
    resumed.session.messages[1]?.content === 'hello back',
    'resume second message',
  )
  assert(resumed.path === savedPath, `path match ${resumed.path}`)

  const summary = buildSessionSummary(resumed.session, resumed.path)
  assert(summary.messageCount === 2, 'summary count')
  assert(summary.lastMessage?.role === 'assistant', 'last role')
  assert(
    formatSessionSummary(summary).includes('sess_cli_resume_01'),
    'format id',
  )

  // project → user 查找：只写 user，用 id 加载
  const userDir = path.join(tmpRoot, 'user-sessions')
  await fs.mkdir(userDir, { recursive: true })
  const prevHome = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(tmpRoot, 'user-bolo')
  await fs.mkdir(path.join(process.env.BOLO_CONFIG_DIR, 'sessions'), {
    recursive: true,
  })
  const userSess = await createSession({
    cwd,
    sessionId: 'sess_user_only',
    systemPrompt: false,
  })
  userSess.messages.push({ role: 'user', content: 'user-scope' })
  await saveSession(userSess, { scope: 'user' })

  const fromUser = await resumeFromIdOrPath({
    idOrPath: 'sess_user_only',
    cwd: path.join(tmpRoot, 'empty-proj'),
    forceMock: true,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(fromUser.session.id === 'sess_user_only', 'user scope fallback')
  assert(
    fromUser.session.messages[0]?.content === 'user-scope',
    'user message',
  )

  if (prevHome === undefined) delete process.env.BOLO_CONFIG_DIR
  else process.env.BOLO_CONFIG_DIR = prevHome

  // 绝对路径 resume
  const byPath = await resumeFromIdOrPath({
    idOrPath: savedPath,
    forceMock: true,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(byPath.session.id === 'sess_cli_resume_01', 'resume by path')

  // mock 单轮（可选）
  const before = byPath.session.messages.length
  await submitPrompt(byPath.session, 'ping')
  const asst = lastAssistantText(byPath.session.messages, before)
  assert(typeof asst === 'string', 'assistant text type')

  await fs.rm(tmpRoot, { recursive: true, force: true })
  console.log('PASS: test-cli-resume')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})