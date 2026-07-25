/**
 * T3 轻量状态行：mode · model · effort · messages · provider
 * P-T9-NARROW：窄终端缩短字段。
 * CX4：可选 providerId / kind。
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
  /** CX4：命名 provider id */
  providerId?: string
  /** 协议 kind（LlmProvider.id） */
  providerKind?: string
  /** 兼容 live session.provider.id */
  provider?: { id?: string }
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
  const pid = session.providerId?.trim()
  const kind =
    session.providerKind?.trim() || session.provider?.id?.trim() || ''
  const prov =
    pid && kind
      ? `${pid}/${kind}`
      : pid || kind || ''
  const narrow =
    opts?.compact === true ||
    isNarrowTerminal({
      columns: opts?.columns ?? getTerminalColumns({ env: opts?.env }),
      env: opts?.env,
      threshold: NARROW_TERMINAL_COLUMNS,
    })
  if (narrow) {
    const p = prov ? ` · ${clip(prov, 14)}` : ''
    return `m=${clip(mode, 10)} · ${clip(model, 16)} · e=${clip(effort, 6)}${p} · n=${n}`
  }
  const p = prov ? ` · provider=${prov}` : ''
  return `mode=${mode} · model=${model} · effort=${effort}${p} · messages=${n}`
}