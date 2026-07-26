/**
 * AR3B 接线 · 从 transcript 装配出会话列表与 turn timeline
 *
 * 视图模型（`buildSessionListView` / `buildTurnTimeline`）是纯函数，
 * 但纯函数不接线就是死代码。这一层负责把**盘上的 transcript**
 * 读成它们要的入参，主进程/CLI 只调它，不各自实现一遍读取与投影。
 *
 * 装配层特有的、纯函数测不到的失败模式，正是本文件要守的：
 *
 * **① 读不出来 ≠ 没有历史。** 文件损坏、超上限、EACCES 时若返回空数组，
 *    界面会显示「这个会话是空的」——用户会以为记录丢了，而实际上只是没读成。
 *    必须能区分，且**不存在的文件**（正常）与**读不出来**（异常）也要分开。
 *
 * **② diff 与消息必须来自同一次读取。** 分两次读会拿到不一致的快照
 *    （中间可能刚好发生了 compact 重写），导致 diff 挂到错误的 turn 上。
 *
 * 运行：npx tsx scripts/test-session-views.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  loadSessionTimeline,
  loadSessionListEntries,
} from '../packages/core/src/sessionViews.ts'
import {
  appendFileDiffEntry,
  ensureTranscriptFile,
  recordSessionMessages,
} from '../packages/core/src/sessionTranscript.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const SESSION_ID = 'sess_views'

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'fix the bug' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', name: 'Edit', arguments: '{}' }],
  },
  { role: 'tool', content: 'edited', tool_call_id: 'c1' },
  { role: 'assistant', content: 'done' },
]

async function build(file: string): Promise<void> {
  await ensureTranscriptFile(file, {
    sessionId: SESSION_ID,
    cwd: process.cwd(),
  })
  await recordSessionMessages(file, MESSAGES, { sessionId: SESSION_ID })
  await appendFileDiffEntry(file, {
    sessionId: SESSION_ID,
    path: 'src/a.ts',
    tool: 'Edit',
    kind: 'file_edit',
    added: 3,
    removed: 1,
    turn: 0,
  } as never)
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'session-views')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  // ── 1) 正常读取：消息、工具、diff 都到位 ──
  {
    const file = path.join(root, 'ok.jsonl')
    await build(file)
    const r = await loadSessionTimeline(file)
    assert(r.ok, `loads: ${JSON.stringify(r)}`)
    assert(r.ok && r.turns.length === 1, `one turn, got ${r.ok && r.turns.length}`)
    const items = r.ok ? r.turns[0]!.items : []
    const kinds = items.map((i) => i.kind)
    assert(kinds.includes('user'), `has the user message: ${kinds.join(',')}`)
    assert(kinds.includes('tool'), `has the tool call: ${kinds.join(',')}`)
    assert(kinds.includes('diff'), `has the file diff: ${kinds.join(',')}`)
    const tool = items.find((i) => i.kind === 'tool') as { complete: boolean }
    assert(tool.complete === true, 'the tool call is paired with its result')
  }

  // ── 2) 文件不存在 → 明确的 not_found，**不是**空历史 ──
  {
    const r = await loadSessionTimeline(path.join(root, 'nope.jsonl'))
    assert(!r.ok, 'a missing transcript is not silently an empty session')
    assert(
      !r.ok && r.code === 'not_found',
      `and says it is missing, not broken: ${JSON.stringify(r)}`,
    )
  }

  // ── 3) 读不出来 → unreadable，与「不存在」和「空」都区分开 ──
  // 返回空数组会让界面显示「这个会话是空的」，用户会以为记录丢了。
  {
    const file = path.join(root, 'huge.jsonl')
    await build(file)
    const chunk = 'x'.repeat(1024 * 1024)
    const fh = await fs.open(file, 'a')
    try {
      for (let i = 0; i < 33; i++) await fh.write(chunk + '\n')
    } finally {
      await fh.close()
    }
    const r = await loadSessionTimeline(file)
    assert(!r.ok, 'an oversized transcript does not read as an empty session')
    assert(
      !r.ok && r.code === 'unreadable',
      `distinguishes unreadable from missing: ${JSON.stringify(r)}`,
    )
    assert(
      !r.ok && r.detail.length > 0,
      'and explains why, so the user can act on it',
    )
  }

  // ── 4) 空 transcript（只有 meta）→ 是**真的空**，ok 且零 turn ──
  // 这一条与 ③ 成对：真空必须能表达，否则上面那条就变成了「永远报错」。
  {
    const file = path.join(root, 'empty.jsonl')
    await ensureTranscriptFile(file, {
      sessionId: SESSION_ID,
      cwd: process.cwd(),
    })
    const r = await loadSessionTimeline(file)
    assert(r.ok, `a genuinely empty transcript loads fine: ${JSON.stringify(r)}`)
    assert(r.ok && r.turns.length === 0, 'with zero turns')
  }

  // ── 5) 会话列表：运行时快照缺席时状态是 unknown，不是 idle ──
  {
    const sessionsDir = path.join(root, 'sessions')
    await fs.mkdir(sessionsDir, { recursive: true })
    await build(path.join(sessionsDir, `${SESSION_ID}.jsonl`))
    const entries = await loadSessionListEntries({
      cwd: root,
      sessionsDir,
    })
    assert(entries.length >= 1, `lists the session, got ${entries.length}`)
    const e = entries.find((x) => x.sessionId === SESSION_ID)
    assert(e, `finds it by id: ${entries.map((x) => x.sessionId).join(',')}`)
    assert(
      e!.status === 'unknown',
      `no runtime snapshot means unknown, not idle: ${e!.status}`,
    )
    assert(e!.title.length > 0, 'always has something to click on')
  }

  // ── 6) 会话目录不存在 → 空列表而非抛错 ──
  // 「还没有任何会话」是正常状态，不该表现成故障。
  {
    const entries = await loadSessionListEntries({
      cwd: root,
      sessionsDir: path.join(root, 'no-such-dir'),
    })
    assert(
      Array.isArray(entries) && entries.length === 0,
      'a project with no sessions yet is an empty list, not an error',
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: session views')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
