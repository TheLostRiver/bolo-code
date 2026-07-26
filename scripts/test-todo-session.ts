/**
 * AR-T1b：TodoWrite 在 core 侧的接线
 * - 工具经 ctx.extras.todoStore 写进 session（live store，不是快照）
 * - 全部 completed → 存储清空
 * - **表不在 messages 里 ⇒ compact 改写历史后仍在**（本刀的核心主张）
 * - transcript 全量快照 append + resume 投影
 * - reminder 锚点计数与注入时机（含 compact/resume 后的快速路径）
 *
 * 运行：npx tsx scripts/test-todo-session.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendSessionTodos,
  buildTodoReminderMessage,
  computeTodoReminderAnchors,
  createSession,
  getSessionTodoStore,
  loadTranscriptFile,
  projectTodosFromEntries,
  resolveSessionFilePath,
  resolveTranscriptPathFromJson,
  saveSession,
  resumeSession,
} from '../packages/core/src/index.ts'
import { createTodoWriteTool } from '../packages/tools/src/index.ts'
import {
  TODO_REMINDER_OPEN_TAG,
  TODO_REMINDER_TURNS_BETWEEN,
  TODO_REMINDER_TURNS_SINCE_WRITE,
  type ChatMessage,
} from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content }
}

function todoWriteCall(): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 't1', name: 'TodoWrite', arguments: '{}' }],
  }
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-todo-'))
  const cwd = path.join(tmpRoot, 'proj')
  const sessionsDir = path.join(tmpRoot, 'sessions')
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  const session = await createSession({
    cwd,
    sessionId: 'sess_todo_01',
    systemPrompt: false,
    permissionMode: 'acceptEdits',
    model: 'mock-model',
  })

  // ── 1) 工具经 live store 写进 session ──
  const tool = createTodoWriteTool()
  const store = getSessionTodoStore(session)
  const ctx = { cwd, sessionId: session.id, extras: { todoStore: store } }

  const r1 = await tool.call(
    {
      todos: [
        { content: 'build parser', status: 'in_progress', activeForm: 'Building parser' },
        { content: 'write tests', status: 'pending', activeForm: 'Writing tests' },
      ],
    },
    ctx,
  )
  assert(r1.ok === true, 'TodoWrite succeeds')
  assert(session.todos?.length === 2, 'session.todos updated through live store')
  assert(session.todos?.[0]!.content === 'build parser', 'first todo stored')

  // ── 2) 无 store 时明确失败，不静默丢弃 ──
  const orphan = await tool.call({ todos: [] }, { cwd, sessionId: session.id })
  assert(orphan.ok === false, 'TodoWrite without a store fails')
  assert(orphan.errorCode === 'unavailable', 'unavailable error code')

  // ── 3) 校验失败不写坏状态 ──
  const before = JSON.stringify(session.todos)
  const bad = await tool.call(
    { todos: [{ content: '', status: 'pending', activeForm: 'x' }] },
    ctx,
  )
  assert(bad.ok === false, 'invalid todo rejected')
  assert(
    JSON.stringify(session.todos) === before,
    'rejected write leaves session state untouched',
  )

  // ── 4) in_progress 基数问题 → 成功但带 NOTE ──
  const warned = await tool.call(
    {
      todos: [
        { content: 'a', status: 'in_progress', activeForm: 'A' },
        { content: 'b', status: 'in_progress', activeForm: 'B' },
      ],
    },
    ctx,
  )
  assert(warned.ok === true, 'multiple in_progress accepted')
  assert(/NOTE:/.test(warned.output), 'warning surfaced to the model')

  // ── 5) 全部完成 → 存储清空 ──
  const done = await tool.call(
    {
      todos: [
        { content: 'a', status: 'completed', activeForm: 'A' },
        { content: 'b', status: 'completed', activeForm: 'B' },
      ],
    },
    ctx,
  )
  assert(done.ok === true, 'all-completed write succeeds')
  assert(session.todos?.length === 0, 'all completed clears stored list')

  // ── 6) 核心主张：compact 换掉整条历史，表照样在 ──
  await tool.call(
    {
      todos: [
        { content: 'survive compaction', status: 'in_progress', activeForm: 'Surviving' },
      ],
    },
    ctx,
  )
  session.messages.length = 0
  session.messages.push(
    { role: 'system', content: 'Conversation compacted' },
    { role: 'user', content: 'summary of prior work' },
  )
  assert(
    session.todos?.length === 1 && session.todos[0]!.content === 'survive compaction',
    'todos survive a full message-history rewrite (compact)',
  )

  // ── 7) transcript 快照 append + 投影 ──
  await saveSession(session, { sessionsDir })
  await appendSessionTodos(session, session.todos ?? [], { sessionsDir })
  const jsonPath = resolveSessionFilePath(session.id, { cwd, sessionsDir })
  const { entries } = await loadTranscriptFile(
    resolveTranscriptPathFromJson(jsonPath),
  )
  const todoEntries = entries.filter((e) => e.type === 'todo')
  assert(todoEntries.length >= 1, 'todo entry appended to transcript')
  const projected = projectTodosFromEntries(entries)
  assert(projected.length === 1, 'projection returns latest snapshot')
  assert(projected[0]!.content === 'survive compaction', 'projected content matches')

  // 追加第二张快照 → 投影必须取最后一条
  await appendSessionTodos(
    session,
    [{ content: 'newer', status: 'pending', activeForm: 'Newer' }],
    { sessionsDir },
  )
  const reloaded = await loadTranscriptFile(
    resolveTranscriptPathFromJson(jsonPath),
  )
  const latest = projectTodosFromEntries(reloaded.entries)
  assert(latest.length === 1 && latest[0]!.content === 'newer', 'latest snapshot wins')

  // ── 8) resume 恢复待办表 ──
  const { session: resumed } = await resumeSession({
    idOrPath: session.id,
    cwd,
    sessionsDir,
    reassembleSystem: false,
    systemPrompt: false,
  })
  assert(
    resumed.todos?.length === 1 && resumed.todos[0]!.content === 'newer',
    'resume restores todos from transcript',
  )

  // ── 9) reminder 锚点计数 ──
  const noAnchors = computeTodoReminderAnchors([
    { role: 'user', content: 'hi' },
    assistant('working'),
  ])
  assert(noAnchors.writeAnchorMissing === true, 'no TodoWrite anchor detected')
  assert(noAnchors.reminderAnchorMissing === true, 'no reminder anchor detected')

  const withWrite = computeTodoReminderAnchors([
    todoWriteCall(),
    assistant('a'),
    assistant('b'),
  ])
  assert(withWrite.writeAnchorMissing === false, 'TodoWrite anchor found')
  assert(
    withWrite.assistantTurnsSinceWrite === 2,
    `two assistant turns since write, got ${withWrite.assistantTurnsSinceWrite}`,
  )

  const withReminder = computeTodoReminderAnchors([
    { role: 'user', content: `${TODO_REMINDER_OPEN_TAG}\n- [pending] x\n</todo_reminder>` },
    assistant('a'),
  ])
  assert(withReminder.reminderAnchorMissing === false, 'reminder anchor found')
  assert(
    withReminder.assistantTurnsSinceReminder === 1,
    'one assistant turn since reminder',
  )

  // ── 10) 注入时机 ──
  const todos = [
    { content: 'x', status: 'in_progress' as const, activeForm: 'X' },
  ]

  // 空表永不注入
  assert(
    buildTodoReminderMessage([], [{ role: 'user', content: 'hi' }]) === null,
    'no reminder for an empty list',
  )

  // 锚点都不在（compact / resume 后）→ 立刻注入
  const postCompact = buildTodoReminderMessage(todos, [
    { role: 'system', content: 'Conversation compacted' },
    { role: 'user', content: 'summary' },
  ])
  assert(postCompact !== null, 'reminder injected after compaction wipes anchors')
  assert(
    typeof postCompact!.content === 'string' &&
      postCompact!.content.startsWith(TODO_REMINDER_OPEN_TAG),
    'reminder message uses the wrapper tag',
  )
  assert(postCompact!.role === 'user', 'reminder enters history as a user message')

  // 刚写过 → 不注入
  const justWrote = buildTodoReminderMessage(todos, [
    todoWriteCall(),
    assistant('a'),
  ])
  assert(justWrote === null, 'no reminder right after a write')

  // 久未写且久未提醒 → 注入
  const stale: ChatMessage[] = [todoWriteCall()]
  for (let i = 0; i < TODO_REMINDER_TURNS_SINCE_WRITE; i++) stale.push(assistant(`t${i}`))
  assert(
    buildTodoReminderMessage(todos, stale) !== null,
    'reminder fires once the write threshold is crossed',
  )

  // 刚提醒过 → 即使久未写也不再注入（防刷屏）
  const recentlyReminded: ChatMessage[] = [todoWriteCall()]
  for (let i = 0; i < TODO_REMINDER_TURNS_SINCE_WRITE; i++) {
    recentlyReminded.push(assistant(`t${i}`))
  }
  recentlyReminded.push({
    role: 'user',
    content: `${TODO_REMINDER_OPEN_TAG}\n- [pending] x\n</todo_reminder>`,
  })
  for (let i = 0; i < TODO_REMINDER_TURNS_BETWEEN - 1; i++) {
    recentlyReminded.push(assistant(`u${i}`))
  }
  assert(
    buildTodoReminderMessage(todos, recentlyReminded) === null,
    'reminder respects spacing after a recent reminder',
  )

  await fs.rm(tmpRoot, { recursive: true, force: true })
  console.log('PASS: todo session wiring')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
