/**
 * CMP-3 · 压缩 Segments 可检索模式
 *
 * 覆盖：
 * - 段切分：turn 原子块 / 消息数上限 / 文本化（role 标注、tool name）
 * - runFullCompact segments 模式：segments: true → result.segments；
 *   默认 false → undefined（零行为变化）
 * - compactSession 集成：段文件落盘 + index.md + 摘要指针（summary 消息含
 *   [compact segments] 指针）；默认关闭无段文件
 * - fail-open：无 sessionsDir → warning 且 summary 保持
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  splitMessagesIntoSegments,
  SEGMENT_MAX_MESSAGES,
  runFullCompact,
  type ChatMessage,
} from '../packages/compact/src/index.ts'
import { createSession, compactSession } from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

type MkRole = ChatMessage['role']

function mk(
  role: MkRole,
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra }
}

// --- 1. 段切分：turn 原子块 + 上限 + 文本化 ---
{
  const messages: ChatMessage[] = [
    mk('user', 'u1'),
    mk('assistant', 'a1'),
    mk('tool', 't1', { name: 'Bash' }),
    mk('user', 'u2'),
    mk('assistant', 'a2'),
  ]
  // 上限内（5 条 < 25）：多 turn 合并为一段（turn 原子性只在超限时切分）
  const segments = splitMessagesIntoSegments(messages)
  assert.equal(segments.length, 1, 'within cap → one merged segment')
  assert(segments[0]!.includes('**user**: u1'), 'segment has first user line')
  assert(segments[0]!.includes('**tool**: (Bash) t1'), 'segment has tool with name')
  assert(segments[0]!.includes('**user**: u2'), 'second turn merged into segment')

  // 上限：50 条消息（25 轮）→ 3 段（24+24+2——turn 原子性让段略超/略欠）
  const many: ChatMessage[] = []
  for (let i = 0; i < 25; i += 1) {
    many.push(mk('user', `u${i}`), mk('assistant', `a${i}`))
  }
  const capped = splitMessagesIntoSegments(many)
  assert.equal(capped.length, 3, `50 messages → 3 segments (got ${capped.length})`)
  for (const seg of capped) {
    assert(
      seg.split('\n').length <= SEGMENT_MAX_MESSAGES + 1,
      'each segment near cap (turn-atomic overflow allowed)',
    )
  }
  // 空输入
  assert.deepEqual(splitMessagesIntoSegments([]), [], 'empty → no segments')
}

// --- 2. runFullCompact：segments 开关 ---
{
  const summarize = async () => ({ text: '<summary>\n1. Primary Request and Intent:\n   Segments test.\n</summary>' })
  const messages: ChatMessage[] = [
    mk('user', 'first question'),
    mk('assistant', 'first answer'),
    mk('user', 'second question'),
    mk('assistant', 'second answer'),
  ]
  const off = await runFullCompact({
    messages,
    trigger: 'manual',
    summarize,
    segments: false,
  })
  assert(off.ok === true, 'compact ok (segments off)')
  if (off.ok) {
    assert(off.result.segments === undefined, 'segments off → no segments')
  }
  const on = await runFullCompact({
    messages,
    trigger: 'manual',
    summarize,
    segments: true,
  })
  assert(on.ok === true, 'compact ok (segments on)')
  if (on.ok) {
    assert(on.result.segments !== undefined, 'segments on → segments present')
    const joined = on.result.segments!.join('\n')
    assert(joined.includes('first question'), 'segments contain summarized content')
    assert(joined.includes('first answer'), 'segments contain early content')
    // keep 尾部（最后 1 轮）不进段
    assert(!joined.includes('second answer'), 'kept tail excluded from segments')
  }
}

// --- 3. compactSession 集成：落盘 + 指针；默认关闭无文件 ---
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-cmp3-'))
  const sessionsDir = path.join(tmp, 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })
  const provider: LlmProvider = {
    id: 'mock',
    async *completeStream() {
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    },
  }
  const summarize = async () => ({
    text: '<summary>\n1. Primary Request and Intent:\n   Segments integration.\n8. Current Work:\n   Verifying persistence.\n</summary>',
  })

  // 默认关闭：无段文件
  const offSession = await createSession({
    cwd: tmp,
    systemPrompt: false,
    provider,
    compactSummarizer: summarize,
    autoSave: { sessionsDir, scope: 'project' },
  })
  offSession.messages.push(
    mk('user', 'default mode question'),
    mk('assistant', 'default mode answer'),
  )
  const off = await compactSession(offSession, 'manual')
  assert(off.ok === true, 'compact ok (default)')
  const offSegmentsDir = path.join(sessionsDir, offSession.id, 'segments')
  assert(
    !(await fs.stat(offSegmentsDir).catch(() => null)),
    'default mode: no segments dir',
  )
  assert(
    !JSON.stringify(offSession.messages).includes('[compact segments]'),
    'default mode: no pointer in messages',
  )

  // 开启：段文件 + index + 指针
  const onSession = await createSession({
    cwd: tmp,
    systemPrompt: false,
    provider,
    compactSummarizer: summarize,
    autoSave: { sessionsDir, scope: 'project' },
  })
  onSession.compactSegments = true
  onSession.messages.push(
    mk('user', 'segments mode question'),
    mk('assistant', 'segments mode answer'),
  )
  const on = await compactSession(onSession, 'manual')
  assert(on.ok === true, 'compact ok (segments on)')
  const onSegmentsDir = path.join(sessionsDir, onSession.id, 'segments')
  const files = await fs.readdir(onSegmentsDir)
  const segmentFile = files.find((f) => f.endsWith('.segments.md'))
  assert(segmentFile, 'segment file written')
  const segmentBody = await fs.readFile(
    path.join(onSegmentsDir, segmentFile!),
    'utf8',
  )
  assert(segmentBody.includes('segments mode question'), 'segment file has content')
  const indexBody = await fs.readFile(path.join(onSegmentsDir, 'index.md'), 'utf8')
  assert(indexBody.includes(segmentFile!), 'index lists the segment file')
  const pointer = JSON.stringify(onSession.messages)
  assert(pointer.includes('[compact segments]'), 'pointer appended to summary')
  assert(pointer.includes(segmentFile!), 'pointer names the segment file')

  // 检索链路：段文件可被 read_file 读取（模拟模型检索）
  const reread = await fs.readFile(path.join(onSegmentsDir, segmentFile!), 'utf8')
  assert(reread.includes('segments mode answer'), 'segment file is retrievable')

  await fs.rm(tmp, { recursive: true, force: true })
}

// --- 4. fail-open：无 sessionsDir → warning，summary 保持 ---
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-cmp3-no-'))
  const provider: LlmProvider = {
    id: 'mock',
    async *completeStream() {
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    },
  }
  const summarize = async () => ({
    text: '<summary>\n1. Primary Request and Intent:\n   No dir.\n</summary>',
  })
  const warnings: string[] = []
  const session = await createSession({
    cwd: tmp,
    systemPrompt: false,
    provider,
    compactSummarizer: summarize,
    onEvent: (e) => {
      if (e.type === 'warning') warnings.push(e.message)
    },
  })
  session.compactSegments = true
  session.messages.push(mk('user', 'no dir question'), mk('assistant', 'no dir answer'))
  const out = await compactSession(session, 'manual')
  assert(out.ok === true, 'compact ok without sessionsDir')
  assert(
    warnings.some((w) => w.includes('segments')),
    'warning emitted about segments',
  )
  assert(
    JSON.stringify(session.messages).includes('No dir'),
    'summary kept intact',
  )
  await fs.rm(tmp, { recursive: true, force: true })
}

console.log('PASS: CMP-3 compact segments mode')
