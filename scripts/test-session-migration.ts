/**
 * AR5A · 迁移必须幂等，且失败不得覆盖源
 *
 * ROADMAP 对 AR5A 的验收原文：**「旧数据可读或无损导出；迁移幂等，失败不覆盖源」**。
 *
 * `migrateSessionToJsonl` 有一处保护：目标 jsonl 已有消息时默认跳过重写
 * （除非 `force`）。但那个判断建立在
 *
 * ```ts
 * try { existingMessages = (await loadTranscriptMessages(p)).messages.length }
 * catch { existingMessages = 0 }
 * ```
 *
 * 之上——**一个 catch 同时盖住「文件不存在」（正常，该迁移）与「文件在但读不出来」
 * （危险，绝不能覆盖）**。后者被当成「里面没有消息」，于是保护失效，
 * 一个读不出来的 transcript 会被直接覆盖掉。
 *
 * 这与 `rewriteTranscriptFromMessages` 那次修复（`3e918ea`）是**同一个 bug 模式**
 * 在另一条路径上的复现：读不出来就**不知道**里面有什么，此时覆盖等于销毁。
 * 触发条件同样现实：transcript 超过 32MiB 上限即抛。
 *
 * 运行：npx tsx scripts/test-session-migration.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  migrateSessionToJsonl,
  SESSION_SNAPSHOT_VERSION,
} from '../packages/core/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const SESSION_ID = 'sess_migrate'

function snapshotJson(messageCount = 3): string {
  return JSON.stringify(
    {
      version: SESSION_SNAPSHOT_VERSION,
      id: SESSION_ID,
      cwd: process.cwd(),
      permissionMode: 'default',
      model: 'test-model',
      systemPromptSections: [],
      autoCompactEnabled: true,
      contextWindowTokens: 128_000,
      maxPtlRetries: 3,
      phase: 'ready',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      messages: Array.from({ length: messageCount }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
      })),
    },
    null,
    2,
  )
}

async function countTranscriptMessages(file: string): Promise<number> {
  const raw = await fs.readFile(file, 'utf8')
  let n = 0
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      if ((JSON.parse(t) as { type?: string }).type === 'message') n++
    } catch {
      /* padding */
    }
  }
  return n
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'migration')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  // ── 1) 基线：旧 JSON 能无损导出成 jsonl ──
  {
    const dir = path.join(root, 'ok')
    await fs.mkdir(dir, { recursive: true })
    const jsonPath = path.join(dir, `${SESSION_ID}.json`)
    await fs.writeFile(jsonPath, snapshotJson(3), 'utf8')

    const r = await migrateSessionToJsonl(jsonPath, { sessionsDir: dir })
    assert(r.wrote === true, `migrates: ${JSON.stringify(r)}`)
    assert(r.deletedJson === false, 'the source JSON is kept by default')
    assert(
      await fs
        .access(jsonPath)
        .then(() => true)
        .catch(() => false),
      'and it really is still on disk',
    )
    assert(
      (await countTranscriptMessages(r.transcriptPath)) === 3,
      'all messages exported',
    )
  }

  // ── 2) 幂等：再跑一次不得重复写入 ──
  {
    const dir = path.join(root, 'idem')
    await fs.mkdir(dir, { recursive: true })
    const jsonPath = path.join(dir, `${SESSION_ID}.json`)
    await fs.writeFile(jsonPath, snapshotJson(4), 'utf8')

    const first = await migrateSessionToJsonl(jsonPath, { sessionsDir: dir })
    assert(first.wrote === true, 'first run writes')
    const afterFirst = await countTranscriptMessages(first.transcriptPath)

    const second = await migrateSessionToJsonl(jsonPath, { sessionsDir: dir })
    assert(
      second.wrote === false,
      'the second run is a no-op rather than appending a duplicate history',
    )
    assert(
      (await countTranscriptMessages(second.transcriptPath)) === afterFirst,
      'and the message count is unchanged',
    )
  }

  // ── 3) 已有 transcript 读不出来时**绝不能**覆盖 ──
  // 「读不出来」与「里面没有消息」是两回事：前者意味着我们不知道会毁掉什么。
  {
    const dir = path.join(root, 'unreadable')
    await fs.mkdir(dir, { recursive: true })
    const jsonPath = path.join(dir, `${SESSION_ID}.json`)
    await fs.writeFile(jsonPath, snapshotJson(2), 'utf8')

    // 先正常迁移一次，得到一个有内容的 transcript
    const first = await migrateSessionToJsonl(jsonPath, { sessionsDir: dir })
    assert(first.wrote === true, 'setup migrated once')
    const transcript = first.transcriptPath
    const before = await fs.readFile(transcript, 'utf8')
    assert(before.length > 0, 'setup transcript is non-empty')

    // 把它撑过 32MiB 上限 —— loadTranscriptMessages 会抛，
    // 而那正是长会话真实会遇到的条件
    const chunk = 'x'.repeat(1024 * 1024)
    const fh = await fs.open(transcript, 'a')
    try {
      for (let i = 0; i < 33; i++) await fh.write(chunk + '\n')
    } finally {
      await fh.close()
    }
    const sizeBefore = (await fs.stat(transcript)).size
    assert(sizeBefore > 32 * 1024 * 1024, 'precondition: over the read limit')

    let threw: unknown
    let r: Awaited<ReturnType<typeof migrateSessionToJsonl>> | undefined
    try {
      r = await migrateSessionToJsonl(jsonPath, { sessionsDir: dir })
    } catch (e) {
      threw = e
    }

    const sizeAfter = (await fs.stat(transcript)).size
    if (threw === undefined) {
      assert(
        r!.wrote === false,
        'an unreadable transcript must not be overwritten — "cannot read it" is not "it is empty", ' +
          'and overwriting what we cannot read destroys unknown content',
      )
    }
    assert(
      sizeAfter === sizeBefore,
      `the existing transcript is untouched (was ${sizeBefore}, now ${sizeAfter})`,
    )
  }

  // ── 4) 源 JSON 损坏 → 明确失败，且不产出半截 transcript ──
  {
    const dir = path.join(root, 'corrupt')
    await fs.mkdir(dir, { recursive: true })
    const jsonPath = path.join(dir, `${SESSION_ID}.json`)
    await fs.writeFile(jsonPath, '{ this is not json', 'utf8')

    let threw: unknown
    try {
      await migrateSessionToJsonl(jsonPath, { sessionsDir: dir })
    } catch (e) {
      threw = e
    }
    assert(threw !== undefined, 'a corrupt source fails loudly rather than silently producing nothing')

    const transcript = path.join(dir, `${SESSION_ID}.jsonl`)
    const exists = await fs
      .access(transcript)
      .then(() => true)
      .catch(() => false)
    if (exists) {
      assert(
        (await countTranscriptMessages(transcript)) === 0,
        'a failed migration leaves no half-written history behind',
      )
    }
    // 源文件必须原样保留
    const raw = await fs.readFile(jsonPath, 'utf8')
    assert(raw === '{ this is not json', 'the source file is never modified')
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: session migration')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
