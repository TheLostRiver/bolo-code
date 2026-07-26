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
 * raw-mode 面板必须与 REPL 的 readline 互斥，所以走和权限面板同一套
 * `pauseInput` / `resumeInput` 协议，否则两边抢 stdin。
 */

import readline from 'node:readline'
import type {
  AskUserQuestionAskerRef,
  AskUserQuestionOutcome,
} from '../../../tools/src/index.ts'
import { runQuestionPicker } from './questionPicker.ts'

export type CreateTtyAskUserQuestionOptions = {
  isTty?: boolean
  writeOut?: (s: string) => void
  /** raw-key 读取（测试注入） */
  readKey?: () => Promise<string>
  /** 自由文本读取（测试注入）；缺省用 readline */
  readLine?: (prompt: string) => Promise<string>
  /** 进 raw 面板前暂停 REPL 的 readline */
  pauseInput?: () => void
  resumeInput?: () => void
  signal?: AbortSignal
}

export function createTtyAskUserQuestion(
  opts: CreateTtyAskUserQuestionOptions = {},
): AskUserQuestionAskerRef {
  const isTty = opts.isTty ?? process.stdin.isTTY === true
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s))

  const defaultReadLine = async (prompt: string): Promise<string> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })
    try {
      return await new Promise<string>((resolve) => {
        rl.question(prompt, resolve)
      })
    } finally {
      rl.close()
    }
  }

  return {
    async ask(questions, callOpts): Promise<AskUserQuestionOutcome> {
      const signal = callOpts?.signal ?? opts.signal
      if (!isTty && !opts.readKey) {
        return { kind: 'unavailable', reason: 'no interactive terminal' }
      }
      if (signal?.aborted) return { kind: 'cancelled' }

      // 与权限面板同一协议：raw 面板期间必须让出 stdin
      opts.pauseInput?.()
      try {
        const r = await runQuestionPicker({
          questions,
          isTty: true,
          writeOut,
          ...(opts.readKey ? { readKey: opts.readKey } : {}),
          readLine: opts.readLine ?? defaultReadLine,
          ...(signal ? { signal } : {}),
        })
        return r
      } finally {
        opts.resumeInput?.()
      }
    },
  }
}
