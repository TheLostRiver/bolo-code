/**
 * AR-T1：待办表的 history cell 渲染（core 侧预渲染）
 *
 * 与 fileChangeCell 同一职责边界：**core 出字符串，壳只打印**。
 * CLI 与 Desktop 都不得自己重算待办状态或重排序。
 */

import {
  summarizeTodoList,
  type TodoItem,
} from '../../shared/src/index.ts'

const DIM = '[2m'
const GREEN = '[32m'
const CYAN = '[36m'
const RESET = '[0m'

export type FormatTodoCellOptions = {
  /** 展开时列出全部条目；折叠时只出一行汇总 */
  expanded?: boolean
  color?: boolean
  /** 展开模式下最多列出的条目数 */
  maxItems?: number
}

function statusMark(status: TodoItem['status']): string {
  if (status === 'completed') return '✔'
  if (status === 'in_progress') return '▶'
  return '○'
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text
}

/**
 * 折叠：`Todos 1/3 · Building parser`
 * 展开：汇总行 + 每条 `✔ / ▶ / ○ content`
 */
export function formatTodoCell(
  todos: readonly TodoItem[],
  options?: FormatTodoCellOptions,
): string {
  const color = options?.color !== false
  const summary = summarizeTodoList(todos)

  if (summary.total === 0) {
    return paint('Todos cleared', DIM, color)
  }

  const head = `Todos ${summary.completed}/${summary.total}`
  const headline = summary.activeForm
    ? `${head} · ${summary.activeForm}`
    : summary.allDone
      ? `${head} · all done`
      : head

  if (!options?.expanded) {
    return paint(headline, summary.allDone ? GREEN : CYAN, color)
  }

  const max = options?.maxItems ?? 20
  const lines = [paint(headline, summary.allDone ? GREEN : CYAN, color)]
  for (const t of todos.slice(0, max)) {
    const mark = statusMark(t.status)
    const body = `  ${mark} ${t.content}`
    if (t.status === 'completed') lines.push(paint(body, DIM, color))
    else if (t.status === 'in_progress') lines.push(paint(body, CYAN, color))
    else lines.push(body)
  }
  if (todos.length > max) {
    lines.push(paint(`  … ${todos.length - max} more`, DIM, color))
  }
  return lines.join('\n')
}
