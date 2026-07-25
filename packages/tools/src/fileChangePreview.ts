/**
 * 写前文件改动预览 — 对照 HC FileEditToolDiff / getPatchForDisplay（不写盘）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  applyHunksToText,
  parseApplyPatch,
  resolveSafe,
  type PatchOp,
} from './applyPatch.ts'
import {
  countHunkLines,
  diffHunksFromEdit,
  diffHunksFromFullReplace,
  formatUnifiedDiff,
  type DiffHunk,
} from './textDiff.ts'

export type FileChangePreviewFile = {
  path: string
  op?: 'add' | 'update' | 'delete' | 'move'
  added: number
  removed: number
  structuredPatch?: DiffHunk[]
}

export type FileChangePreview = {
  tool: 'Edit' | 'Write' | 'apply_patch'
  files: FileChangePreviewFile[]
  added: number
  removed: number
  /** 终端/弹窗用，预算截断 */
  summaryText: string
  unifiedPreview?: string
  paths: string[]
}

function opLabel(op?: FileChangePreviewFile['op']): string {
  if (op === 'add') return 'A'
  if (op === 'delete') return 'D'
  if (op === 'move') return 'R'
  return 'M'
}

function buildSummary(
  tool: FileChangePreview['tool'],
  files: FileChangePreviewFile[],
): { summaryText: string; unifiedPreview?: string; added: number; removed: number } {
  const added = files.reduce((s, f) => s + f.added, 0)
  const removed = files.reduce((s, f) => s + f.removed, 0)
  const lines = [
    `${tool} preview: ${files.length} file(s)  +${added}/-${removed}`,
  ]
  for (const f of files.slice(0, 12)) {
    lines.push(`  ${opLabel(f.op)} ${f.path}  +${f.added}/-${f.removed}`)
  }
  if (files.length > 12) lines.push(`  …(+${files.length - 12} more)`)

  const uniParts: string[] = []
  for (const f of files.slice(0, 2)) {
    if (!f.structuredPatch?.length) continue
    const u = formatUnifiedDiff(f.path, f.structuredPatch, {
      maxLines: 40,
      maxChars: 2500,
    })
    if (u) uniParts.push(u)
  }
  const unifiedPreview = uniParts.length ? uniParts.join('\n') : undefined
  if (unifiedPreview) {
    lines.push(unifiedPreview)
  }
  return {
    summaryText: lines.join('\n'),
    ...(unifiedPreview ? { unifiedPreview } : {}),
    added,
    removed,
  }
}

function fileFromTexts(
  filePath: string,
  op: FileChangePreviewFile['op'],
  before: string,
  after: string,
): FileChangePreviewFile {
  const structuredPatch = diffHunksFromFullReplace(before, after)
  const { added, removed } = countHunkLines(structuredPatch)
  return {
    path: filePath,
    op,
    added,
    removed,
    ...(structuredPatch.length ? { structuredPatch } : {}),
  }
}

async function readMaybe(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
}

async function previewEdit(
  input: Record<string, unknown>,
  cwd: string,
): Promise<FileChangePreview | null> {
  const filePath = String(input.path ?? '').trim()
  const oldStr = String(input.old_string ?? '')
  const newStr = String(input.new_string ?? '')
  const replaceAll = input.replace_all === true
  if (!filePath || !oldStr || oldStr === newStr) return null
  const abs = resolveSafe(cwd, filePath)
  const text = await readMaybe(abs)
  if (text == null) {
    return {
      tool: 'Edit',
      files: [{ path: filePath, op: 'update', added: 0, removed: 0 }],
      added: 0,
      removed: 0,
      paths: [filePath],
      summaryText: `Edit preview: file not found: ${filePath}`,
    }
  }
  const hunks = diffHunksFromEdit(text, oldStr, newStr, replaceAll)
  if (!hunks.length) return null
  const { added, removed } = countHunkLines(hunks)
  const files: FileChangePreviewFile[] = [
    {
      path: filePath,
      op: 'update',
      added,
      removed,
      structuredPatch: hunks,
    },
  ]
  const sum = buildSummary('Edit', files)
  return {
    tool: 'Edit',
    files,
    paths: [filePath],
    ...sum,
  }
}

async function previewWrite(
  input: Record<string, unknown>,
  cwd: string,
): Promise<FileChangePreview | null> {
  const filePath = String(input.path ?? '').trim()
  if (!filePath || input.content == null) return null
  const content = String(input.content)
  const abs = resolveSafe(cwd, filePath)
  const before = (await readMaybe(abs)) ?? ''
  const created = before === '' && (await readMaybe(abs)) == null
  // distinguish missing vs empty: try access
  let exists = true
  try {
    await fs.access(abs)
  } catch {
    exists = false
  }
  const file = fileFromTexts(
    filePath,
    exists ? 'update' : 'add',
    exists ? before : '',
    content,
  )
  void created
  const sum = buildSummary('Write', [file])
  return {
    tool: 'Write',
    files: [file],
    paths: [filePath],
    ...sum,
  }
}

async function previewApplyPatch(
  input: Record<string, unknown>,
  cwd: string,
): Promise<FileChangePreview | null> {
  const patch = input.patch != null ? String(input.patch) : ''
  if (patch.trim()) {
    let ops: PatchOp[]
    try {
      ops = parseApplyPatch(patch)
    } catch {
      return null
    }
    const files: FileChangePreviewFile[] = []
    for (const op of ops) {
      try {
        if (op.kind === 'add') {
          const body = op.lines.join('\n') + (op.lines.length ? '\n' : '')
          files.push(fileFromTexts(op.path, 'add', '', body))
          continue
        }
        if (op.kind === 'delete') {
          const abs = resolveSafe(cwd, op.path)
          const before = (await readMaybe(abs)) ?? ''
          files.push(fileFromTexts(op.path, 'delete', before, ''))
          continue
        }
        if (op.kind === 'move') {
          const absFrom = resolveSafe(cwd, op.from)
          const body = (await readMaybe(absFrom)) ?? ''
          files.push(fileFromTexts(op.from, 'move', body, ''))
          files.push(fileFromTexts(op.to, 'move', '', body))
          continue
        }
        // update
        const abs = resolveSafe(cwd, op.path)
        const original = (await readMaybe(abs)) ?? ''
        if (!original && !(await readMaybe(abs))) {
          // try still apply for preview
        }
        const next = applyHunksToText(original, op.hunks, op.path)
        files.push(fileFromTexts(op.path, 'update', original, next))
      } catch {
        // 单 op 失败：只记 path
        const p =
          op.kind === 'move' ? `${op.from} -> ${op.to}` : (op as { path: string }).path
        files.push({ path: p, op: op.kind === 'move' ? 'move' : op.kind, added: 0, removed: 0 })
      }
    }
    if (!files.length) return null
    const sum = buildSummary('apply_patch', files)
    return {
      tool: 'apply_patch',
      files,
      paths: files.map((f) => f.path),
      ...sum,
    }
  }
  // legacy path+content
  if (input.path != null && input.content != null) {
    return previewWrite(
      { path: input.path, content: input.content },
      cwd,
    ).then((p) =>
      p
        ? {
            ...p,
            tool: 'apply_patch',
            summaryText: p.summaryText.replace(/^Write /, 'apply_patch '),
          }
        : null,
    )
  }
  return null
}

/**
 * 按工具名与 input 生成写前预览；失败/无关工具返回 null。
 */
export async function previewFileToolChange(
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<FileChangePreview | null> {
  const name = toolName.trim()
  const obj =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  try {
    if (name === 'Edit') return await previewEdit(obj, cwd)
    if (name === 'Write') return await previewWrite(obj, cwd)
    if (name === 'apply_patch') return await previewApplyPatch(obj, cwd)
  } catch {
    return null
  }
  return null
}

/** 权限事件 / askPermission 用的瘦形态 */
export type PermissionPreviewPayload = {
  added: number
  removed: number
  paths: string[]
  summaryText: string
  unifiedPreview?: string
}

export function toPermissionPreviewPayload(
  p: FileChangePreview | null | undefined,
): PermissionPreviewPayload | undefined {
  if (!p) return undefined
  return {
    added: p.added,
    removed: p.removed,
    paths: p.paths,
    summaryText: p.summaryText,
    ...(p.unifiedPreview ? { unifiedPreview: p.unifiedPreview } : {}),
  }
}