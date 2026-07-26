/**
 * AR3B · 会话列表视图模型（纯函数，packages-first）
 *
 * Desktop 的会话侧栏需要「不点进去就能扫读一屏并行会话的健康度」
 * （见 `docs/DESKTOP_DESIGN.md` §2.2）。但现有两个数据源各缺一半：
 *
 * - `listProjectSessions()` 给的是**盘上**的列表（id/updatedAt/preview/title…），
 *   完全不带运行时状态
 * - `buildRuntimeSnapshot()` 给的是**单个**会话的运行时状态，不是列表
 *
 * 合并这两者是**视图模型**的活，必须落在 packages 里而不是 renderer——
 * 薄壳纪律：renderer 不持第二状态机、不重算业务状态。
 *
 * 本文件守住的核心语义是 **`awaiting_approval` 必须能被单独识别**。
 * 并行跑多个会话时，「哪个卡在等我点头」是用户唯一必须立刻知道的事；
 * 把它混进 `running` 会让人盯着一个永远不动的进度条等下去。
 *
 * 另一条同等重要：**没有运行时快照 ≠ 空闲**。只知道盘上有这个会话时，
 * 状态是「未知」，不能假装它是 idle——那是在替一个我们没看见的东西下结论。
 *
 * 运行：npx tsx scripts/test-session-list-view.ts
 */
import {
  buildSessionListView,
  type SessionListSource,
} from '../packages/shared/src/sessionListView.ts'
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeSessionPhase,
  type RuntimeSnapshot,
} from '../packages/shared/src/runtimeProtocol.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function item(over: Partial<SessionListSource> = {}): SessionListSource {
  return {
    id: 'sess_a',
    updatedAt: '2026-07-27T10:00:00.000Z',
    messageCount: 12,
    preview: 'fix the compact bug',
    ...over,
  }
}

function snap(
  sessionId: string,
  phase: RuntimeSessionPhase,
  over?: Partial<RuntimeSnapshot['session']>,
): RuntimeSnapshot {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.snapshot',
    generatedAt: '2026-07-27T10:05:00.000Z',
    features: [],
    session: {
      sessionId,
      cwd: '/w',
      phase,
      runner: phase === 'running' ? { state: 'running', active: { sessionId, turnId: 't1', acquiredAt: 'x' } } : { state: 'idle' },
      turns: [],
      controls: [],
      tasks: [],
      ...over,
    },
  } as RuntimeSnapshot
}

function main() {
  // ── 1) 没有运行时快照 → unknown，**不是** idle ──
  // 只知道盘上有这个会话时，假装它空闲是在替一个我们没看见的东西下结论。
  {
    const [e] = buildSessionListView({ items: [item()] })
    assert(e, 'produces an entry')
    assert(
      e!.status === 'unknown',
      `a session with no runtime snapshot is unknown, not idle: ${e!.status}`,
    )
  }

  // ── 2) awaiting_permission 必须单独成态 ──
  // 并行时「哪个卡在等我」是用户唯一必须立刻知道的事；
  // 混进 running 会让人盯着一个永远不动的进度条等下去。
  {
    const [e] = buildSessionListView({
      items: [item()],
      snapshots: [snap('sess_a', 'awaiting_permission')],
    })
    assert(
      e!.status === 'awaiting_approval',
      `awaiting_permission surfaces as its own status, got ${e!.status}`,
    )
    assert(
      e!.needsAttention === true,
      'and is flagged as needing attention — that is what the sidebar badge keys on',
    )
  }

  // ── 3) 其余 phase 的映射 ──
  {
    const cases: Array<[RuntimeSessionPhase, string, boolean]> = [
      ['running', 'running', false],
      ['compacting', 'running', false],
      ['ready', 'idle', false],
      ['idle', 'idle', false],
      ['starting', 'starting', false],
      ['stopping', 'running', false],
      ['ended', 'ended', false],
    ]
    for (const [phase, expected, attention] of cases) {
      const [e] = buildSessionListView({
        items: [item()],
        snapshots: [snap('sess_a', phase)],
      })
      assert(
        e!.status === expected,
        `phase ${phase} maps to ${expected}, got ${e!.status}`,
      )
      assert(
        e!.needsAttention === attention,
        `phase ${phase} attention=${attention}, got ${e!.needsAttention}`,
      )
    }
  }

  // ── 4) 标题回退链：title → preview → id，绝不显示空白行 ──
  {
    const withTitle = buildSessionListView({
      items: [item({ title: 'My work', preview: 'p' })],
    })[0]!
    assert(withTitle.title === 'My work', 'title wins')

    const withPreview = buildSessionListView({ items: [item({ preview: 'p' })] })[0]!
    assert(withPreview.title === 'p', 'falls back to preview')

    const bare = buildSessionListView({
      items: [item({ preview: '', title: undefined })],
    })[0]!
    assert(
      bare.title.length > 0,
      'a session with neither title nor preview still gets something to click on',
    )
    assert(bare.title.includes('sess_a'), `falls back to the id: ${bare.title}`)
  }

  // ── 5) 排序：最近更新在前，且**需要关注的置顶** ──
  // 等审批的会话沉在列表底部等于没有这个状态。
  {
    const entries = buildSessionListView({
      items: [
        item({ id: 'old', updatedAt: '2026-07-01T00:00:00.000Z' }),
        item({ id: 'newest', updatedAt: '2026-07-27T23:00:00.000Z' }),
        item({ id: 'waiting', updatedAt: '2026-07-02T00:00:00.000Z' }),
      ],
      snapshots: [snap('waiting', 'awaiting_permission')],
    })
    assert(
      entries[0]!.sessionId === 'waiting',
      `the session waiting on the user comes first regardless of age, got ${entries.map((e) => e.sessionId).join(',')}`,
    )
    assert(
      entries[1]!.sessionId === 'newest',
      `then most-recently-updated: ${entries.map((e) => e.sessionId).join(',')}`,
    )
  }

  // ── 6) active 会话被标出来 ──
  {
    const entries = buildSessionListView({
      items: [item({ id: 'a' }), item({ id: 'b' })],
      activeSessionId: 'b',
    })
    assert(
      entries.find((e) => e.sessionId === 'b')!.active === true,
      'the active session is marked',
    )
    assert(
      entries.find((e) => e.sessionId === 'a')!.active === false,
      'others are not',
    )
  }

  // ── 7) 快照对不上任何列表项时不得凭空造一行 ──
  // 那会显示一个用户点不开的幽灵会话。
  {
    const entries = buildSessionListView({
      items: [item({ id: 'a' })],
      snapshots: [snap('ghost', 'running')],
    })
    assert(entries.length === 1, `no phantom row is invented: ${entries.length}`)
    assert(entries[0]!.sessionId === 'a', 'and the real one survives')
  }

  // ── 8) 纯函数：不改入参 ──
  {
    const items = [item({ id: 'x' })]
    const snapshots = [snap('x', 'running')]
    const before = JSON.stringify({ items, snapshots })
    buildSessionListView({ items, snapshots })
    assert(
      JSON.stringify({ items, snapshots }) === before,
      'the view model never mutates its inputs',
    )
  }

  // ── 9) 空输入不炸 ──
  {
    assert(buildSessionListView({ items: [] }).length === 0, 'empty list is empty')
    assert(
      buildSessionListView({ items: [], snapshots: [] }).length === 0,
      'empty with snapshots is still empty',
    )
  }

  console.log('PASS: session list view')
}

main()
