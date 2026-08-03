/**
 * MEM-2 · 记忆检索质量链
 *
 * 覆盖：
 * - 时间衰减：user 层按半衰期衰减（30 天减半），新记忆排前
 * - project 免衰减：同年龄 project 与 user topic，project 不被降权
 * - 空/脚手架过滤：frontmatter 后无正文的 topic 不入选
 * - description 缺失降权
 * - 多样性重排：相似标题只保留最高分者
 * - scan 集成：真实文件系统写入 → hasBody 判定 → select 过滤
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  scanMemoryTopics,
  selectRelevantMemoryTopics,
  MEMORY_HALF_LIFE_DAYS,
  MEMORY_DIVERSITY_SIMILARITY,
} from '../packages/core/src/index.ts'
import type { MemoryTopicHeader } from '../packages/core/src/memory.ts'

const DAY = 86_400_000
const NOW = Date.now()

const topic = (
  filename: string,
  over: Partial<MemoryTopicHeader> = {},
): MemoryTopicHeader => ({
  filename,
  filePath: `/mem/${filename}`,
  mtimeMs: NOW,
  description: `desc for ${filename}`,
  title: null,
  scope: 'user',
  ...over,
})

// --- 1. 时间衰减：新记忆排前（同 query 同分 → 衰减区分）---
{
  const fresh = topic('bun_prefs.md', { description: 'prefers bun' })
  const stale = topic('bun_old.md', {
    description: 'prefers bun',
    mtimeMs: NOW - MEMORY_HALF_LIFE_DAYS * DAY, // 一个半衰期 → 0.5^1
  })
  const rel = selectRelevantMemoryTopics('bun preferences', [stale, fresh], {
    now: NOW,
  })
  assert(rel[0]!.filename === 'bun_prefs.md', 'fresh topic ranks first')
  assert(rel[1]!.filename === 'bun_old.md', 'stale topic ranks second')
  const f = rel.find((r) => r.filename === 'bun_prefs.md')!
  const s = rel.find((r) => r.filename === 'bun_old.md')!
  assert(
    f.score >= s.score * 1.5,
    `decay halves stale score (${f.score.toFixed(2)} vs ${s.score.toFixed(2)})`,
  )
}

// --- 2. project 免衰减：同年龄 project 不被降权 ---
{
  const projOld = topic('deadline.md', {
    scope: 'project',
    description: 'release deadline',
    mtimeMs: NOW - 2 * MEMORY_HALF_LIFE_DAYS * DAY,
  })
  const userOld = topic('deadline_notes.md', {
    description: 'release deadline',
    mtimeMs: NOW - 2 * MEMORY_HALF_LIFE_DAYS * DAY,
  })
  const rel = selectRelevantMemoryTopics('deadline release', [userOld, projOld], {
    now: NOW,
  })
  const p = rel.find((r) => r.filename === 'deadline.md')!
  const u = rel.find((r) => r.filename === 'deadline_notes.md')!
  assert(p, 'project topic selected')
  assert(u, 'user topic selected')
  assert(
    p.score >= u.score * 2,
    `project exempt from decay (${p.score.toFixed(2)} vs ${u.score.toFixed(2)})`,
  )
}

// --- 3. 空/脚手架过滤：hasBody false 不入选 ---
{
  const empty = topic('scaffold.md', {
    description: 'bun setup',
    hasBody: false,
  })
  const real = topic('bun_real.md', { description: 'bun setup' })
  const rel = selectRelevantMemoryTopics('bun setup', [empty, real], { now: NOW })
  assert(
    !rel.some((r) => r.filename === 'scaffold.md'),
    'empty topic filtered out',
  )
  assert(rel.some((r) => r.filename === 'bun_real.md'), 'real topic kept')
}

// --- 4. description 缺失降权 ---
{
  const withDesc = topic('guide_setup.md', { description: 'bun setup guide' })
  const noDesc = topic('quick_setup.md', { description: null })
  const rel = selectRelevantMemoryTopics('bun setup', [noDesc, withDesc], {
    now: NOW,
  })
  const a = rel.find((r) => r.filename === 'guide_setup.md')!
  const b = rel.find((r) => r.filename === 'quick_setup.md')
  assert(a, 'with-desc topic selected')
  assert(b, 'missing-description topic still retained (floor)')
  assert(b.score >= 0.5, `missing-description floored at 0.5 (got ${b.score})`)
  assert(a.score > b.score, 'missing description penalized')
}

// --- 5. 多样性重排：相似标题只保留最高分者 ---
{
  const one = topic('bun_setup.md', {
    title: 'bun setup',
    description: 'bun install guide',
  })
  const two = topic('bun_config.md', {
    title: 'bun setup config',
    description: 'bun install guide',
  })
  const rel = selectRelevantMemoryTopics('bun setup config', [two, one], {
    now: NOW,
    limit: 5,
  })
  assert(
    rel.length === 1,
    `similar topics deduped to one (got ${rel.length}: ${rel.map((r) => r.filename).join(',')})`,
  )
  assert(rel[0]!.filename === 'bun_config.md', 'higher-scored variant kept')
}

// --- 6. scan 集成：真实文件系统 hasBody 判定 ---
{
  const dir = path.join(os.tmpdir(), `bolo-mem-rank-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  try {
    await fs.writeFile(
      path.join(dir, 'empty.md'),
      '---\ndescription: bun setup\ntitle: Empty\n---\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(dir, 'filled.md'),
      '---\ndescription: bun setup\ntitle: Filled\n---\n\nAlways use bun.\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(dir, 'nofront.md'),
      '# Plain\n\njust body text, no frontmatter\n',
      'utf8',
    )
    await fs.writeFile(path.join(dir, 'blank.md'), '   \n\n  \n', 'utf8')
    const topics = await scanMemoryTopics(dir, { scope: 'user' })
    const empty = topics.find((t) => t.filename === 'empty.md')
    const filled = topics.find((t) => t.filename === 'filled.md')
    const nofront = topics.find((t) => t.filename === 'nofront.md')
    const blank = topics.find((t) => t.filename === 'blank.md')
    assert(empty && empty.hasBody === false, 'empty frontmatter-only → hasBody false')
    assert(filled && filled.hasBody !== false, 'filled → hasBody true')
    assert(nofront && nofront.hasBody !== false, 'no frontmatter → treated as body')
    assert(
      blank && blank.hasBody === false,
      'whitespace-only no-frontmatter → hasBody false',
    )
    // 正文在 40 行/8KB 窗口之后也不误判为空（全文判定）
    await fs.writeFile(
      path.join(dir, 'longhead.md'),
      '---\ndescription: bun setup\ntitle: Long\n---\n' +
        Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') +
        '\n\nreal body content here\n',
      'utf8',
    )
    const longhead = (await scanMemoryTopics(dir, { scope: 'user' })).find(
      (t) => t.filename === 'longhead.md',
    )
    assert(
      longhead && longhead.hasBody !== false,
      'body beyond head window still detected (full-file read)',
    )
    const rel = selectRelevantMemoryTopics('bun setup', topics, { now: NOW })
    assert(
      !rel.some((r) => r.filename === 'empty.md'),
      'scan integration: empty topic filtered from selection',
    )
    assert(
      rel.some((r) => r.filename === 'filled.md'),
      'scan integration: filled topic selected',
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

console.log(
  `PASS: MEM-2 memory retrieval quality chain (half-life ${MEMORY_HALF_LIFE_DAYS}d, diversity ${MEMORY_DIVERSITY_SIMILARITY})`,
)
