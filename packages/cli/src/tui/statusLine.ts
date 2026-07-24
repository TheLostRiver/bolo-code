/**
 * T3 轻量状态行：mode · model · effort · messages
 * P-T9-NARROW：窄终端缩短字段。
 */

import {
  getTerminalColumns,
  isNarrowTerminal,
  NARROW_TERMINAL_COLUMNS,
} from './banner.ts'

export type StatusLineSession = {
  permissionMode?: string
  model?: string
  effortLevel?: string
  messages: { length: number }
}

export type StatusLineOptions = {
  columns?: number
  env?: NodeJS.ProcessEnv
  /** 强制短行 */
  compact?: boolean
}

function clip(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, Math.max(1, max - 1)) + '…'
}

/** 一行：`mode=… · model=… · effort=… · messages=N`（窄终端更短） */
export function formatSessionStatusLine(
  session: StatusLineSession,
  opts?: StatusLineOptions,
): string {
  const mode = session.permissionMode ?? 'default'
  const model = session.model?.trim() || '(unset)'
  const effort = session.effortLevel?.trim() || 'auto'
  const n = session.messages.length
  const narrow =
    opts?.compact === true ||
    isNarrowTerminal({
      columns: opts?.columns ?? getTerminalColumns({ env: opts?.env }),
      env: opts?.env,
      threshold: NARROW_TERMINAL_COLUMNS,
    })
  if (narrow) {
    return `m=${clip(mode, 10)} · ${clip(model, 18)} · e=${clip(effort, 6)} · n=${n}`
  }
  return `mode=${mode} · model=${model} · effort=${effort} · messages=${n}`
}