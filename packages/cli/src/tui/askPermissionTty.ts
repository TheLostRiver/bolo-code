/**
 * T5：权限 ask — TTY 下 readline y/N/a；非 TTY 默认 deny
 * 对接 core AskPermissionFn / PermissionRequest 流程。
 * a = allow always for this tool name this session
 * D3：可选 preview.summaryText（写前 diff）
 */

import * as readline from 'node:readline'

export type AskPermissionDecision = 'allow' | 'deny' | 'allow_always'

export type PermissionPreview = {
  added?: number
  removed?: number
  paths?: string[]
  summaryText?: string
  unifiedPreview?: string
}

export type AskPermissionRequest = {
  toolName: string
  toolInput: unknown
  toolUseId: string
  preview?: PermissionPreview
}

export type AskPermissionFn = (
  req: AskPermissionRequest,
) => Promise<AskPermissionDecision>

/**
 * 解析用户回答：y/yes → allow；a/always → allow_always；空或其它 → deny
 */
export function parsePermissionAnswer(raw: string): AskPermissionDecision {
  const a = raw.trim().toLowerCase()
  if (a === 'y' || a === 'yes') return 'allow'
  if (a === 'a' || a === 'always') return 'allow_always'
  return 'deny'
}

export function formatPermissionPrompt(
  toolName: string,
  preview?: PermissionPreview,
): string {
  const head = `Allow ${toolName}? [y/a/N] `
  const body = preview?.summaryText?.trim()
  if (!body) return head
  // 预览在问题前展示；着色 +/− 行（若已是 plain unified）
  const colored = colorizePreviewBody(body)
  return `${colored}\n${head}`
}

function colorizePreviewBody(body: string): string {
  const RESET = '\x1b[0m'
  const GREEN = '\x1b[32m'
  const RED = '\x1b[31m'
  const CYAN = '\x1b[36m'
  const DIM = '\x1b[2m'
  return body
    .split('\n')
    .map((L) => {
      if (L.startsWith('+') && !L.startsWith('+++')) return `${GREEN}${L}${RESET}`
      if (L.startsWith('-') && !L.startsWith('---')) return `${RED}${L}${RESET}`
      if (L.startsWith('@@')) return `${CYAN}${L}${RESET}`
      if (L.startsWith('  A ') || L.startsWith('  M ') || L.startsWith('  D ')) {
        return `${DIM}${L}${RESET}`
      }
      return L
    })
    .join('\n')
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
 * - TTY：`Allow <tool>? [y/a/N]`，默认 N；a = 本会话 always-allow 该工具
 * - 可附带 preview.summaryText
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
    const raw = await readAnswer(
      formatPermissionPrompt(req.toolName, req.preview),
    )
    return parsePermissionAnswer(raw)
  }
}