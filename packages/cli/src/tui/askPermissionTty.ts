/**
 * T5：权限 ask — TTY 下 readline y/N；非 TTY 默认 deny
 * 对接 core AskPermissionFn / PermissionRequest 流程。
 */

import * as readline from 'node:readline'

export type AskPermissionDecision = 'allow' | 'deny'

export type AskPermissionRequest = {
  toolName: string
  toolInput: unknown
  toolUseId: string
}

export type AskPermissionFn = (
  req: AskPermissionRequest,
) => Promise<AskPermissionDecision>

/**
 * 解析用户回答：y/yes → allow；空或其它 → deny
 */
export function parsePermissionAnswer(raw: string): AskPermissionDecision {
  const a = raw.trim().toLowerCase()
  if (a === 'y' || a === 'yes') return 'allow'
  return 'deny'
}

export function formatPermissionPrompt(toolName: string): string {
  return `Allow ${toolName}? [y/N] `
}

export type CreateTtyAskPermissionOptions = {
  /** 默认 process.stdin.isTTY */
  isTty?: boolean
  /**
   * 注入问答（测试 / 与 REPL 共用同一 readline）。
   * 未注入且 TTY 时临时 createInterface。
   */
  readAnswer?: (prompt: string) => Promise<string>
  /** 非 TTY 策略：默认 deny */
  nonTtyDecision?: AskPermissionDecision
}

/**
 * 创建 askPermission：
 * - TTY：`Allow <tool>? [y/N]`，默认 N
 * - 非 TTY：deny（或 nonTtyDecision），不挂起
 */
export function createTtyAskPermission(
  opts: CreateTtyAskPermissionOptions = {},
): AskPermissionFn {
  const isTty = opts.isTty ?? process.stdin.isTTY === true
  const nonTty = opts.nonTtyDecision ?? 'deny'

  const defaultRead = async (prompt: string): Promise<string> => {
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

  const readAnswer = opts.readAnswer ?? defaultRead

  return async (req) => {
    if (!isTty) return nonTty
    const raw = await readAnswer(formatPermissionPrompt(req.toolName))
    return parsePermissionAnswer(raw)
  }
}