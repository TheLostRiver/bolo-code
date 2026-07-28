/**
 * AR1C1b：runtime pager reducer / raw-mode driver。
 * 运行：npx tsx scripts/test-runtime-cli-pager.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  applyRuntimePagerKey,
  parseRuntimePagerKey,
  readRuntimePagerKey,
  runRetainedRuntimePager,
  runRuntimePager,
  type RuntimePagerInput,
  type RuntimePagerKey,
} from '../packages/cli/src/tui/runtimePager.ts'
import type {
  RuntimeListView,
  RuntimeTurnListItem,
} from '../packages/shared/src/runtimeQuery.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

const FIXTURE_TIME = '2026-07-26T13:00:00.000Z'

function listView(count: number): RuntimeListView {
  const items: RuntimeTurnListItem[] = Array.from(
    { length: count },
    (_, index) => {
      const turnId = `turn_${index + 1}`
      return {
        entity: 'turn',
        entityId: turnId,
        record: {
          turnId,
          state: 'completed',
          updatedAt: FIXTURE_TIME,
          terminalReason: 'completed',
        },
        availableActions: [],
      }
    },
  )
  return {
    protocolVersion: 1,
    kind: 'runtime.list',
    generatedAt: FIXTURE_TIME,
    sessionId: 'runtime_pager_session',
    phase: 'idle',
    runner: { state: 'idle' },
    entity: 'turn',
    items,
  }
}

assert.equal(parseRuntimePagerKey('\u001b[B'), 'next')
assert.equal(parseRuntimePagerKey('\u001b[C'), 'next')
assert.equal(parseRuntimePagerKey('n'), 'next')
assert.equal(parseRuntimePagerKey('j'), 'next')
assert.equal(parseRuntimePagerKey(' '), 'next')
assert.equal(parseRuntimePagerKey('\u001b[A'), 'previous')
assert.equal(parseRuntimePagerKey('\u001b[D'), 'previous')
assert.equal(parseRuntimePagerKey('p'), 'previous')
assert.equal(parseRuntimePagerKey('k'), 'previous')
assert.equal(parseRuntimePagerKey('q'), 'quit')
assert.equal(parseRuntimePagerKey('\u001b'), 'quit')
assert.equal(parseRuntimePagerKey('\u0003'), 'ctrl-c')
assert.equal(parseRuntimePagerKey('\u0004'), 'eof')
assert.equal(parseRuntimePagerKey('x'), 'none')

assert.deepEqual(applyRuntimePagerKey(0, 3, 'previous'), {
  page: 0,
})
assert.deepEqual(applyRuntimePagerKey(0, 3, 'next'), {
  page: 1,
})
assert.deepEqual(applyRuntimePagerKey(2, 3, 'next'), {
  page: 2,
})
assert.deepEqual(applyRuntimePagerKey(1, 3, 'quit'), {
  page: 1,
  done: 'quit',
})
assert.deepEqual(applyRuntimePagerKey(1, 3, 'ctrl-c'), {
  page: 1,
  done: 'interrupt',
})
assert.deepEqual(applyRuntimePagerKey(1, 3, 'eof'), {
  page: 1,
  done: 'eof',
})

const writes: string[] = []
const keys: RuntimePagerKey[] = [
  'next',
  'previous',
  'next',
  'next',
  'quit',
]
let keyIndex = 0
const paged = await runRuntimePager({
  view: listView(7),
  columns: 80,
  pageSize: 2,
  color: false,
  isTty: true,
  readKey: async () => keys[keyIndex++] ?? 'eof',
  writeOut: (text) => writes.push(text),
})
if (!paged.ok) throw new Error(paged.message)
assert.equal(paged.ok, true)
assert.equal(paged.reason, 'quit')
assert.equal(paged.page, 2)
assert.equal(paged.pageCount, 4)
assert(writes.some((text) => /page 1\/4/i.test(text)))
assert(writes.some((text) => /page 2\/4/i.test(text)))
assert(writes.some((text) => /page 3\/4/i.test(text)))
assert.equal(keyIndex, keys.length)

let singleReads = 0
const singleWrites: string[] = []
const single = await runRuntimePager({
  view: listView(1),
  columns: 80,
  pageSize: 5,
  color: false,
  isTty: true,
  readKey: async () => {
    singleReads += 1
    throw new Error('single-page pager must not read a key')
  },
  writeOut: (text) => singleWrites.push(text),
})
if (!single.ok) throw new Error(single.message)
assert.equal(single.ok, true)
assert.equal(single.reason, 'single-page')
assert.equal(singleReads, 0)
assert.match(singleWrites.join(''), /turn_1/)

let emptyReads = 0
const empty = await runRuntimePager({
  view: listView(0),
  columns: 80,
  pageSize: 5,
  color: false,
  isTty: true,
  readKey: async () => {
    emptyReads += 1
    throw new Error('empty pager must not read a key')
  },
  writeOut: () => undefined,
})
if (!empty.ok) throw new Error(empty.message)
assert.equal(empty.ok, true)
assert.equal(empty.reason, 'single-page')
assert.equal(emptyReads, 0)

let nonTtyReads = 0
const nonTty = await runRuntimePager({
  view: listView(7),
  columns: 80,
  pageSize: 2,
  color: false,
  isTty: false,
  readKey: async () => {
    nonTtyReads += 1
    throw new Error('non-TTY pager must never read stdin')
  },
  writeOut: () => undefined,
})
assert.equal(nonTty.ok, false)
if (nonTty.ok) throw new Error('non-TTY pager unexpectedly started')
assert.equal(nonTty.reason, 'unsupported')
assert.equal(nonTtyReads, 0)

let interrupted = 0
const ctrlC = await runRuntimePager({
  view: listView(7),
  columns: 80,
  pageSize: 2,
  color: false,
  isTty: true,
  readKey: async () => 'ctrl-c',
  writeOut: () => undefined,
  onInterrupt: () => {
    interrupted += 1
  },
})
if (!ctrlC.ok) throw new Error(ctrlC.message)
assert.equal(ctrlC.ok, true)
assert.equal(ctrlC.reason, 'interrupt')
assert.equal(interrupted, 1)

const ended = await runRuntimePager({
  view: listView(7),
  columns: 80,
  pageSize: 2,
  color: false,
  isTty: true,
  readKey: async () => 'eof',
  writeOut: () => undefined,
})
if (!ended.ok) throw new Error(ended.message)
assert.equal(ended.ok, true)
assert.equal(ended.reason, 'eof')

class FakePagerInput implements RuntimePagerInput {
  private readonly events = new EventEmitter()
  isTTY = true
  isRaw = false
  rawTransitions: boolean[] = []

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    this.rawTransitions.push(mode)
    return this
  }

  resume(): this {
    return this
  }

  pause(): this {
    return this
  }

  on(event: 'data', listener: (chunk: Buffer | string) => void): this {
    this.events.on(event, listener)
    return this
  }

  removeListener(
    event: 'data',
    listener: (chunk: Buffer | string) => void,
  ): this {
    this.events.removeListener(event, listener)
    return this
  }

  onceData(listener: (chunk: Buffer | string) => void): this {
    this.events.once('data', listener)
    return this
  }

  onceEnd(listener: () => void): this {
    this.events.once('end', listener)
    return this
  }

  onceError(listener: (error: Error) => void): this {
    this.events.once('error', listener)
    return this
  }

  removeData(listener: (chunk: Buffer | string) => void): this {
    this.events.removeListener('data', listener)
    return this
  }

  removeEnd(listener: () => void): this {
    this.events.removeListener('end', listener)
    return this
  }

  removeError(listener: (error: Error) => void): this {
    this.events.removeListener('error', listener)
    return this
  }

  emitData(chunk: Buffer | string): void {
    this.events.emit('data', chunk)
  }

  emitEnd(): void {
    this.events.emit('end')
  }

  emitError(error: Error): void {
    this.events.emit('error', error)
  }
}

class PagerOutput extends EventEmitter {
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const dataInput = new FakePagerInput()
const dataRead = readRuntimePagerKey({ input: dataInput })
dataInput.emitData(Buffer.from('\u001b[B'))
assert.equal(await dataRead, 'next')
assert.deepEqual(dataInput.rawTransitions, [true, false])

const eofInput = new FakePagerInput()
const eofRead = readRuntimePagerKey({ input: eofInput })
eofInput.emitEnd()
assert.equal(await eofRead, 'eof')
assert.deepEqual(eofInput.rawTransitions, [true, false])

const errorInput = new FakePagerInput()
const errorRead = readRuntimePagerKey({ input: errorInput })
errorInput.emitError(new Error('injected stdin failure'))
await assert.rejects(errorRead, /injected stdin failure/)
assert.deepEqual(errorInput.rawTransitions, [true, false])

const retainedTerminal = new HeadlessTerminalHarness({
  columns: 80,
  rows: 24,
  scrollback: 200,
})
const retainedInput = new FakePagerInput()
const retainedOutput = new PagerOutput(80, 24)
const retainedWrites: string[] = []
try {
  const retained = runRetainedRuntimePager({
    view: listView(7),
    columns: 80,
    rows: 24,
    pageSize: 2,
    color: false,
    isTty: true,
    input: retainedInput,
    output: retainedOutput,
    writeOut: (text) => {
      retainedWrites.push(text)
      retainedTerminal.write(text)
    },
  })
  await waitFor(() => retainedInput.isRaw, 'retained pager raw input')
  await waitFor(async () => {
    await retainedTerminal.flush()
    return retainedTerminal
      .viewport()
      .some((line) => /page 1\/4/iu.test(line.text))
  }, 'retained pager page one')

  retainedInput.emitData('\u001b[6~')
  await waitFor(async () => {
    await retainedTerminal.flush()
    return retainedTerminal
      .viewport()
      .some((line) => /page 2\/4/iu.test(line.text))
  }, 'retained pager PgDn')

  retainedInput.emitData('\u001b[5~')
  await waitFor(async () => {
    await retainedTerminal.flush()
    return retainedTerminal
      .viewport()
      .some((line) => /page 1\/4/iu.test(line.text))
  }, 'retained pager PgUp')

  retainedInput.emitData('q')
  const retainedResult = await retained
  if (!retainedResult.ok) throw new Error(retainedResult.message)
  assert.equal(retainedResult.reason, 'quit')
  assert.equal(retainedResult.page, 0)
  assert.equal(retainedInput.isRaw, false)
  assert.deepEqual(retainedInput.rawTransitions, [true, false])
  assert.equal(
    retainedWrites.join('').includes('\u001b[2J'),
    false,
    'retained pager never uses the legacy full-screen clear',
  )
} finally {
  retainedTerminal.dispose()
}

console.log('PASS: test-runtime-cli-pager')
