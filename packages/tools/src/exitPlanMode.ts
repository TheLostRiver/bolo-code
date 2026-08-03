/**
 * AR-T3a：plan 模式的出口
 *
 * `/plan` 把会话切进 plan 模式（除 read 外全 deny），但此前**没有出口**：
 * 模型规划完了没法说「计划好了，批准我就执行」，而系统提示却写着
 * "until the user leaves plan mode"。这个工具补上那一半。
 *
 * 安全边界（本工具最重要的部分）：
 * - 它 `requiresPermission: true`，**必须**走用户审批。plan 模式对它网开一面
 *   只是把 deny 放宽成 ask —— 放宽的是「能不能问」，不是「能不能干」。
 * - 批准后退到 `default`（每个危险操作仍逐个审批），而**不是** acceptEdits
 *   或 bypassPermissions。用户批准的是这一份计划，不是随便写的权限。
 */

import { buildTool, type BoloTool } from './types.ts'

export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'

/** 退出 plan 模式后落到的模式：仍然逐个审批 */
export const PLAN_MODE_EXIT_TARGET = 'default'

/** core 挂在 ctx.extras.planModeStore 上的会话权限模式引用（HKP-3 正交化） */
export type PlanModeStoreRef = {
  /** 当前权限模式（plan 激活时保持原值，不覆盖） */
  permissionMode: string
  /** HKP-3：plan 正交开关（true = 规划态，任何权限模式下都强制只读） */
  planMode: boolean
  /** 模式变更后回调（供 core 发事件 / 落盘） */
  onExit?: (next: string) => void | Promise<void>
}

/** 旧路径（permissionMode==='plan'）退出后落到的模式 */
export const PLAN_MODE_LEGACY_EXIT_TARGET = 'default'

export function createExitPlanModeTool(): BoloTool {
  return buildTool({
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description:
      'Leave plan mode and ask the user to approve the plan you just wrote. Call this only after you have investigated enough to lay out concrete steps. Approval switches the session out of planning; individual edits and commands are still approved one by one.',
    // 必须经用户审批——这是从「只读规划」走向「可以动手」的那一步
    requiresPermission: true,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    interruptBehavior: () => 'cancel',
    inputJSONSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            'The plan to carry out, concrete enough for the user to judge: what you will change and in what order',
        },
      },
      required: ['plan'],
    },
    async call(input, ctx) {
      const store = ctx.extras?.planModeStore as PlanModeStoreRef | undefined
      if (!store || typeof store.permissionMode !== 'string') {
        return {
          ok: false,
          isError: true,
          output:
            'ExitPlanMode is unavailable: no permission-mode store is bound to this session.',
          errorCode: 'unavailable',
        }
      }

      const plan = String(input.plan ?? '').trim()
      if (!plan) {
        return {
          ok: false,
          isError: true,
          output:
            'ExitPlanMode requires a non-empty plan — leaving plan mode is not a formality, the user approves what you wrote.',
          errorCode: 'empty',
        }
      }

      // HKP-3：plan 激活 = 正交开关（planMode）或旧路径（permissionMode==='plan'）
      const legacyPath = store.permissionMode === 'plan'
      if (store.planMode !== true && !legacyPath) {
        return {
          ok: false,
          isError: true,
          output: `Not in plan mode (current mode: ${store.permissionMode}); nothing to exit.`,
          errorCode: 'not_in_plan_mode',
        }
      }

      // 退出：关掉正交开关；旧路径才改写 permissionMode（plan → default）
      if (store.planMode === true) {
        store.planMode = false
      }
      const exitTarget = legacyPath ? PLAN_MODE_LEGACY_EXIT_TARGET : undefined
      if (legacyPath) {
        store.permissionMode = PLAN_MODE_LEGACY_EXIT_TARGET
      }
      if (store.onExit) {
        try {
          await store.onExit(exitTarget ?? store.permissionMode)
        } catch {
          /* 通知失败不改变工具语义 */
        }
      }

      return {
        ok: true,
        output: [
          legacyPath
            ? `Plan approved. Left plan mode; permission mode is now "${PLAN_MODE_LEGACY_EXIT_TARGET}".`
            : `Plan approved. Left plan mode; permission mode "${store.permissionMode}" is unchanged (edits and commands still go through its normal approval gate).`,
          'Proceed with the plan you just described.',
        ].join('\n'),
      }
    },
  })
}
