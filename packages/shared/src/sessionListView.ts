/**
 * AR3B · 会话列表视图模型（纯函数）
 *
 * Desktop 侧栏要能「不点进去就扫读一屏并行会话的健康度」
 * （`docs/DESKTOP_DESIGN.md` §2.2）。但现有两个数据源各缺一半：
 *
 * - `listProjectSessions()`：**盘上**的列表，不带任何运行时状态
 * - `buildRuntimeSnapshot()`：**单个**会话的运行时状态，不是列表
 *
 * 合并是视图模型的活，必须落在 packages 而非 renderer——薄壳纪律要求
 * renderer 不持第二状态机、不重算业务状态。CLI 日后要做会话列表也能直接复用。
 *
 * ## 两条不可妥协的语义
 *
 * **① `awaiting_approval` 单独成态。** 并行跑多个会话时，「哪个卡在等我点头」
 * 是用户唯一必须立刻知道的事。把它混进 `running`，人会盯着一个永远不动的
 * 进度条一直等——而真正该做的只是点一下。这也是它必须**置顶**的原因：
 * 沉在列表底部的状态等于不存在。
 *
 * **② 没有快照 ≠ 空闲。** 只知道盘上有这个会话时，状态是 `unknown`。
 * 标成 `idle` 是在替一个我们根本没看见的东西下结论——那属于编造。
 */

import type {
  RuntimeSessionPhase,
  RuntimeSnapshot,
} from './runtimeProtocol.ts'

/** 列表数据源；字段取自 core 的 `SessionListItem` 的必要子集 */
export type SessionListSource = {
  id: string
  updatedAt: string
  messageCount: number
  preview?: string
  title?: string
  cwd?: string
  model?: string
}

export type SessionListStatus =
  /** 盘上有，但没有运行时快照——**不知道**，不是空闲 */
  | 'unknown'
  | 'starting'
  | 'idle'
  | 'running'
  /** 卡在等用户点头。并行时唯一必须立刻可见的状态 */
  | 'awaiting_approval'
  | 'ended'

export type SessionListEntry = {
  sessionId: string
  /** 永不为空：title → preview → id */
  title: string
  updatedAt: string
  messageCount: number
  status: SessionListStatus
  /** 侧栏徽标据此高亮；当前只有等待审批会置 true */
  needsAttention: boolean
  active: boolean
  cwd?: string
  model?: string
}

export type BuildSessionListViewOptions = {
  items: readonly SessionListSource[]
  /** 已知的运行时快照（通常只有当前连着的那几个） */
  snapshots?: readonly RuntimeSnapshot[]
  activeSessionId?: string
}

/**
 * phase → 列表状态。
 *
 * `compacting` / `stopping` 都归 `running`：对用户而言「它正在忙、我不用管」
 * 是同一件事，多分几个态只会让侧栏更吵。而 `awaiting_permission` 相反——
 * 它要求用户动作，必须单独可见。
 */
function statusFromPhase(phase: RuntimeSessionPhase): SessionListStatus {
  switch (phase) {
    case 'awaiting_permission':
      return 'awaiting_approval'
    case 'running':
    case 'compacting':
    case 'stopping':
      return 'running'
    case 'starting':
      return 'starting'
    case 'ended':
      return 'ended'
    case 'idle':
    case 'ready':
      return 'idle'
    default:
      // 未来新增的 phase 不该被硬塞进某个已知态：说不知道比猜错好
      return 'unknown'
  }
}

/** 排序权重：需要用户动作的排最前 */
function attentionRank(e: SessionListEntry): number {
  return e.needsAttention ? 0 : 1
}

export function buildSessionListView(
  opts: BuildSessionListViewOptions,
): SessionListEntry[] {
  const byId = new Map<string, RuntimeSnapshot>()
  for (const s of opts.snapshots ?? []) {
    const id = s?.session?.sessionId
    if (typeof id === 'string' && id) byId.set(id, s)
  }

  const entries: SessionListEntry[] = opts.items.map((it) => {
    const snap = byId.get(it.id)
    // 有列表项才有行：快照对不上任何列表项时**不造行**，
    // 否则会显示一个用户点不开的幽灵会话
    const status: SessionListStatus = snap
      ? statusFromPhase(snap.session.phase)
      : 'unknown'
    const title =
      it.title?.trim() || it.preview?.trim() || `session ${it.id}`
    return {
      sessionId: it.id,
      title,
      updatedAt: it.updatedAt,
      messageCount: it.messageCount,
      status,
      needsAttention: status === 'awaiting_approval',
      active: opts.activeSessionId === it.id,
      ...(it.cwd ? { cwd: it.cwd } : {}),
      ...(it.model ? { model: it.model } : {}),
    }
  })

  // 需要关注的置顶，其余按最近更新；时间相同再按 id 保证稳定
  return entries.sort((a, b) => {
    const byAttention = attentionRank(a) - attentionRank(b)
    if (byAttention !== 0) return byAttention
    if (a.updatedAt !== b.updatedAt) {
      return a.updatedAt < b.updatedAt ? 1 : -1
    }
    return a.sessionId < b.sessionId ? -1 : 1
  })
}
