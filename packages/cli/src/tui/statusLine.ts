/**
 * T3 轻量状态行：mode · model · effort · messages
 * 从 session 字段直读，无花活。
 */

export type StatusLineSession = {
  permissionMode?: string
  model?: string
  effortLevel?: string
  messages: { length: number }
}

/** 一行：`mode=… · model=… · effort=… · messages=N` */
export function formatSessionStatusLine(session: StatusLineSession): string {
  const mode = session.permissionMode ?? 'default'
  const model = session.model?.trim() || '(unset)'
  const effort = session.effortLevel?.trim() || 'auto'
  const n = session.messages.length
  return `mode=${mode} · model=${model} · effort=${effort} · messages=${n}`
}