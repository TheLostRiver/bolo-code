/**
 * AR3B 接线 · 从盘上的 transcript 装配出会话列表与 turn timeline
 *
 * 视图模型（`buildSessionListView` / `buildTurnTimeline`）是纯函数，住在
 * `packages/shared`；本文件负责把 transcript 读成它们要的入参。
 * 主进程与 CLI 都调这里，不各自实现一遍读取与投影——否则两个前端必然漂移。
 *
 * ## 装配层特有的两个失败模式
 *
 * **① 读不出来 ≠ 没有历史。** 文件损坏、超 32MiB 上限、EACCES 时若返回空数组，
 * 界面会显示「这个会话是空的」，用户会以为记录丢了——而实际只是没读成。
 * 故返回值把三种情况分开：`not_found`（正常，还没这个文件）、
 * `unreadable`（异常，有文件但读不出）、`ok` 且零 turn（真的空）。
 *
 * 这与 `rewriteTranscriptFromMessages` 里那次修复同源：那边是「读不出来时
 * 别覆盖」，这边是「读不出来时别显示成空」。同一个 catch 盖住两种处境的毛病，
 * 在读路径上同样会出。
 *
 * **② diff 与消息必须来自同一次读取。** 分两次读会拿到不一致的快照——
 * 中间可能刚好发生 compact 重写，导致 diff 挂到错误的 turn 上。
 */

import {
  buildSessionListView,
  buildTurnTimeline,
  type SessionListEntry,
  type TimelineFileDiff,
  type TimelineTurn,
} from '../../shared/src/index.ts'
import type { RuntimeSnapshot } from '../../shared/src/runtimeProtocol.ts'
import {
  fileDiffsFromTranscriptEntries,
  loadTranscriptFile,
  messagesFromTranscriptEntries,
} from './sessionTranscript.ts'
import { listProjectSessions } from './sessionPersist.ts'

export type LoadTimelineResult =
  | { ok: true; turns: TimelineTurn[]; usedCompactBoundary: boolean }
  | {
      ok: false
      /** not_found = 还没有这个文件（正常）；unreadable = 有文件但读不出（异常） */
      code: 'not_found' | 'unreadable'
      detail: string
    }

export async function loadSessionTimeline(
  file: string,
): Promise<LoadTimelineResult> {
  let entries
  try {
    // 一次读取同时供消息与 diff 使用：分两次读可能跨过一次 compact 重写，
    // 拿到不一致的快照，diff 会挂到错误的 turn 上
    ;({ entries } = await loadTranscriptFile(file))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    const detail = e instanceof Error ? e.message : String(e)
    if (code === 'ENOENT') {
      return { ok: false, code: 'not_found', detail }
    }
    // 读不出来必须与「空会话」分开：返回空数组会让用户以为记录丢了
    return { ok: false, code: 'unreadable', detail }
  }

  const { messages, usedCompactBoundary } = messagesFromTranscriptEntries(entries)
  const fileDiffs: TimelineFileDiff[] = fileDiffsFromTranscriptEntries(
    entries,
  ).map((d) => ({
    path: d.path,
    tool: d.tool,
    added: d.added,
    removed: d.removed,
    ...(d.turn != null ? { turn: d.turn } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.op ? { op: d.op } : {}),
  }))

  return {
    ok: true,
    turns: buildTurnTimeline({ messages, fileDiffs }),
    usedCompactBoundary,
  }
}

export type LoadSessionListOptions = {
  cwd: string
  sessionsDir?: string
  limit?: number
  /** 已知的运行时快照；缺席的会话状态为 unknown 而非 idle */
  snapshots?: readonly RuntimeSnapshot[]
  activeSessionId?: string
}

export async function loadSessionListEntries(
  opts: LoadSessionListOptions,
): Promise<SessionListEntry[]> {
  // 「项目里还没有任何会话」是正常状态，listProjectSessions 已按此返回空表；
  // 不该把它表现成故障
  const items = await listProjectSessions({
    cwd: opts.cwd,
    ...(opts.sessionsDir ? { sessionsDir: opts.sessionsDir } : {}),
    ...(opts.limit != null ? { limit: opts.limit } : {}),
  })

  return buildSessionListView({
    items: items.map((it) => ({
      id: it.id,
      updatedAt: it.updatedAt,
      messageCount: it.messageCount,
      ...(it.preview ? { preview: it.preview } : {}),
      ...(it.title ? { title: it.title } : {}),
      ...(it.cwd ? { cwd: it.cwd } : {}),
      ...(it.model ? { model: it.model } : {}),
    })),
    ...(opts.snapshots ? { snapshots: opts.snapshots } : {}),
    ...(opts.activeSessionId ? { activeSessionId: opts.activeSessionId } : {}),
  })
}
