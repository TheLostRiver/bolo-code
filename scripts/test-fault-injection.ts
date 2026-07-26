/**
 * AR5B · 故障注入：不伪造成功 · 不丢原文件 · 不自动 replay · 错误可行动
 *
 * ROADMAP 对 AR5B 的四条验收原文即上述。本文件成体系地注入本项目**真实会遇到**
 * 的故障，而不是能想到的全部故障——注入一个现实中不会发生的场景，
 * 只会产生一条没人维护的测试。
 *
 * 本轮此前已单独覆盖的两种，此处不重复：
 * - compact 写盘失败 → `test-compact-write-failure.ts`
 * - 读不出来不得覆盖 → `test-transcript-rewrite-preserve.ts` / `test-session-migration.ts`
 *
 * 这里补齐剩下的：
 *
 * **① 部分写。** 断电或进程被杀会留下截断的 jsonl。最后一行是半截 JSON——
 *    它必须被**跳过**而不是让整个会话读不出来；一行坏掉不该毁掉整段历史。
 *
 * **② 并发。** 两个进程同时写同一份 transcript。写入走 tmp+rename，
 *    结果必须是其中一个的完整内容，**不能是两者交织的碎片**。
 *
 * **③ 错误信息可行动。** 报错必须带上**是哪个文件**。只说「写入失败」
 *    而不说哪个文件，等于把排查成本全丢给用户。
 *
 * 运行：npx tsx scripts/test-fault-injection.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ensureTranscriptFile,
  loadTranscriptMessages,
  recordSessionMessages,
  rewriteTranscriptFromMessages,
} from '../packages/core/src/sessionTranscript.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const SESSION_ID = 'sess_fault'

function fakeSession(messages: ChatMessage[]) {
  return {
    id: SESSION_ID,
    cwd: process.cwd(),
    messages,
    permissionMode: 'default',
    model: 'test-model',
    systemPromptSections: [],
    autoCompactEnabled: true,
    contextWindowTokens: 128_000,
    maxPtlRetries: 3,
    phase: 'ready',
  } as never
}

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
]

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'fault-injection')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  // ── ① 部分写：截断的最后一行不得毁掉整段历史 ──
  {
    const file = path.join(root, 'partial.jsonl')
    await ensureTranscriptFile(file, { sessionId: SESSION_ID, cwd: process.cwd() })
    await recordSessionMessages(file, MESSAGES, { sessionId: SESSION_ID })

    // 模拟断电：在最后追加半截 JSON（没有换行、没有闭合括号）
    await fs.appendFile(file, '{"type":"message","sessionId":"sess_fau', 'utf8')

    // 裁判自检：文件里必须**真的**有一行解析不了，否则「被跳过」这条断言
    // 就没有对象——它会因为根本没有坏行而通过。
    {
      const raw = await fs.readFile(file, 'utf8')
      const bad = raw
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .filter((l) => {
          try {
            JSON.parse(l)
            return false
          } catch {
            return true
          }
        })
      assert(
        bad.length === 1,
        `setup really did leave exactly one unparseable line, got ${bad.length}`,
      )
    }

    const r = await loadTranscriptMessages(file)
    assert(
      r.messages.length === MESSAGES.length,
      `a truncated final line is skipped, not fatal — got ${r.messages.length} of ${MESSAGES.length} messages`,
    )
    assert(
      r.messages[0]!.content === 'first question',
      'and the surviving messages are intact, in order',
    )
  }

  // ── ② 单行损坏同理：坏在中间也只丢那一行 ──
  {
    const file = path.join(root, 'midline.jsonl')
    await ensureTranscriptFile(file, { sessionId: SESSION_ID, cwd: process.cwd() })
    await recordSessionMessages(file, MESSAGES.slice(0, 1), { sessionId: SESSION_ID })
    await fs.appendFile(file, 'GARBAGE NOT JSON\n', 'utf8')
    await recordSessionMessages(file, MESSAGES.slice(1), { sessionId: SESSION_ID })

    const r = await loadTranscriptMessages(file)
    assert(
      r.messages.length === MESSAGES.length,
      `a corrupt line in the middle costs only that line — got ${r.messages.length}`,
    )
  }

  // ── ③ 并发重写：结果必须是完整的一份，不能是交织的碎片 ──
  // 写入走 tmp+rename，所以「后写的赢」是可接受的；**半份内容不可接受**。
  {
    const file = path.join(root, 'concurrent.jsonl')
    await ensureTranscriptFile(file, { sessionId: SESSION_ID, cwd: process.cwd() })

    const a: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: 'user',
      content: `A-${i}`.repeat(50),
    }))
    const b: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: 'user',
      content: `B-${i}`.repeat(50),
    }))

    await Promise.all([
      rewriteTranscriptFromMessages(file, fakeSession(a)),
      rewriteTranscriptFromMessages(file, fakeSession(b)),
      rewriteTranscriptFromMessages(file, fakeSession(a)),
    ])

    const raw = await fs.readFile(file, 'utf8')
    const lines = raw.split(/\r?\n/).filter((l) => l.trim())
    let parsed = 0
    for (const l of lines) {
      try {
        JSON.parse(l)
        parsed++
      } catch {
        /* counted below */
      }
    }
    assert(
      parsed === lines.length,
      `every line is valid JSON after concurrent rewrites — ${lines.length - parsed} of ${lines.length} were torn`,
    )

    const r = await loadTranscriptMessages(file)
    assert(
      r.messages.length === 40,
      `the file holds exactly one writer's full history, not a mix — got ${r.messages.length}`,
    )
    const prefixes = new Set(r.messages.map((m) => m.content.slice(0, 1)))
    assert(
      prefixes.size === 1,
      `the surviving history comes from a single writer, not interleaved: saw ${[...prefixes].join(',')}`,
    )
  }

  // ── ④ 目标不可写：明确失败，且**说清是哪个文件** ──
  // 只说「写入失败」而不说哪个文件，等于把排查成本全丢给用户。
  {
    const blocked = path.join(root, 'blocked.jsonl')
    await fs.mkdir(blocked, { recursive: true }) // 用目录占住路径

    let threw: unknown
    try {
      await rewriteTranscriptFromMessages(blocked, fakeSession(MESSAGES))
    } catch (e) {
      threw = e
    }
    assert(threw !== undefined, 'an unwritable target fails loudly instead of reporting success')
    const msg = threw instanceof Error ? threw.message : String(threw)
    assert(
      msg.includes('blocked.jsonl'),
      `the error names the file it could not write: ${msg}`,
    )
  }

  // ── ⑤ 失败不得留下临时文件残渣 ──
  // tmp+rename 的代价是失败时可能留下 .tmp；攒多了会让用户以为磁盘出了问题。
  {
    const dir = path.join(root, 'residue')
    await fs.mkdir(dir, { recursive: true })
    const blocked = path.join(dir, 'x.jsonl')
    await fs.mkdir(blocked, { recursive: true })

    let failed = false
    try {
      await rewriteTranscriptFromMessages(blocked, fakeSession(MESSAGES))
    } catch {
      failed = true
    }
    // 裁判自检：写入必须**真的失败过**，否则「没有残渣」只是因为压根没写。
    assert(failed, 'setup: the blocked write really did fail')
    const leftovers = (await fs.readdir(dir)).filter((n) => n.includes('.tmp'))
    assert(
      leftovers.length === 0,
      `a failed write leaves no .tmp residue behind: ${leftovers.join(', ')}`,
    )
  }

  // ── ⑥ 空文件不是「损坏」，也不该是「有历史」──
  {
    const file = path.join(root, 'empty.jsonl')
    await fs.writeFile(file, '', 'utf8')
    const r = await loadTranscriptMessages(file)
    assert(
      r.messages.length === 0,
      'an empty transcript reads as zero messages rather than throwing',
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: fault injection')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
