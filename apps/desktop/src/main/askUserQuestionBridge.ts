/**
 * AR3 · Desktop 侧 AskUserQuestion 桥
 *
 * core 只持有一个提问句柄；CLI 注入终端面板的那一个，Desktop 注入这一个。
 * 桥把「问一句」变成一次 IPC 往返：主进程 push 问题 → renderer 弹对话框 →
 * renderer 回包 → 桥兑现那个 Promise。
 *
 * ## 唯一必须守住的事
 *
 * **没答就是没答，绝不能变成「答了」。**
 *
 * `packages/shared/src/askUserQuestion.ts` 的模块头解释了为什么：会话里一旦
 * 出现一条「用户选择了 X」而用户根本没选过，后续每一轮都把它当既定事实，
 * 而且**永远不会报错**——静默失败里最难查的一种。
 *
 * 三种「没答」各有各的返回，都不是答案：
 *
 * | 情况 | 返回 | 为什么不是别的 |
 * |------|------|---------------|
 * | 没有窗口 | `unavailable` | 没人可问。**且必须立刻返回**——挂着等一个永远不会来的回包，表现是整轮卡死 |
 * | 超时 | `cancelled` | 有人可问，但没答。不是 `unavailable`（窗口在），更不是答案 |
 * | 本轮被取消 | `cancelled` | 问题随轮次作废 |
 *
 * 这与权限那条路**有意不同**：权限非交互时缺省 `deny`，那是一个有意义的
 * 答复（不许）。「问题」没有对应的默认答复，编一个就是替用户表态。
 *
 * ## renderer 的回包按不可信输入对待
 *
 * renderer 是独立进程。但形状校验**不在这里做**——
 * `projectAskUserQuestionAnswers` 已经在工具层守着，且它给的拒绝理由更精确
 * （`unknown_option` / `empty_selection` / `answer_count_mismatch`）。
 * 桥要做的是**不把非答案伪装成答案**去绕过那道关：垃圾回包原样上交，
 * 由投影拒绝；转成 `cancelled` 等于替用户说「我放弃了」，同样是编的。
 *
 * 不 import electron：这样它可以被离线测试驱动
 * （`scripts/test-desktop-ask-user-question.ts`）。
 */
import type {
  AskUserQuestionAskerRef,
  AskUserQuestionOutcome,
} from '../../../../packages/tools/src/index.ts'
import type {
  AskQuestion,
  AskUserQuestionSelection,
} from '../../../../packages/shared/src/index.ts'

export const ASK_USER_QUESTION_PUSH_CHANNEL = 'bolo:ask_user_question'

/** 默认等多久。比权限的 120s 长——读四个选项比答一句 y/n 慢。 */
export const ASK_USER_QUESTION_TIMEOUT_MS = 300_000

export type DesktopAskUserQuestionDeps = {
  /** 推给 renderer；返回 false 表示没有窗口可推 */
  send: (channel: string, payload: unknown) => boolean
  timeoutMs?: number
  /** 计时器可注入，便于测试不真的等五分钟 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** id 生成可注入，测试里要稳定 */
  nextId?: () => string
}

export type DesktopAskUserQuestionBridge = {
  asker: AskUserQuestionAskerRef
  /**
   * renderer 回包入口（由 ipcMain handler 调用）。
   *
   * 返回 false = 这个 id 没有等待者：未知 id、已超时、已取消、或**重放**。
   * 重放必须被丢弃而不是覆盖——已经交出去的答案不能被第二次点击改写。
   */
  resolve: (id: string, response: unknown) => boolean
  /** 窗口关闭 / 会话销毁时把待答问题收口，避免永远挂着 */
  cancelAll: () => void
}

type Pending = {
  settle: (outcome: AskUserQuestionOutcome) => void
}

export function createDesktopAskUserQuestion(
  deps: DesktopAskUserQuestionDeps,
): DesktopAskUserQuestionBridge {
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const timeoutMs = deps.timeoutMs ?? ASK_USER_QUESTION_TIMEOUT_MS

  const pending = new Map<string, Pending>()
  let seq = 0
  const nextId = deps.nextId ?? (() => `q_${++seq}_${Math.random().toString(36).slice(2, 8)}`)

  const asker: AskUserQuestionAskerRef = {
    ask: (questions: AskQuestion[], options?: { signal?: AbortSignal }) =>
      new Promise<AskUserQuestionOutcome>((resolvePromise) => {
        const id = nextId()

        // 先注册再 push：renderer 理论上可以同步回包
        let timer: unknown
        const onAbort = () => finish({ kind: 'cancelled' })
        // 不另设 `done` 标志：`pending.delete` 已经挡掉了重放，
        // 而 Promise 的 resolve 本身就是幂等的。多一个标志会多一条
        // **没有任何测试能把它单独拆红**的分支——这种分支不如不要。
        const finish = (outcome: AskUserQuestionOutcome) => {
          pending.delete(id)
          if (timer !== undefined) clearTimer(timer)
          options?.signal?.removeEventListener('abort', onAbort)
          resolvePromise(outcome)
        }
        pending.set(id, { settle: finish })

        if (options?.signal?.aborted) {
          finish({ kind: 'cancelled' })
          return
        }

        const delivered = deps.send(ASK_USER_QUESTION_PUSH_CHANNEL, { id, questions })
        if (!delivered) {
          // 没有窗口 = 没人可问。立刻收口，不留计时器。
          finish({
            kind: 'unavailable',
            reason: 'no desktop window is open to show the question',
          })
          return
        }

        options?.signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimer(() => finish({ kind: 'cancelled' }), timeoutMs)
      }),
  }

  return {
    asker,
    resolve(id, response) {
      // 删除点只有一个（在 finish 里），才有测试拆得动它。
      // 重放之所以被丢弃，正是因为上一次 settle 已经把它删掉了。
      const p = pending.get(id)
      if (!p) return false
      const r = (response ?? {}) as {
        cancelled?: unknown
        selections?: unknown
      }
      if (r.cancelled === true) {
        p.settle({ kind: 'cancelled' })
        return true
      }
      // 形状不在这里判——见模块头。原样上交，由投影守。
      p.settle({
        kind: 'answered',
        selections: r.selections as AskUserQuestionSelection[],
      })
      return true
    },
    cancelAll() {
      for (const [id, p] of [...pending]) {
        pending.delete(id)
        p.settle({ kind: 'cancelled' })
      }
    },
  }
}
