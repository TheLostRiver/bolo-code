/**
 * U3：写后 History cell — 对照 HC FileEditToolUpdatedMessage / Codex patch history cell
 * 纯函数；不读盘。CLI/Desktop 共用。
 */

import {
  createDiffSummary,
  formatFileChangeEndLine,
  colorizeUnifiedText,
} from '../../tools/src/ansiDiff.ts'
import { renderHunksRich } from '../../tools/src/diffRender.ts'
import type { DiffHunk } from '../../tools/src/textDiff.ts'

export type FileChangeCellFile = {
  path: string
  op?: string
  added?: number
  removed?: number
}

export type FileChangeCellInput = {
  toolName: string
  ok?: boolean
  path?: string
  paths?: string[]
  added?: number
  removed?: number
  files?: FileChangeCellFile[]
  /** plain unified（可再着色） */
  unified?: string
  /** 已着色 unified；优先于 unified */
  ansiUnified?: string
  /** U4：有 structured hunks 时用富渲染 */
  pathForRender?: string
  hunks?: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
}

export type FormatFileChangeCellOptions = {
  /** false = 折叠（默认）；true = 展开列表 + 短 unified */
  expanded?: boolean
  color?: boolean
  maxUnifiedLines?: number
  maxFiles?: number
}

/**
 * 折叠态：一行摘要 + 可选 dim 提示。
 * 展开态：摘要 + 多文件块 + 截断 unified。
 */
export function formatFileChangeHistoryCell(
  input: FileChangeCellInput,
  opts?: FormatFileChangeCellOptions,
): string {
  const expanded = opts?.expanded === true
  const color = opts?.color !== false
  const ok = input.ok !== false

  const header = formatFileChangeEndLine({
    name: input.toolName,
    path: input.path,
    paths: input.paths,
    added: input.added,
    removed: input.removed,
    ok,
    color,
  })

  const files = input.files?.length
    ? input.files
    : input.path
      ? [
          {
            path: input.path,
            added: input.added,
            removed: input.removed,
          },
        ]
      : input.paths?.map((p) => ({ path: p })) ?? []

  if (!expanded) {
    if (!files.length && !input.unified && !input.ansiUnified) {
      return header
    }
    const n = files.length || (input.paths?.length ?? 0) || 1
    const hint =
      n > 1
        ? `  ▸ ${n} files · /diff to browse`
        : `  ▸ folded · /diff to browse`
    const dim = color ? `\x1b[2m${hint}\x1b[0m` : hint
    return `${header}\n${dim}`
  }

  const lines: string[] = [header]
  if (files.length > 1 || (files.length === 1 && !input.path)) {
    try {
      const block = createDiffSummary(
        files.map((f) => ({
          path: f.path,
          op: f.op ?? 'update',
          added: f.added ?? 0,
          removed: f.removed ?? 0,
        })),
        {
          title: `${input.toolName} files`,
          color,
          maxFiles: opts?.maxFiles ?? 12,
        },
      )
      lines.push(block)
    } catch {
      for (const f of files.slice(0, opts?.maxFiles ?? 12)) {
        lines.push(
          `  ${f.path}  +${f.added ?? 0}/-${f.removed ?? 0}`,
        )
      }
    }
  }

  const maxU = opts?.maxUnifiedLines ?? 16
  if (maxU > 0) {
    if (input.hunks?.length && input.pathForRender) {
      try {
        const rich = renderHunksRich(
          input.pathForRender,
          input.hunks as DiffHunk[],
          { maxLines: maxU },
        )
        if (rich.trim()) lines.push(rich)
      } catch {
        /* fall through */
      }
    } else if (input.ansiUnified?.trim()) {
      const uLines = input.ansiUnified.trim().split(/\r?\n/)
      lines.push(
        ...uLines.slice(0, maxU),
        ...(uLines.length > maxU ? ['…(truncated)'] : []),
      )
    } else if (input.unified?.trim()) {
      const colored = color
        ? colorizeUnifiedText(input.unified, {
            maxLines: maxU,
            filePath: input.pathForRender ?? input.path,
          })
        : input.unified
            .split(/\r?\n/)
            .slice(0, maxU)
            .join('\n')
      lines.push(colored)
    }
  }

  return lines.join('\n')
}

/** 环境：BOLO_DIFF_CELL=full|1|expand → 展开 */
export function shouldExpandFileChangeCell(): boolean {
  const v = (process.env.BOLO_DIFF_CELL ?? '').toLowerCase()
  if (v === '0' || v === 'fold' || v === 'collapsed') return false
  if (v === '1' || v === 'full' || v === 'expand' || v === 'expanded') {
    return true
  }
  // 兼容 VERBOSE
  const verbose = process.env.BOLO_DIFF_VERBOSE
  return verbose === '1' || verbose === 'true' || verbose === 'yes'
}

/**
 * 从 tool meta 抽 cell 输入（toolExecution / 测试）。
 */
export function fileChangeCellFromMeta(opts: {
  toolName: string
  ok?: boolean
  meta?: {
    kind?: string
    path?: string
    paths?: string[]
    added?: number
    removed?: number
    unified?: string
    structuredPatch?: Array<{
      oldStart: number
      oldLines: number
      newStart: number
      newLines: number
      lines: string[]
    }>
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
  ansiUnified?: string
}): FileChangeCellInput | null {
  const m = opts.meta
  if (!m?.kind) return null
  if (
    m.kind !== 'file_edit' &&
    m.kind !== 'file_write' &&
    m.kind !== 'apply_patch'
  ) {
    return null
  }
  const hunks =
    m.structuredPatch ??
    m.files?.find((f) => f.structuredPatch?.length)?.structuredPatch
  const pathForRender =
    m.path ?? m.files?.find((f) => f.structuredPatch?.length)?.path
  return {
    toolName: opts.toolName,
    ok: opts.ok !== false,
    path: m.path,
    paths: m.paths,
    added: m.added,
    removed: m.removed,
    files: m.files?.map((f) => ({
      path: f.path,
      op: f.op,
      added: f.added,
      removed: f.removed,
    })),
    unified: m.unified,
    ansiUnified: opts.ansiUnified,
    ...(pathForRender ? { pathForRender } : {}),
    ...(hunks?.length ? { hunks } : {}),
  }
}