/**
 * T5/U2：权限 ask — TTY 下 y/N/a；有 files preview 时进可滚审批面板
 * 对接 core AskPermissionFn / PermissionRequest。
 */

import * as readline from 'node:readline'
import { buildDiffViewModelFromPreview } from '../../../core/src/diffViewModel.ts'
import { runDiffApprovePane } from './diffPane.ts'

export type AskPermissionDecision = 'allow' | 'deny' | 'allow_always'

export type PermissionPreview = {
  added?: number
  removed?: number
  paths?: string[]
  summaryText?: string
  unifiedPreview?: string
  tool?: string
  files?: Array<{
    path: string
    op?: string
    added?: number
    removed?: number
    structuredPatch?: Array<{
      oldStart: number
      oldLines: number
      newStart: number
      newLines: number
      lines: string[]
    }>
  }>
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
  isTty?: boolean
  readAnswer?: (prompt: string) => Promise<string>
  nonTtyDecision?: AskPermissionDecision
  /**
   * U2：有 files 的 preview 时用可滚面板。
   * 默认 true；`BOLO_PERM_DIFF_PANEL=0` 或 false 关闭。
   */
  useDiffPanel?: boolean
  writeOut?: (s: string) => void
  /** 测试注入 raw key */
  readKey?: () => Promise<string>
  /** 面板前后（REPL 暂停 readline） */
  pauseInput?: () => void
  resumeInput?: () => void
}

/**
 * 创建 askPermission：
 * - TTY + preview.files → 审批 diff 面板（U2）
 * - 否则：文本 summary + [y/a/N]
 * - 非 TTY：deny（或 nonTtyDecision）
 */
export function createTtyAskPermission(
  opts: CreateTtyAskPermissionOptions = {},
): AskPermissionFn {
  const isTty = opts.isTty ?? process.stdin.isTTY === true
  const nonTty = opts.nonTtyDecision ?? 'deny'
  const usePanel =
    opts.useDiffPanel !== false && process.env.BOLO_PERM_DIFF_PANEL !== '0'

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
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s))

  return async (req) => {
    if (!isTty) return nonTty

    // U2：结构化 files → 可滚审批
    if (usePanel && req.preview?.files && req.preview.files.length > 0) {
      try {
        const vm = buildDiffViewModelFromPreview({
          tool: req.preview.tool ?? req.toolName,
          files: req.preview.files,
          added: req.preview.added,
          removed: req.preview.removed,
        })
        if (vm.files.length) {
          opts.pauseInput?.()
          try {
            const pane = await runDiffApprovePane({
              model: vm,
              toolName: req.toolName,
              writeOut,
              isTty: true,
              readKey: opts.readKey,
            })
            if (pane.ok) return pane.decision
          } finally {
            opts.resumeInput?.()
          }
        }
      } catch {
        /* fall through to text prompt */
      }
    }

    const raw = await readAnswer(
      formatPermissionPrompt(req.toolName, req.preview),
    )
    return parsePermissionAnswer(raw)
  }
}