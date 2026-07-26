/**
 * AR-T1：TodoWrite 工具
 *
 * 职责边界（对照参考实现）：
 * - 工具**不**持有状态，只把校验通过的整表写进 ctx.extras.todoStore
 * - 落盘、resume、提醒注入都是 core 的事
 * - 无文件/网络副作用 → 免权限；但非并发安全（整表替换，顺序有意义）
 *
 * 回给模型的是**固定引导文案 + 校验警告**，不是 JSON 回显：
 * 表本身会由 core 周期性重新注入，工具结果里再回显一遍纯属浪费 token。
 */

import {
  applyTodoWrite,
  validateTodoList,
  type TodoItem,
  type TodoWriteApplication,
} from '../../shared/src/index.ts'
import { buildTool, type BoloTool } from './types.ts'

/** core 挂在 ctx.extras.todoStore 上的会话级待办表 */
export type TodoStoreRef = {
  todos: TodoItem[]
  /** 写入后回调：core 用来落盘 / 发 UI 事件。抛错不得影响工具结果。 */
  onWrite?: (application: TodoWriteApplication) => void | Promise<void>
}

export const TODO_WRITE_TOOL_NAME = 'TodoWrite'

const TODO_WRITE_ACK =
  'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.'

export function createTodoWriteTool(): BoloTool {
  return buildTool({
    name: TODO_WRITE_TOOL_NAME,
    description:
      'Create and maintain a structured task list for the current session. Use it proactively for multi-step work: mark exactly one task in_progress before starting it, and mark it completed immediately after finishing. Always provide both content (imperative, e.g. "Fix the auth bug") and activeForm (present continuous, e.g. "Fixing the auth bug"). Submitting the full list replaces the previous one.',
    requiresPermission: false,
    // 整表替换：与其它 todo 写入并发会互相覆盖
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    // 瞬时且无副作用，用户 interrupt 时可直接取消
    interruptBehavior: () => 'cancel',
    inputJSONSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete updated todo list (replaces the previous list)',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Imperative description of the task',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current state of the task',
              },
              activeForm: {
                type: 'string',
                description:
                  'Present continuous form shown while the task runs',
              },
            },
            required: ['content', 'status', 'activeForm'],
          },
        },
      },
      required: ['todos'],
    },
    async call(input, ctx) {
      const store = ctx.extras?.todoStore as TodoStoreRef | undefined
      if (!store || !Array.isArray(store.todos)) {
        return {
          ok: false,
          isError: true,
          output:
            'TodoWrite is unavailable: no todo store is bound to this session.',
          errorCode: 'unavailable',
        }
      }

      const validation = validateTodoList(input.todos)
      if (!validation.ok) {
        return {
          ok: false,
          isError: true,
          output: `InputValidationError: ${validation.detail}`,
          errorCode: validation.code,
        }
      }

      const application = applyTodoWrite(store.todos, validation.todos)
      store.todos = application.stored

      if (store.onWrite) {
        try {
          await store.onWrite(application)
        } catch {
          /* 持久化/UI 失败不得改变工具语义 */
        }
      }

      const notes = validation.warnings.length
        ? `\n\nNOTE: ${validation.warnings.join(' ')}`
        : ''
      return { ok: true, output: TODO_WRITE_ACK + notes }
    },
  })
}
