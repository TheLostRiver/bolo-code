/**
 * 会话内 hook 运行诊断（H5）— 纯 ring buffer，无遥测
 */

import type { HookEvent } from '../../shared/src/index.ts'

export type HookDiagEntry = {
  at: string
  event: string
  exitCode: number
  blocked?: boolean
  timedOut?: boolean
  aborted?: boolean
  /** stderr / blockReason 截断 */
  detail?: string
  /** PreToolUse 是否改写了 input */
  updatedInput?: boolean
}

export const DEFAULT_HOOK_DIAG_LIMIT = 24

export type HookDiagLog = {
  entries: HookDiagEntry[]
  limit: number
}

export function createHookDiagLog(
  limit = DEFAULT_HOOK_DIAG_LIMIT,
): HookDiagLog {
  return { entries: [], limit: Math.max(1, Math.floor(limit)) }
}

export function appendHookDiag(
  log: HookDiagLog | undefined,
  entry: HookDiagEntry,
): HookDiagLog {
  const next = log ?? createHookDiagLog()
  next.entries.push(entry)
  while (next.entries.length > next.limit) next.entries.shift()
  return next
}

export function formatHookDiagRecent(
  log: HookDiagLog | undefined,
  opts?: { max?: number; onlyProblems?: boolean },
): string {
  const max = opts?.max ?? 12
  const onlyProblems = opts?.onlyProblems === true
  const all = log?.entries ?? []
  let rows = onlyProblems
    ? all.filter(
        (e) =>
          e.exitCode !== 0 ||
          e.blocked ||
          e.timedOut ||
          e.aborted ||
          (e.detail && e.detail.length > 0 && e.exitCode !== 0),
      )
    : all
  if (!rows.length) {
    return onlyProblems
      ? 'hooks recent: (no failures/timeouts in ring)'
      : 'hooks recent: (empty — run tools or prompts with hooks configured)'
  }
  rows = rows.slice(-max)
  const lines = [
    `hooks recent (last ${rows.length}${onlyProblems ? ', problems' : ''}):`,
  ]
  for (const e of rows) {
    const flags: string[] = []
    if (e.blocked) flags.push('blocked')
    if (e.timedOut) flags.push('timeout')
    if (e.aborted) flags.push('aborted')
    if (e.updatedInput) flags.push('updatedInput')
    const flag = flags.length ? ` [${flags.join(',')}]` : ''
    const det = e.detail ? ` — ${e.detail}` : ''
    lines.push(`  ${e.at}  ${e.event}  exit=${e.exitCode}${flag}${det}`)
  }
  return lines.join('\n')
}

/** 从单次 AggregatedHookResult 抽诊断行 */
export function diagEntriesFromHookRun(opts: {
  event: HookEvent | string
  results: Array<{
    exitCode: number
    stderr?: string
    blocked?: boolean
    timedOut?: boolean
    aborted?: boolean
    updatedInput?: unknown
  }>
  blockReason?: string
  at?: string
}): HookDiagEntry[] {
  const at = opts.at ?? new Date().toISOString()
  const out: HookDiagEntry[] = []
  for (const r of opts.results) {
    const detailRaw =
      (r.blocked && opts.blockReason) ||
      (r.stderr || '').replace(/\nhook (timeout|aborted)\s*$/i, '').trim()
    const detail = detailRaw
      ? String(detailRaw).replace(/\s+/g, ' ').slice(0, 160)
      : undefined
    // 只记「有信息量」的：非 0、blocked、timeout、abort、或改写了 input
    const interesting =
      r.exitCode !== 0 ||
      r.blocked ||
      r.timedOut ||
      r.aborted ||
      r.updatedInput !== undefined
    if (!interesting) continue
    out.push({
      at,
      event: opts.event,
      exitCode: r.exitCode,
      ...(r.blocked ? { blocked: true } : {}),
      ...(r.timedOut ? { timedOut: true } : {}),
      ...(r.aborted ? { aborted: true } : {}),
      ...(detail ? { detail } : {}),
      ...(r.updatedInput !== undefined ? { updatedInput: true } : {}),
    })
  }
  return out
}