/**
 * AR-T1a：TodoWrite 纯契约
 * - TodoItem 校验（content / activeForm / status）
 * - 单一 in_progress 为「警告」而非拒绝（对齐 HC：schema 不硬校验，靠提示词约束）
 * - 整表替换语义 + 全 completed 清空存储
 * - reminder 触发策略（assistant 轮数双阈值）
 * - reminder 文本包裹格式
 *
 * 运行：npx tsx scripts/test-todo.ts
 */
import {
  TODO_STATUSES,
  TODO_REMINDER_TURNS_BETWEEN,
  TODO_REMINDER_TURNS_SINCE_WRITE,
  TODO_REMINDER_CLOSE_TAG,
  TODO_REMINDER_OPEN_TAG,
  applyTodoWrite,
  formatTodoReminder,
  shouldRemindTodos,
  summarizeTodoList,
  validateTodoList,
  type TodoItem,
} from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function item(
  content: string,
  status: TodoItem['status'],
  activeForm = `doing ${content}`,
): TodoItem {
  return { content, status, activeForm }
}

async function main() {
  // ── 1) 状态枚举 ──
  assert(
    TODO_STATUSES.length === 3 &&
      TODO_STATUSES.includes('pending') &&
      TODO_STATUSES.includes('in_progress') &&
      TODO_STATUSES.includes('completed'),
    'TODO_STATUSES = pending|in_progress|completed',
  )

  // ── 2) 结构性拒绝 ──
  assert(validateTodoList(undefined).ok === false, 'undefined rejected')
  assert(validateTodoList(null).ok === false, 'null rejected')
  assert(validateTodoList('nope').ok === false, 'string rejected')
  assert(validateTodoList({}).ok === false, 'object rejected')

  const notArray = validateTodoList(42)
  assert(
    notArray.ok === false && notArray.code === 'not_array',
    'non-array → code not_array',
  )

  assert(
    validateTodoList([null]).ok === false,
    'null element rejected',
  )
  const notObject = validateTodoList(['x'])
  assert(
    notObject.ok === false && notObject.code === 'not_object',
    'non-object element → code not_object',
  )

  // ── 3) 字段校验 ──
  const emptyContent = validateTodoList([
    { content: '   ', status: 'pending', activeForm: 'a' },
  ])
  assert(
    emptyContent.ok === false && emptyContent.code === 'empty_content',
    'blank content rejected',
  )

  const emptyActive = validateTodoList([
    { content: 'a', status: 'pending', activeForm: '' },
  ])
  assert(
    emptyActive.ok === false && emptyActive.code === 'empty_active_form',
    'blank activeForm rejected',
  )

  const badStatus = validateTodoList([
    { content: 'a', status: 'done', activeForm: 'b' },
  ])
  assert(
    badStatus.ok === false && badStatus.code === 'invalid_status',
    'unknown status rejected',
  )

  // ── 4) 空表合法（清空计划） ──
  const empty = validateTodoList([])
  assert(empty.ok === true, 'empty list accepted')
  assert(empty.ok === true && empty.todos.length === 0, 'empty list normalized')
  assert(
    empty.ok === true && empty.warnings.length === 0,
    'empty list produces no warning',
  )

  // ── 5) 合法表 + trim 归一 ──
  const good = validateTodoList([
    { content: '  build parser ', status: 'in_progress', activeForm: ' Building parser ' },
    { content: 'write tests', status: 'pending', activeForm: 'Writing tests' },
  ])
  assert(good.ok === true, 'valid list accepted')
  assert(
    good.ok === true && good.todos[0]!.content === 'build parser',
    'content trimmed',
  )
  assert(
    good.ok === true && good.todos[0]!.activeForm === 'Building parser',
    'activeForm trimmed',
  )
  assert(good.ok === true && good.warnings.length === 0, 'well-formed list no warning')

  // ── 6) in_progress 基数 = 警告，不是拒绝（HC 语义） ──
  const twoActive = validateTodoList([
    item('a', 'in_progress'),
    item('b', 'in_progress'),
  ])
  assert(twoActive.ok === true, 'multiple in_progress still accepted')
  assert(
    twoActive.ok === true &&
      twoActive.warnings.some((w) => /in_progress/.test(w)),
    'multiple in_progress warns',
  )

  const noneActive = validateTodoList([item('a', 'pending'), item('b', 'pending')])
  assert(noneActive.ok === true, 'zero in_progress accepted')
  assert(
    noneActive.ok === true &&
      noneActive.warnings.some((w) => /in_progress/.test(w)),
    'zero in_progress warns when work remains',
  )

  const allDoneValidation = validateTodoList([
    item('a', 'completed'),
    item('b', 'completed'),
  ])
  assert(
    allDoneValidation.ok === true && allDoneValidation.warnings.length === 0,
    'all completed → no in_progress warning',
  )

  // ── 7) summarize ──
  const sum = summarizeTodoList([
    item('a', 'completed'),
    item('b', 'in_progress'),
    item('c', 'pending'),
    item('d', 'pending'),
  ])
  assert(sum.total === 4, 'summary total')
  assert(sum.completed === 1, 'summary completed')
  assert(sum.inProgress === 1, 'summary inProgress')
  assert(sum.pending === 2, 'summary pending')
  assert(sum.allDone === false, 'summary allDone false')
  assert(sum.activeForm === 'doing b', 'summary surfaces active form')

  const doneSum = summarizeTodoList([item('a', 'completed')])
  assert(doneSum.allDone === true, 'summary allDone true')
  assert(doneSum.activeForm === undefined, 'no active form when nothing running')
  assert(summarizeTodoList([]).allDone === false, 'empty list is not allDone')

  // ── 8) 整表替换 + 全完成清空存储（HC: allDone → store []） ──
  const prev = [item('old', 'in_progress')]
  const next = [item('a', 'completed'), item('b', 'pending')]
  const applied = applyTodoWrite(prev, next)
  assert(applied.previous === prev, 'applyTodoWrite echoes previous')
  assert(applied.stored.length === 2, 'partial list stored verbatim')
  assert(applied.stored[1]!.content === 'b', 'stored order preserved')
  assert(applied.visible.length === 2, 'visible list = input')
  assert(applied.allDone === false, 'not all done')

  const allDone = applyTodoWrite(prev, [item('a', 'completed')])
  assert(allDone.allDone === true, 'allDone detected')
  assert(allDone.stored.length === 0, 'allDone clears stored list')
  assert(
    allDone.visible.length === 1,
    'allDone still returns the completed list for display',
  )

  // 幂等：同一输入再 apply 一次，stored 相同
  const again = applyTodoWrite(applied.stored, next)
  assert(
    JSON.stringify(again.stored) === JSON.stringify(applied.stored),
    'applyTodoWrite idempotent for identical input',
  )

  // 存储与输入不共享引用（防止调用方后续 mutate 污染 session 状态）
  assert(applied.stored !== next, 'stored is a copy, not the input array')
  assert(applied.stored[0] !== next[0], 'stored items are copies')

  // ── 9) reminder 双阈值 ──
  assert(TODO_REMINDER_TURNS_SINCE_WRITE > 0, 'turns-since-write threshold set')
  assert(TODO_REMINDER_TURNS_BETWEEN > 0, 'turns-between threshold set')

  assert(
    shouldRemindTodos({
      hasTodos: true,
      assistantTurnsSinceWrite: TODO_REMINDER_TURNS_SINCE_WRITE,
      assistantTurnsSinceReminder: TODO_REMINDER_TURNS_BETWEEN,
    }) === true,
    'reminds at threshold',
  )
  assert(
    shouldRemindTodos({
      hasTodos: true,
      assistantTurnsSinceWrite: TODO_REMINDER_TURNS_SINCE_WRITE - 1,
      assistantTurnsSinceReminder: TODO_REMINDER_TURNS_BETWEEN,
    }) === false,
    'no reminder before write threshold',
  )
  assert(
    shouldRemindTodos({
      hasTodos: true,
      assistantTurnsSinceWrite: TODO_REMINDER_TURNS_SINCE_WRITE,
      assistantTurnsSinceReminder: TODO_REMINDER_TURNS_BETWEEN - 1,
    }) === false,
    'no reminder before spacing threshold',
  )
  assert(
    shouldRemindTodos({
      hasTodos: false,
      assistantTurnsSinceWrite: 999,
      assistantTurnsSinceReminder: 999,
    }) === false,
    'never remind with an empty todo list',
  )

  // ── 9b) 锚点丢失（compact / resume）快速路径 ──
  assert(
    shouldRemindTodos({
      hasTodos: true,
      assistantTurnsSinceWrite: 0,
      assistantTurnsSinceReminder: 0,
      writeAnchorMissing: true,
      reminderAnchorMissing: true,
    }) === true,
    'both anchors gone (post-compact/resume) → remind immediately',
  )
  assert(
    shouldRemindTodos({
      hasTodos: true,
      assistantTurnsSinceWrite: 0,
      assistantTurnsSinceReminder: 0,
      writeAnchorMissing: true,
      reminderAnchorMissing: false,
    }) === false,
    'reminder already present in history → do not re-fire',
  )
  assert(
    shouldRemindTodos({
      hasTodos: false,
      assistantTurnsSinceWrite: 0,
      assistantTurnsSinceReminder: 0,
      writeAnchorMissing: true,
      reminderAnchorMissing: true,
    }) === false,
    'anchor fast-path still respects empty list',
  )

  // ── 10) reminder 文本：包裹标签 + 内容 + 不泄漏内部字段 ──
  const reminder = formatTodoReminder([
    item('build parser', 'in_progress', 'Building parser'),
    item('write tests', 'pending', 'Writing tests'),
  ])
  assert(reminder.startsWith(TODO_REMINDER_OPEN_TAG), 'reminder opens with tag')
  assert(reminder.trimEnd().endsWith(TODO_REMINDER_CLOSE_TAG), 'reminder closes with tag')
  assert(reminder.includes('build parser'), 'reminder lists content')
  assert(reminder.includes('in_progress'), 'reminder shows status')
  assert(
    formatTodoReminder([]).includes('no todo'),
    'empty reminder states there is no list',
  )

  console.log('PASS: todo contract')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
