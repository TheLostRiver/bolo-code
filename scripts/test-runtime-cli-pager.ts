/**
 * AR1C1b：共享 runtime pager reducer 与 retained VT driver。
 * 运行：npx tsx scripts/test-runtime-cli-pager.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  applyRuntimePagerKey,
  parseRuntimePagerKey,
  runRetainedRuntimePager,
} from '../packages/cli/src/tui/runtimePager.ts'
import type { BoloTerminalInput } from '../packages/cli/src/tui/boloTerminalAdapter.ts'
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

class FakePagerInput implements BoloTerminalInput {
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

  emitData(chunk: Buffer | string): void {
    this.events.emit('data', chunk)
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
