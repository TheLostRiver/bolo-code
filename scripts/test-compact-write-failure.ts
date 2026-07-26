/**
 * compact 的 transcript 写盘失败必须**完整回退**，不得报告成功
 *
 * `compactSession` 里两种失败的待遇原本不对称：
 *
 * - **摘要生成失败** → 恢复 snapshot、`return { ok: false }`（正确）
 * - **transcript 写盘失败** → 只 `emit error`，内存保持已压缩，
 *   然后 **`return { ok: true }`**
 *
 * 后者的后果是内存与磁盘分叉：内存是压缩后的短链，磁盘还是压缩前的长历史
 * 且没有 boundary。resume 会加载那份旧历史 —— **这次压缩等于没发生**，
 * 而且上下文压力原样存在，于是立刻再次触发 auto compact，转圈。
 * 全程调用方拿到的是 `ok: true`。
 *
 * 触发条件不是臆想：磁盘满、EACCES，以及 transcript 超过 32MiB 上限
 * （`loadTranscriptForPreservation` 现在会对此明确抛错，正好落进那个 catch）。
 *
 * ROADMAP §13.10.2 的 AR2A2 验收原文就要求「写失败完整回退」。
 *
 * 本测试要求：写盘失败时 —— 报告失败、内存回到压缩前、磁盘不留半截。
 *
 * 运行：npx tsx scripts/test-compact-write-failure.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSession, compactSession, saveSession } from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type { LlmProvider, ProviderStreamEvent } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function textOnlyProvider(): LlmProvider {
  return {
    id: 'mock-text',
    async *completeStream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'summary'
    },
  }
}

const SUMMARY = {
  text: '<summary>\n1. Primary Request and Intent:\n   Write failure test.\n</summary>',
}

async function makeSession(sessionsDir: string, id: string, cwd: string) {
  const s = await createSession({
    cwd,
    sessionId: id,
    systemPrompt: false,
    autoSave: { sessionsDir, scope: 'project' },
    provider: textOnlyProvider(),
    compactSummarizer: async () => SUMMARY,
  })
  for (let i = 0; i < 6; i++) {
    s.messages.push({ role: 'user', content: `question ${i}` })
    s.messages.push({ role: 'assistant', content: `answer ${i}` })
  }
  return s
}

function clone(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((m) => ({ ...m }))
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-compact-writefail-'))
  const sessionsDir = path.join(root, 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })

  // ── 1) 基线：正常路径下 compact 成功且磁盘落了 boundary ──
  // 先证明这套装配确实能跑通，否则第 2 步的失败断言毫无意义。
  {
    const s = await makeSession(sessionsDir, 'sess_ok', root)
    await saveSession(s, { sessionsDir })
    const before = s.messages.length
    const r = await compactSession(s, 'manual')
    assert(r.ok === true, `baseline compact succeeds: ${JSON.stringify(r)}`)
    assert(s.messages.length < before, 'baseline actually compacted the message list')
    const raw = await fs.readFile(path.join(sessionsDir, 'sess_ok.jsonl'), 'utf8')
    assert(
      raw.includes('compact_boundary'),
      'baseline wrote the boundary to disk',
    )
  }

  // ── 2) 写盘失败：不得报告成功 ──
  // 把 jsonl 路径占成一个目录，rename 必然失败 —— 等价于磁盘满 / EACCES /
  // 超 32MiB 这几类真实故障，但确定性触发。
  {
    const s = await makeSession(sessionsDir, 'sess_fail', root)
    await saveSession(s, { sessionsDir })
    const jsonlPath = path.join(sessionsDir, 'sess_fail.jsonl')
    await fs.rm(jsonlPath, { force: true })
    await fs.mkdir(jsonlPath, { recursive: true })

    const before = clone(s.messages)
    const r = await compactSession(s, 'manual')

    assert(
      r.ok === false,
      `compact must not report success when the transcript could not be written — the caller would believe it persisted: ${JSON.stringify(r)}`,
    )
    assert(
      typeof (r as { reason?: string }).reason === 'string' &&
        (r as { reason: string }).reason.length > 0,
      `the failure says why: ${JSON.stringify(r)}`,
    )

    // 完整回退：内存回到压缩前，否则内存与磁盘分叉，
    // resume 会加载旧历史、压缩白做、并立刻再次触发 auto compact
    assert(
      s.messages.length === before.length,
      `memory rolls back to the pre-compact list (was ${before.length}, now ${s.messages.length}) — leaving it compacted while disk is not diverges the session`,
    )
    assert(
      JSON.stringify(s.messages) === JSON.stringify(before),
      'the rolled-back list is byte-identical to the snapshot',
    )
  }

  // ── 3) 回退之后会话仍可用：修好磁盘再压一次应当成功 ──
  // 回退不能把会话弄成一个再也压不动的状态。
  {
    const s = await makeSession(sessionsDir, 'sess_retry', root)
    await saveSession(s, { sessionsDir })
    const jsonlPath = path.join(sessionsDir, 'sess_retry.jsonl')
    await fs.rm(jsonlPath, { recursive: true, force: true })
    await fs.mkdir(jsonlPath, { recursive: true })

    const first = await compactSession(s, 'manual')
    assert(first.ok === false, 'first attempt fails as set up')

    // 移除障碍后重试
    await fs.rm(jsonlPath, { recursive: true, force: true })
    await saveSession(s, { sessionsDir })
    const second = await compactSession(s, 'manual')
    assert(
      second.ok === true,
      `after the obstacle is removed compact works again — a rollback must not wedge the session: ${JSON.stringify(second)}`,
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: compact write failure rolls back')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
