/**
 * T5/U2：权限 ask — TTY 下 y/N/a；有 files preview 时进可滚审批面板
 * 对接 core AskPermissionFn / PermissionRequest。
 */

import * as readline from 'node:readline'
import {
  buildDiffViewModelFromPreview,
  type DiffViewModel,
} from '../../../core/src/diffViewModel.ts'
import type {
  DiffPaneApproveResult,
  DiffPaneBrowseResult,
} from './diffPane.ts'
import { formatPermissionRequestDetails } from './permissionPanel.ts'

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
  /** 执行工具时的真实工作目录；旧调用可不传。 */
  cwd?: string
  preview?: PermissionPreview
  /** core 合并后的 turn/runner signal；优先于创建 helper 时的 signal。 */
  signal?: AbortSignal
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

export function formatPermissionRequestPrompt(
  request: AskPermissionRequest,
): string {
  return `${formatPermissionRequestDetails(request)}\nAllow ${request.toolName}? [y/a/N] `
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
  /** 当前 turn 的取消信号；abort 时权限请求按 deny 收口 */
  signal?: AbortSignal
  /** retained overlay 收到 Ctrl-C 时通知 turn owner */
  onInterrupt?: () => void
  /** retained root 内的唯一 OverlayHost；提供时不暂停或转交 stdin。 */
  runPermissionOverlay?: (options: {
    request: AskPermissionRequest
    signal?: AbortSignal
    onInterrupt?: () => void
  }) => Promise<AskPermissionDecision>
  runDiffOverlay?: (options: {
    mode: 'approve'
    model: DiffViewModel
    toolName: string
    signal?: AbortSignal
    onInterrupt?: () => void
  }) => Promise<DiffPaneApproveResult | DiffPaneBrowseResult>
}

function resolveOnAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  fallback: T,
): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) return Promise.resolve(fallback)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (value: T) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(fallback)
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(finish, (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
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

  const defaultRead = async (
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })
    try {
      return await new Promise<string>((resolve) => {
        let settled = false
        const finish = (answer: string) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve(answer)
        }
        const onAbort = () => finish('')
        signal?.addEventListener('abort', onAbort, { once: true })
        rl.question(prompt, finish)
      })
    } finally {
      rl.close()
    }
  }

  return async (req) => {
    const signal = req.signal ?? opts.signal
    if (!isTty) return nonTty
    if (signal?.aborted) return 'deny'

    // U2：结构化 files → 可滚审批
    if (
      usePanel &&
      opts.runDiffOverlay &&
      req.preview?.files &&
      req.preview.files.length > 0
    ) {
      try {
        const vm = buildDiffViewModelFromPreview({
          tool: req.preview.tool ?? req.toolName,
          files: req.preview.files,
          added: req.preview.added,
          removed: req.preview.removed,
        })
        if (vm.files.length) {
          const pane = await opts.runDiffOverlay({
            mode: 'approve',
            model: vm,
            toolName: req.toolName,
            ...(signal ? { signal } : {}),
            ...(opts.onInterrupt
              ? { onInterrupt: opts.onInterrupt }
              : {}),
          })
          if (pane.ok && 'decision' in pane) return pane.decision
        }
      } catch {
        /* fall through to text prompt */
      }
    }

    if (opts.runPermissionOverlay && !opts.readAnswer) {
      return await opts.runPermissionOverlay({
        request: req,
        ...(signal ? { signal } : {}),
        ...(opts.onInterrupt ? { onInterrupt: opts.onInterrupt } : {}),
      })
    }

    const prompt = formatPermissionRequestPrompt(req)
    const raw = opts.readAnswer
      ? await resolveOnAbort(opts.readAnswer(prompt), signal, '')
      : await defaultRead(prompt, signal)
    return parsePermissionAnswer(raw)
  }
}
