/**
 * MEM-1 · 跨会话记忆 MVP：压缩前 flush + 手动写入 + 首轮相关性检索透传。
 *
 * 覆盖：
 * - flushMemoryFromRecentMessages：正常追加 / 指纹去重 / 新消息再追加 /
 *   summarize 失败 fail-open / 过滤 system-tool-reasoning / 空消息不调用
 * - compactSession 接线：压缩成功后自动 flush（warning + hash 锚点）
 * - /memory remember 手动写入 daily log
 * - getSystemPrompt memoryRelevanceQuery 透传（首轮相关性检索注入）
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSession,
  compactSession,
  dispatchSlashCommand,
  flushMemoryFromRecentMessages,
  getSystemPrompt,
  getMemoryDailyLogPath,
  saveSession,
  loadSessionPair,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mem-flush-'))
const memDir = path.join(tmp, 'memory')
const prevMemDirEnv = process.env.BOLO_MEMORY_DIR
const prevDisableEnv = process.env.BOLO_DISABLE_MEMORY
process.env.BOLO_MEMORY_DIR = memDir
delete process.env.BOLO_DISABLE_MEMORY

const mkMessages = (): ChatMessage[] => [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'implement the pager' },
  { role: 'assistant', content: 'sure, here is the plan' },
  { role: 'tool', content: 'ok', tool_call_id: 't1', name: 'Bash' },
  { role: 'assistant', content: 'the pager is done and tests pass' },
]

let summarizeCalls = 0
const summarize = async () => {
  summarizeCalls += 1
  return { text: 'Built the pager; all tests green.' }
}

// --- 1. flush 函数：正常追加 ---
{
  const logPath = getMemoryDailyLogPath()
  await fs.rm(logPath, { force: true })
  const first = await flushMemoryFromRecentMessages({
    messages: mkMessages(),
    summarize,
    env: process.env,
  })
  assert(first.appendedLine === 'Built the pager; all tests green.', 'appended line')
  assert(first.newHash.startsWith('f'), 'hash anchor set')
  const body = await fs.readFile(logPath, 'utf8')
  assert(body.includes('Built the pager'), 'daily log has summary')
  assert(!body.includes('system prompt'), 'system message not summarized verbatim')
  assert(summarizeCalls === 1, 'summarizer called once')
  // 传给 summarize 的消息已过滤 system/tool
}

// --- 2. flush 函数：指纹去重（同消息不再追加）---
{
  const logPath = getMemoryDailyLogPath()
  const again = await flushMemoryFromRecentMessages({
    messages: mkMessages(),
    summarize,
    alreadyFlushedHash: 'f0',
    env: process.env,
  })
  assert(again.newHash !== 'f0', 'hash changes on new content')
  const before = await fs.readFile(logPath, 'utf8')
  const dedup = await flushMemoryFromRecentMessages({
    messages: mkMessages(),
    summarize,
    alreadyFlushedHash: again.newHash,
    env: process.env,
  })
  assert(dedup.appendedLine === undefined, 'same fingerprint skips append')
  const after = await fs.readFile(logPath, 'utf8')
  assert(after === before, 'no extra append for identical content')
}

// --- 3. flush 函数：summarize 失败 fail-open（不抛、锚点不更新）---
{
  const failing = await flushMemoryFromRecentMessages({
    messages: mkMessages(),
    summarize: async () => {
      throw new Error('boom')
    },
    alreadyFlushedHash: 'f42',
    env: process.env,
  })
  assert(failing.appendedLine === undefined, 'fail-open no line')
  assert(failing.newHash === 'f42', 'anchor unchanged on failure')
}

// --- 4. flush 函数：空消息不调用 summarize ---
{
  const callsBefore = summarizeCalls
  const empty = await flushMemoryFromRecentMessages({
    messages: [],
    summarize,
    env: process.env,
  })
  assert(empty.appendedLine === undefined, 'empty: no line')
  assert(summarizeCalls === callsBefore, 'empty: summarizer not called')
}

// --- 5. compactSession 接线：压缩成功后自动 flush ---
{
  const provider: LlmProvider = {
    id: 'mock',
    async *completeStream() {
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    },
  }
  const warnings: string[] = []
  const session = await createSession({
    cwd: tmp,
    provider,
    systemPrompt: false,
    compactSummarizer: summarize,
    onEvent: (e) => {
      if (e.type === 'warning') warnings.push(e.message)
    },
  })
  session.messages.push(...mkMessages())
  const out = await compactSession(session, 'manual')
  assert(out.ok === true, `compact ok: ${out.reason ?? ''}`)
  assert(
    session.memoryFlushedHash !== undefined && session.memoryFlushedHash.startsWith('f'),
    'compact wiring: hash anchor set on session',
  )
  const logPath = getMemoryDailyLogPath()
  const body = await fs.readFile(logPath, 'utf8')
  assert(body.includes('Built the pager'), 'compact wiring: summary in daily log')
  assert(
    warnings.some((w) => w.includes('memory: flushed')),
    'compact wiring: warning emitted',
  )
  // 第二次 compact：消息已压缩（snapshot 变化）→ 正常再 flush，不抛
  const out2 = await compactSession(session, 'manual')
  assert(out2.ok === true, 'second compact ok')
}

// --- 6. /memory remember 手动写入 ---
{
  const session = await createSession({
    cwd: tmp,
    provider: {
      id: 'mock',
      async *completeStream() {
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'done' }
      },
    },
    systemPrompt: false,
  })
  const res = await dispatchSlashCommand(session, 'memory', 'remember user prefers TUI over GUI')
  assert(res.ok === true, 'remember ok')
  assert(res.message.includes(getMemoryDailyLogPath()), 'remember reports path')
  const body = await fs.readFile(getMemoryDailyLogPath(), 'utf8')
  assert(body.includes('user prefers TUI over GUI'), 'remember line appended')
  const noArg = await dispatchSlashCommand(session, 'memory', 'remember')
  assert(noArg.ok === false, 'remember without line rejected')
}

// --- 7. getSystemPrompt memoryRelevanceQuery 透传 ---
{
  const topicDir = path.join(tmp, 'topics')
  await fs.mkdir(topicDir, { recursive: true })
  await fs.writeFile(
    path.join(topicDir, 'bun_pref.md'),
    '---\ndescription: prefers bun over npm\ntitle: Prefs\n---\n\nAlways use bun.\n',
    'utf8',
  )
  const prevMemDir = process.env.BOLO_MEMORY_DIR
  process.env.BOLO_MEMORY_DIR = topicDir
  try {
    const withQuery = await getSystemPrompt({
      cwd: tmp,
      userConfigDir: path.join(tmp, 'user'),
      loadInstructions: false,
      loadRules: false,
      memoryRelevanceQuery: 'bun package manager preference',
      date: '2026-08-03',
    })
    const joined = withQuery.join('\n')
    assert(joined.includes('Related memory topics'), 'relevance: related block present')
    assert(joined.includes('Always use bun'), 'relevance: topic body injected')
    const noQuery = await getSystemPrompt({
      cwd: tmp,
      userConfigDir: path.join(tmp, 'user'),
      loadInstructions: false,
      loadRules: false,
      date: '2026-08-03',
    })
    assert(
      !noQuery.join('\n').includes('Related memory topics'),
      'no query: related block absent',
    )
  } finally {
    if (prevMemDir === undefined) delete process.env.BOLO_MEMORY_DIR
    else process.env.BOLO_MEMORY_DIR = prevMemDir
  }
}

// 恢复 env（避免污染链上后续测试）
if (prevMemDirEnv === undefined) delete process.env.BOLO_MEMORY_DIR
else process.env.BOLO_MEMORY_DIR = prevMemDirEnv
if (prevDisableEnv === undefined) delete process.env.BOLO_DISABLE_MEMORY
else process.env.BOLO_DISABLE_MEMORY = prevDisableEnv

// --- 8. flush 锚点持久化：save/load roundtrip ---
{
  const session = await createSession({
    cwd: tmp,
    provider: {
      id: 'mock',
      async *completeStream() {
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'done' }
      },
    },
    systemPrompt: false,
  })
  session.memoryFlushedHash = 'f12345'
  const sessionsDir = path.join(tmp, 'sess')
  await fs.mkdir(sessionsDir, { recursive: true })
  await saveSession(session, {
    sessionsDir,
    scope: 'project',
    writeJsonSnapshot: true,
  })
  const { snapshot } = await loadSessionPair(
    path.join(sessionsDir, `${session.id}.json`),
  )
  assert(
    snapshot.memoryFlushedHash === 'f12345',
    'persist: hash roundtrips through snapshot',
  )
}

// --- 9. BOLO_DISABLE_MEMORY 熔断：flush 与 remember 都不写 ---
{
  const logPath = getMemoryDailyLogPath()
  await fs.rm(logPath, { force: true })
  const prevDisable = process.env.BOLO_DISABLE_MEMORY
  process.env.BOLO_DISABLE_MEMORY = '1'
  try {
    const out = await flushMemoryFromRecentMessages({
      messages: mkMessages(),
      summarize,
      env: process.env,
    })
    assert(out.appendedLine === undefined, 'disabled: no flush line')
    assert(
      !(await fs.stat(logPath).catch(() => null)),
      'disabled: daily log not created',
    )
    const session = await createSession({
      cwd: tmp,
      provider: {
        id: 'mock',
        async *completeStream() {
          yield { type: 'text_delta', text: 'ok' }
          yield { type: 'done' }
        },
      },
      systemPrompt: false,
    })
    const res = await dispatchSlashCommand(session, 'memory', 'remember xyz')
    assert(res.ok === false, 'disabled: remember rejected')
    assert(
      !(await fs.stat(logPath).catch(() => null)),
      'disabled: remember does not create daily log',
    )
  } finally {
    if (prevDisable === undefined) delete process.env.BOLO_DISABLE_MEMORY
    else process.env.BOLO_DISABLE_MEMORY = prevDisable
  }
}

// --- 10. flush 超时：挂起 summarizer fail-open（锚点不更新）---
{
  const hung = await flushMemoryFromRecentMessages({
    messages: mkMessages(),
    summarize: () => new Promise(() => {}), // 永不 resolve
    alreadyFlushedHash: 'f42',
    timeoutMs: 50,
    env: process.env,
  })
  assert(hung.appendedLine === undefined, 'timeout: no line')
  assert(hung.newHash === 'f42', 'timeout: anchor unchanged')
}

await fs.rm(tmp, { recursive: true, force: true })
console.log('PASS: MEM-1 memory flush + remember + relevance wiring')
