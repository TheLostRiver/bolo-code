/**
 * Auto 分类审计文案（Y3.6）
 * 对照 HC tengu_auto_mode_decision：本地 system_note，无遥测。
 * 不进模型链；仅人类/list 可读。
 */

import { truncateForClassifier } from './autoClassifier.ts'

export const AUTO_CLASSIFY_NOTE_KIND = 'auto_classify' as const

export type AutoClassifyAuditInput = {
  toolName: string
  toolUseId?: string
  /** 最终对外决策 */
  decision: 'allow' | 'deny'
  reason: string
  /** fast | deep | single | circuit | no_classifier | demote */
  stage?: string
  unavailable?: boolean
  demoted?: boolean
  /** 可选：极短 input 预览（已截断） */
  inputPreview?: string
}

/** 单行审计正文（appendSessionSystemNote 会再压空白） */
export function formatAutoClassifyAuditNote(
  input: AutoClassifyAuditInput,
): string {
  const tool = (input.toolName || '?').trim() || '?'
  const reason = truncateForClassifier(
    (input.reason || 'n/a').replace(/\s+/g, ' ').trim() || 'n/a',
    200,
  )
  const parts: string[] = [
    `auto classify: ${input.decision} ${tool}`,
  ]
  if (input.toolUseId?.trim()) {
    parts.push(`id=${input.toolUseId.trim()}`)
  }
  if (input.inputPreview?.trim()) {
    parts.push(`input=${truncateForClassifier(input.inputPreview.trim(), 80)}`)
  }
  parts.push(`— ${reason}`)
  const tags: string[] = []
  if (input.stage) tags.push(`stage=${input.stage}`)
  if (input.unavailable) tags.push('unavailable')
  if (input.demoted) tags.push('demoted')
  if (tags.length) parts.push(`[${tags.join(' ')}]`)
  return parts.join(' ')
}

/** Bash/写路径等：从 toolInput 抽极短预览 */
export function previewToolInputForAudit(toolInput: unknown): string | undefined {
  if (toolInput == null) return undefined
  if (typeof toolInput === 'string') {
    return truncateForClassifier(toolInput, 80)
  }
  if (typeof toolInput !== 'object') {
    return truncateForClassifier(String(toolInput), 80)
  }
  const o = toolInput as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'filePath', 'prompt']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) {
      return truncateForClassifier(v.trim(), 80)
    }
  }
  try {
    return truncateForClassifier(JSON.stringify(toolInput), 80)
  } catch {
    return undefined
  }
}