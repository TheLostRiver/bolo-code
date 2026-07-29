/**
 * AR-T3+ · AskUserQuestion 的 CLI 实现。
 *
 * 形状对齐 `createTtyAskPermission`：CLI 造好句柄注入 session，
 * core 只持有它，工具执行时 await。差别只有一处但很关键——
 *
 * **非 TTY 时返回 `unavailable`，而不是某个默认答案。**
 *
 * 权限的非 TTY 缺省是 `deny`，那是一个有意义的答复（不许）。
 * 「问题」没有对应的默认答复：编一个就等于替用户表态，而且这条
 * 假答案会作为既定事实留在会话里，往后每一轮都被当真，还永远不报错。
 *
 * retained TTY 使用 OverlayHost；plain TTY 复用调用方的 readline。
 */

import readline from 'node:readline'
import type { AskQuestion } from '../../../shared/src/index.ts'
import type {
  AskUserQuestionAskerRef,
  AskUserQuestionOutcome,
} from '../../../tools/src/index.ts'
import { runTextQuestionPicker } from './questionPicker.ts'

export type CreateTtyAskUserQuestionOptions = {
  isTty?: boolean
  writeOut?: (s: string) => void
  /** 自由文本读取（测试注入）；缺省用 readline */
  readLine?: (prompt: string) => Promise<string | null>
  /** retained root 内的唯一 OverlayHost；提供时不暂停或转交 stdin。 */
  runQuestionOverlay?: (options: {
    questions: readonly AskQuestion[]
    signal?: AbortSignal
  }) => Promise<AskUserQuestionOutcome>
  signal?: AbortSignal
}

export function createTtyAskUserQuestion(
  opts: CreateTtyAskUserQuestionOptions = {},
): AskUserQuestionAskerRef {
  const isTty = opts.isTty ?? process.stdin.isTTY === true
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s))

  const defaultReadLine = async (
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })
    try {
      return await new Promise<string | null>((resolve) => {
        let settled = false
        const finish = (answer: string | null) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve(answer)
        }
        const onAbort = () => finish(null)
        if (signal?.aborted) {
          finish(null)
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        rl.question(prompt, (answer) => finish(answer))
      })
    } finally {
      rl.close()
    }
  }

  return {
    async ask(questions, callOpts): Promise<AskUserQuestionOutcome> {
      const signal = callOpts?.signal ?? opts.signal
      if (!isTty) {
        return { kind: 'unavailable', reason: 'no interactive terminal' }
      }
      if (signal?.aborted) return { kind: 'cancelled' }

      if (opts.runQuestionOverlay) {
        return await opts.runQuestionOverlay({
          questions,
          ...(signal ? { signal } : {}),
        })
      }

      return await runTextQuestionPicker({
        questions,
        writeOut,
        readLine:
          opts.readLine ??
          ((prompt) => defaultReadLine(prompt, signal)),
        ...(signal ? { signal } : {}),
      })
    },
  }
}
