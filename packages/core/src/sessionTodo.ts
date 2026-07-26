/**
 * AR-T1：会话待办表在 core 侧的接线
 *
 * 设计要点（对照参考实现）：
 * - 表存在 **session 上**，不进 messages ⇒ compact 改写历史时不会被摘要吞掉
 * - 因此模型「看不见」它；靠周期性把 `<todo_reminder>` 块注入对话来同步
 * - 注入锚点直接从 messages 反扫得出，不额外持久化计数器：
 *   compact / resume 之后锚点自然消失 → 判定为「模型已失去视野」→ 立刻重注入一次
 */

import {
  TODO_REMINDER_OPEN_TAG,
  formatTodoReminder,
  shouldRemindTodos,
  type ChatMessage,
  type TodoItem,
  type TodoWriteApplication,
} from '../../shared/src/index.ts'
import { TODO_WRITE_TOOL_NAME, type TodoStoreRef } from '../../tools/src/index.ts'

/** 承载 todo 的最小 session 形状；避免与 BoloSession 全量类型耦合 */
export type TodoSessionRef = {
  todos?: TodoItem[]
  onTodoWrite?: (
    application: TodoWriteApplication,
  ) => void | Promise<void>
}

/**
 * 返回绑定到 session 的 live store。
 * 用 getter/setter 而不是快照，保证工具写入直接落到 session.todos。
 */
export function getSessionTodoStore(session: TodoSessionRef): TodoStoreRef {
  return {
    get todos(): TodoItem[] {
      if (!Array.isArray(session.todos)) session.todos = []
      return session.todos
    },
    set todos(next: TodoItem[]) {
      session.todos = next
    },
    onWrite: async (application) => {
      await session.onTodoWrite?.(application)
    },
  }
}

export type TodoReminderAnchors = {
  assistantTurnsSinceWrite: number
  assistantTurnsSinceReminder: number
  writeAnchorMissing: boolean
  reminderAnchorMissing: boolean
}

function isTodoWriteCall(m: ChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    Array.isArray(m.tool_calls) &&
    m.tool_calls.some((c) => c.name === TODO_WRITE_TOOL_NAME)
  )
}

function isTodoReminder(m: ChatMessage): boolean {
  return (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.trimStart().startsWith(TODO_REMINDER_OPEN_TAG)
  )
}

/**
 * 从当前历史反扫两个锚点，并按 assistant 轮次计距离。
 * 找不到锚点记为 missing —— 那意味着它被 compact 掉了或这是 resume 后的新历史。
 */
export function computeTodoReminderAnchors(
  messages: readonly ChatMessage[],
): TodoReminderAnchors {
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0
  let foundWrite = false
  let foundReminder = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue

    if (!foundWrite && isTodoWriteCall(m)) {
      foundWrite = true
    } else if (!foundReminder && isTodoReminder(m)) {
      foundReminder = true
    }

    if (m.role === 'assistant') {
      // 锚点自身所在的这一轮不计入「距今多少轮」
      if (!foundWrite) assistantTurnsSinceWrite += 1
      if (!foundReminder) assistantTurnsSinceReminder += 1
    }

    if (foundWrite && foundReminder) break
  }

  return {
    assistantTurnsSinceWrite,
    assistantTurnsSinceReminder,
    writeAnchorMissing: !foundWrite,
    reminderAnchorMissing: !foundReminder,
  }
}

/**
 * 若当前应当提醒，返回要 push 进 messages 的提醒消息；否则返回 null。
 * 纯函数：由调用方决定何时（safe boundary）真正入队。
 */
export function buildTodoReminderMessage(
  todos: readonly TodoItem[],
  messages: readonly ChatMessage[],
): ChatMessage | null {
  const anchors = computeTodoReminderAnchors(messages)
  const remind = shouldRemindTodos({
    hasTodos: todos.length > 0,
    assistantTurnsSinceWrite: anchors.assistantTurnsSinceWrite,
    assistantTurnsSinceReminder: anchors.assistantTurnsSinceReminder,
    writeAnchorMissing: anchors.writeAnchorMissing,
    reminderAnchorMissing: anchors.reminderAnchorMissing,
  })
  if (!remind) return null
  return { role: 'user', content: formatTodoReminder(todos) }
}
