/**
 * transcript 整份重写时，durable 条目的保留不得**静默**失败
 *
 * compact 成功后 `compactSession` 会整份重写 transcript
 * （`rewriteTranscriptFromMessages`，不是追加 boundary）。重写时靠**再读一次旧文件**
 * 把 turn / control / task / resolution / title / notes 抽出来接到新文件尾部。
 *
 * 那次读取被包在 `catch { /* 新文件或不可读 *​/ }` 里 —— 一个 catch 同时盖住了
 * 两种完全不同的处境：
 *
 * - **文件还不存在**：正常，首次写入本该如此，保留列表为空是对的
 * - **文件在但读不出来**：灾难。`loadTranscriptFile` 在 `st.size > 32MiB` 时直接抛，
 *   损坏文件也可能抛。此时保留列表同样为空，于是重写产出一个**不含任何
 *   durable 条目**的新文件，覆盖掉原件。
 *
 * 后果：长会话（大 tool 输出很容易堆到 32MiB）一旦触发 compact，
 * **turn/control/task/resolution 连同 title 一次性永久消失，且不报任何错。**
 * 断点续跑与 recovery 依赖这些条目。
 *
 * 静默的永久数据丢失比报错危险得多——报错至少能诊断。
 * 本测试要求：读不出旧文件时**要么保住条目，要么明确失败**，
 * 但绝不允许「成功地写出一个丢了东西的文件」。
 *
 * 运行：npx tsx scripts/test-transcript-rewrite-preserve.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  appendControlEntry,
  appendTaskEntry,
  appendTurnEntry,
  ensureTranscriptFile,
  loadTranscriptFile,
  rewriteTranscriptFromMessages,
} from '../packages/core/src/sessionTranscript.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const SESSION_ID = 'sess_preserve_test'
const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
]

function fakeSession(): Parameters<typeof rewriteTranscriptFromMessages>[1] {
  return {
    id: SESSION_ID,
    cwd: process.cwd(),
    messages: MESSAGES,
    permissionMode: 'default',
    model: 'test-model',
    systemPromptSections: [],
    autoCompactEnabled: true,
    contextWindowTokens: 128_000,
    maxPtlRetries: 3,
    phase: 'ready',
  } as never
}

async function buildTranscript(file: string): Promise<void> {
  await ensureTranscriptFile(file, { sessionId: SESSION_ID, cwd: process.cwd() })
  await appendTurnEntry(file, {
    sessionId: SESSION_ID,
    turnId: 'turn_1',
    state: 'completed',
  } as never)
  await appendControlEntry(file, {
    sessionId: SESSION_ID,
    controlId: 'ctl_1',
    kind: 'steer',
    state: 'promoted',
  } as never)
  await appendTaskEntry(file, {
    sessionId: SESSION_ID,
    taskId: 'task_1',
    agentType: 'explore',
    state: 'running',
  } as never)
}

async function countDurable(file: string): Promise<Record<string, number>> {
  const raw = await fs.readFile(file, 'utf8')
  const out: Record<string, number> = {}
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as { type?: string }
      if (o.type) out[o.type] = (out[o.type] ?? 0) + 1
    } catch {
      /* padding 行不计 */
    }
  }
  return out
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'rewrite-preserve')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  // ── 1) 基线：正常情况下 durable 条目确实被保留 ──
  // 先证明这个测试**测得出**保留行为，否则第 2 步的断言毫无意义。
  {
    const file = path.join(root, 'ok.jsonl')
    await buildTranscript(file)
    const before = await countDurable(file)
    assert(before.turn === 1 && before.control === 1 && before.task === 1,
      `setup wrote durable entries: ${JSON.stringify(before)}`)

    await rewriteTranscriptFromMessages(file, fakeSession(), {
      compactBoundarySummary: 'summary text',
    })
    const after = await countDurable(file)
    assert(
      after.turn === 1 && after.control === 1 && after.task === 1,
      `a healthy rewrite preserves durable entries: ${JSON.stringify(after)}`,
    )
    assert(after.compact_boundary === 1, `writes the boundary: ${JSON.stringify(after)}`)
  }

  // ── 2) 旧文件读不出来时，绝不允许「成功地写出一个丢了东西的文件」 ──
  // 用超过 32MiB 触发 loadTranscriptFile 的 too-large 抛错 —— 这是长会话
  // 真实会撞上的条件（大 tool 输出堆积），不是人为构造的极端情况。
  {
    const file = path.join(root, 'huge.jsonl')
    await buildTranscript(file)
    const before = await countDurable(file)
    assert(before.turn === 1, 'setup ok')

    // 追加填充把文件推过 32MiB；padding 行不是合法 JSON，但大小检查在解析之前
    const chunk = 'x'.repeat(1024 * 1024)
    const fh = await fs.open(file, 'a')
    try {
      for (let i = 0; i < 33; i++) await fh.write(chunk + '\n')
    } finally {
      await fh.close()
    }
    const size = (await fs.stat(file)).size
    assert(size > 32 * 1024 * 1024, `file is over the 32MiB limit: ${size}`)

    // 先确认前提成立：这个文件确实读不出来
    let loadThrew = false
    try {
      await loadTranscriptFile(file)
    } catch {
      loadThrew = true
    }
    assert(
      loadThrew,
      'precondition: an oversized transcript really does fail to load — otherwise this test proves nothing',
    )

    let rewriteThrew: unknown
    try {
      await rewriteTranscriptFromMessages(file, fakeSession(), {
        compactBoundarySummary: 'summary text',
      })
    } catch (e) {
      rewriteThrew = e
    }

    if (rewriteThrew === undefined) {
      // 声称成功 → 那就必须真的保住了
      const after = await countDurable(file)
      assert(
        after.turn === 1 && after.control === 1 && after.task === 1,
        `rewrite reported success but silently dropped durable entries — this is permanent, unreported data loss: ${JSON.stringify(after)}`,
      )
    } else {
      // 明确失败也可接受：报错能诊断，静默丢失不能。
      // 但失败时不得留下一个已被覆盖的残缺文件。
      const after = await countDurable(file)
      assert(
        after.turn === 1 && after.control === 1 && after.task === 1,
        `a failed rewrite must leave the original file intact: ${JSON.stringify(after)}`,
      )
    }
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: transcript rewrite preserves durable entries')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
