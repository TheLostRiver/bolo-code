/**
 * AR-T1：会话待办表（Todo）纯契约
 *
 * 借鉴语义（不抄实现）：参考实现把 todo 存在**会话状态**里而不是消息历史里，
 * 因此它天然不被 compact 改写；再按「距上次写入的 assistant 轮数」周期性
 * 把当前表以提醒块的形式重新注入对话。Bolo 沿用同一职责边界：
 *
 *   本文件      纯类型 + 纯函数（校验 / 替换 / 提醒策略 / 文本格式）
 *   tools       TodoWrite 工具（无文件副作用、免审批）
 *   core        session 上的表、落盘、resume、注入时机
 *   cli         渲染
 *
 * 「同时恰好一个 in_progress」在参考实现里是**提示词约束**而非 schema 硬校验，
 * 硬拒绝会让模型陷入重试循环。Bolo 保持同样的软约束：校验通过但带 warning，
 * 由工具把 warning 回给模型自纠。
 */

export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const

export type TodoStatus = (typeof TODO_STATUSES)[number]

export type TodoItem = {
  /** 祈使式描述，如 "Fix auth bug" */
  content: string
  status: TodoStatus
  /** 现在进行式，执行中展示，如 "Fixing auth bug" */
  activeForm: string
}

export type TodoValidationErrorCode =
  | 'not_array'
  | 'not_object'
  | 'empty_content'
  | 'empty_active_form'
  | 'invalid_status'

export type TodoValidationResult =
  | { ok: true; todos: TodoItem[]; warnings: string[] }
  | {
      ok: false
      code: TodoValidationErrorCode
      detail: string
      /** 出错元素下标；结构性错误（not_array）时缺省 */
      index?: number
    }

function isTodoStatus(v: unknown): v is TodoStatus {
  return (
    typeof v === 'string' && (TODO_STATUSES as readonly string[]).includes(v)
  )
}

/**
 * 校验并归一（trim）一张待办表。
 * 结构/字段错误 → 拒绝；in_progress 基数问题 → 通过但带 warning。
 */
export function validateTodoList(input: unknown): TodoValidationResult {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      code: 'not_array',
      detail: `todos must be an array, received ${
        input === null ? 'null' : typeof input
      }`,
    }
  }

  const todos: TodoItem[] = []
  for (let i = 0; i < input.length; i++) {
    const raw: unknown = input[i]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        code: 'not_object',
        detail: `todos[${i}] must be an object`,
        index: i,
      }
    }
    const rec = raw as Record<string, unknown>
    const content =
      typeof rec.content === 'string' ? rec.content.trim() : ''
    if (!content) {
      return {
        ok: false,
        code: 'empty_content',
        detail: `todos[${i}].content must be a non-empty string`,
        index: i,
      }
    }
    const activeForm =
      typeof rec.activeForm === 'string' ? rec.activeForm.trim() : ''
    if (!activeForm) {
      return {
        ok: false,
        code: 'empty_active_form',
        detail: `todos[${i}].activeForm must be a non-empty string (present continuous form of content)`,
        index: i,
      }
    }
    if (!isTodoStatus(rec.status)) {
      return {
        ok: false,
        code: 'invalid_status',
        detail: `todos[${i}].status must be one of ${TODO_STATUSES.join(' | ')}`,
        index: i,
      }
    }
    todos.push({ content, status: rec.status, activeForm })
  }

  return { ok: true, todos, warnings: collectTodoWarnings(todos) }
}

function collectTodoWarnings(todos: readonly TodoItem[]): string[] {
  if (todos.length === 0) return []
  const active = todos.filter((t) => t.status === 'in_progress').length
  if (active > 1) {
    return [
      `${active} tasks are in_progress; keep exactly one in_progress at a time.`,
    ]
  }
  // 全部完成是正常收尾，不该被提醒缺少 in_progress
  const remaining = todos.some((t) => t.status !== 'completed')
  if (active === 0 && remaining) {
    return [
      'No task is in_progress; mark the task you are working on as in_progress.',
    ]
  }
  return []
}

export type TodoSummary = {
  total: number
  pending: number
  inProgress: number
  completed: number
  /** 非空表且全部 completed */
  allDone: boolean
  /** 首个 in_progress 项的 activeForm，供状态行展示 */
  activeForm?: string
}

export function summarizeTodoList(todos: readonly TodoItem[]): TodoSummary {
  let pending = 0
  let inProgress = 0
  let completed = 0
  let activeForm: string | undefined
  for (const t of todos) {
    if (t.status === 'pending') pending += 1
    else if (t.status === 'in_progress') {
      inProgress += 1
      if (activeForm === undefined) activeForm = t.activeForm
    } else completed += 1
  }
  return {
    total: todos.length,
    pending,
    inProgress,
    completed,
    allDone: todos.length > 0 && completed === todos.length,
    ...(activeForm === undefined ? {} : { activeForm }),
  }
}

export type TodoWriteApplication = {
  /** 写入前的表（原引用，供调用方 diff） */
  previous: readonly TodoItem[]
  /** 应写回 session 的表；全部完成时清空，让下一段工作从干净状态开始 */
  stored: TodoItem[]
  /** 本次提交的表；即使全完成也原样返回，供 UI 展示一次收尾态 */
  visible: TodoItem[]
  allDone: boolean
}

/**
 * 整表替换语义（不是增量 patch）。
 * 参考实现在「全部 completed」时把存储清空，避免已完成的旧表继续参与提醒。
 */
export function applyTodoWrite(
  previous: readonly TodoItem[],
  next: readonly TodoItem[],
): TodoWriteApplication {
  const visible = next.map((t) => ({ ...t }))
  const allDone = summarizeTodoList(next).allDone
  return {
    previous,
    stored: allDone ? [] : next.map((t) => ({ ...t })),
    visible,
    allDone,
  }
}

/** 距上次 TodoWrite 至少这么多 assistant 轮才考虑提醒 */
export const TODO_REMINDER_TURNS_SINCE_WRITE = 10
/** 两次提醒之间至少间隔这么多 assistant 轮 */
export const TODO_REMINDER_TURNS_BETWEEN = 10

export type TodoReminderInput = {
  hasTodos: boolean
  assistantTurnsSinceWrite: number
  assistantTurnsSinceReminder: number
  /**
   * 历史里已经找不到上次 TodoWrite 锚点。
   * 两种成因：compact 把它摘要掉了，或这是 resume 后的新历史。
   * 两种情况下模型都「看不见」表，而表本身还在 session 上——必须尽快重注入。
   */
  writeAnchorMissing?: boolean
  /** 历史里已经找不到上次提醒锚点（同上成因） */
  reminderAnchorMissing?: boolean
}

/**
 * 提醒策略：双阈值 + 锚点丢失快速路径。
 *
 * - 常态：既要「久未更新」，也要「上次提醒已隔够久」，否则长任务里会被刷屏。
 * - compact / resume 之后两个锚点同时消失：立刻重注入一次。之后提醒本身
 *   成为新锚点，双阈值重新生效，不会连发。
 * - 空表永不提醒。
 */
export function shouldRemindTodos(input: TodoReminderInput): boolean {
  if (!input.hasTodos) return false
  if (input.writeAnchorMissing && input.reminderAnchorMissing) return true
  return (
    input.assistantTurnsSinceWrite >= TODO_REMINDER_TURNS_SINCE_WRITE &&
    input.assistantTurnsSinceReminder >= TODO_REMINDER_TURNS_BETWEEN
  )
}

export const TODO_REMINDER_OPEN_TAG = '<todo_reminder>'
export const TODO_REMINDER_CLOSE_TAG = '</todo_reminder>'

/**
 * 提醒块文本。包裹标签与 `<background_task_result>` 同构，
 * 便于 CLI/Desktop 用同一套「结构化注入块」识别逻辑。
 */
export function formatTodoReminder(todos: readonly TodoItem[]): string {
  const lines: string[] = [TODO_REMINDER_OPEN_TAG]
  if (todos.length === 0) {
    lines.push('There is currently no todo list for this session.')
  } else {
    lines.push(
      'This is the current todo list. It has not been updated recently — update it if progress has been made.',
    )
    for (const t of todos) {
      lines.push(`- [${t.status}] ${t.content}`)
    }
  }
  lines.push(TODO_REMINDER_CLOSE_TAG)
  return lines.join('\n')
}
