/**
 * ROB-3：后台任务 manifest 持久化与恢复投影。
 *
 * 语义：
 * - manifest 是与 transcript 同目录的 `<id>.background-shells.json`，在会话
 *   保存点（maybeAutoSaveSession 成功后）落盘，仅含可恢复的纯数据。
 * - 进程未走 endSession 就退出（崩溃 / 强制结束）时 manifest 保留；resume
 *   时把 running 记录投影为 `interrupted`（无法跨进程证明进程死活，不宣称
 *   killed/completed），CLI `/bg` 展示 leftover 提醒与输出路径。
 * - 正常 endSession（收尸 + 清理输出后）删除 manifest：没有遗留可提醒。
 * - 不自动重启任务；manifest 损坏时 fail-closed 跳过（视为无遗留）。
 */
import { promises as fs } from 'node:fs'
import {
  createBackgroundShellStore,
  listBackgroundShells,
  markShellInterrupted,
  parseBackgroundShellManifest,
  registerBackgroundShell,
  serializeBackgroundShellManifest,
  type BackgroundShellStore,
} from '../../shared/src/index.ts'
import { getTranscriptWriteState } from './sessionTranscript.ts'
import { getSessionPersistMeta } from './sessionPersist.ts'
import type { BoloSession } from './index.ts'

export function resolveBackgroundShellManifestPath(
  transcriptPath: string,
): string {
  return transcriptPath.replace(/\.(json|jsonl)$/iu, '') + '.background-shells.json'
}

function resolveSessionTranscriptPath(
  session: BoloSession,
): string | undefined {
  try {
    const writeState = getTranscriptWriteState(session)
    if (writeState?.filePath?.trim()) return writeState.filePath.trim()
  } catch {
    /* ignore */
  }
  try {
    const meta = getSessionPersistMeta(session)
    if (meta?.filePath?.trim()) return meta.filePath.trim()
  } catch {
    /* ignore */
  }
  return undefined
}

/** 会话保存点落盘；无持久化路径或 store 为空时跳过。写失败静默（辅助文件）。 */
export async function persistBackgroundShellManifest(
  session: BoloSession,
): Promise<void> {
  const store = session.backgroundShells
  if (!store || listBackgroundShells(store).length === 0) return
  const transcriptPath = resolveSessionTranscriptPath(session)
  if (!transcriptPath) return
  try {
    await fs.writeFile(
      resolveBackgroundShellManifestPath(transcriptPath),
      serializeBackgroundShellManifest(store),
      'utf8',
    )
  } catch {
    /* 辅助文件：失败不阻断会话保存 */
  }
}

/** 正常结束会话后清除 manifest（进程已收尸、输出已清理，无遗留可提醒）。 */
export async function removeBackgroundShellManifest(
  session: BoloSession,
): Promise<void> {
  const transcriptPath = resolveSessionTranscriptPath(session)
  if (!transcriptPath) return
  try {
    await fs.unlink(resolveBackgroundShellManifestPath(transcriptPath))
  } catch {
    /* 清理失败不阻断会话结束（ENOENT 视为已清理） */
  }
}

/**
 * resume 投影：读 manifest → running 标记为 interrupted（终态记录原样）→
 * 写入 session.backgroundShells。文件缺失或损坏时跳过（fail-closed）。
 */
export async function restoreBackgroundShellManifest(
  session: BoloSession,
  transcriptPath: string,
): Promise<void> {
  const manifestPath = resolveBackgroundShellManifestPath(transcriptPath)
  let text: string
  try {
    text = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return
  }
  const store = parseBackgroundShellManifest(text)
  if (!store) return
  const endedAt = new Date().toISOString()
  const projected: BackgroundShellStore = createBackgroundShellStore()
  for (const record of listBackgroundShells(store)) {
    registerBackgroundShell(
      projected,
      record.status === 'running'
        ? markShellInterrupted(record, { endedAt })
        : record,
    )
  }
  session.backgroundShells = projected
}
