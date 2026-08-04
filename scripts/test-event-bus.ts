/**
 * EVT-1 · 文件事件总线分层
 *
 * 覆盖：
 * - eventBus：发布/订阅/取消订阅/key 过滤/replay 最新状态/订阅者错误隔离
 * - memoryWatcher：目录变更通知（debounce 合并）/错误隔离降级（目录缺失）/
 *   stop 释放
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '../packages/shared/src/index.ts'
import { createMemoryWatcher } from '../packages/core/src/memoryWatcher.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- 1. 发布/订阅/取消订阅 ---
{
  const bus = createEventBus<'a' | 'b', string>()
  const got: string[] = []
  const off = bus.subscribe('a', (v) => got.push(v))
  bus.emit('a', 'one')
  bus.emit('a', 'two')
  off()
  bus.emit('a', 'three')
  assert.deepEqual(got, ['one', 'two'], 'subscriber receives until unsubscribed')
}

// --- 2. key 过滤：不同 key 隔离 ---
{
  const bus = createEventBus<'a' | 'b', number>()
  const aGot: number[] = []
  const bGot: number[] = []
  bus.subscribe('a', (v) => aGot.push(v))
  bus.subscribe('b', (v) => bGot.push(v))
  bus.emit('a', 1)
  bus.emit('b', 2)
  bus.emit('a', 3)
  assert.deepEqual(aGot, [1, 3], 'key a isolated')
  assert.deepEqual(bGot, [2], 'key b isolated')
}

// --- 3. replay 最新状态（resume 语义）---
{
  const bus = createEventBus<'mem' | 'cfg', string>()
  bus.emit('mem', 'memory-v3')
  bus.emit('cfg', 'config-v1')
  const replayed: string[] = []
  bus.replay((key, value) => replayed.push(`${key}:${value}`))
  assert.deepEqual(
    replayed.sort(),
    ['cfg:config-v1', 'mem:memory-v3'],
    'replay delivers latest per-key state',
  )
  // 无状态的 key 跳过
  const second: string[] = []
  bus.replay((key, value) => second.push(`${key}:${value}`))
  assert.deepEqual(second.sort(), ['cfg:config-v1', 'mem:memory-v3'], 'replay idempotent')
}

// --- 4. 订阅者错误隔离 ---
{
  const bus = createEventBus<'x', number>()
  const got: number[] = []
  bus.subscribe('x', () => {
    throw new Error('subscriber boom')
  })
  bus.subscribe('x', (v) => got.push(v))
  bus.emit('x', 42)
  assert.deepEqual(got, [42], 'one subscriber error does not affect others')
  // replay 同隔离语义
  const replayed: number[] = []
  const bus2 = createEventBus<'x', number>()
  bus2.emit('x', 7)
  bus2.replay((_key, v) => {
    if (v === 7) throw new Error('replay boom')
    replayed.push(v)
  })
  assert.deepEqual(replayed, [], 'replay error isolated (no throw)')
}

// --- 5. memoryWatcher：目录变更通知（debounce 合并；首次 ack 不计变更）---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-evt-'))
  const changes: boolean[] = []
  const watcher = createMemoryWatcher(dir, { debounceMs: 30 })
  watcher.onChange((available) => {
    changes.push(available)
  })
  await wait(60) // 首次订阅 ack（true）——不计为变更
  changes.length = 0
  await fs.writeFile(path.join(dir, 'a.md'), 'x', 'utf8')
  await fs.writeFile(path.join(dir, 'b.md'), 'y', 'utf8')
  await wait(150)
  // 两次写入 debounce 合并（慢 CI 可能跨窗口 → 宽容计数 1-2）
  const changeCount = changes.filter(Boolean).length
  assert(changeCount >= 1, 'directory change notified')
  assert(changeCount <= 2, `debounced (got ${changeCount})`)
  watcher.stop()
  await fs.rm(dir, { recursive: true, force: true })
}

// --- 6. memoryWatcher：错误隔离降级（目录不存在）---
{
  const missing = path.join(os.tmpdir(), 'bolo-evt-missing-' + Date.now())
  const states: boolean[] = []
  const watcher = createMemoryWatcher(missing, { debounceMs: 30 })
  watcher.onChange((available) => states.push(available))
  await wait(100)
  assert(
    states.includes(false),
    'missing dir degrades watcher (no crash, no throw)',
  )
  watcher.stop()
}

// --- 7. stop 后不再通知 ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-evt-'))
  const seen: boolean[] = []
  const watcher = createMemoryWatcher(dir, { debounceMs: 20 })
  watcher.onChange((available) => seen.push(available))
  await wait(40)
  watcher.stop()
  await fs.writeFile(path.join(dir, 'c.md'), 'z', 'utf8')
  await wait(100)
  const after = seen.filter(Boolean).length
  assert(after <= 1, `stop halts notifications (got ${after})`)
  await fs.rm(dir, { recursive: true, force: true })
}

console.log('PASS: EVT-1 event bus + memory watcher')
