/**
 * TERM-2: 输入 CSI 分片重组 — shared 纯逻辑 + adapter 集成。
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import {
  CsiReassembler,
  isCompleteCsiSequence,
  isCsiContinuation,
  isCsiStart,
} from '../packages/shared/src/index.ts'
import {
  createRetainedTuiController,
} from '../packages/cli/src/index.ts'

class RawInputHarness extends EventEmitter {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  send(data: string): void {
    this.emit('data', Buffer.from(data, 'utf8'))
  }
}

class ResizableOutput extends EventEmitter {
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function controlledNow(initial: number): { now: () => number; advance: (ms: number) => void } {
  let current = initial
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

async function main(): Promise<void> {
  // ---- shared: completeness ----
  for (const complete of [
    '\x1b[1;2A',
    '\x1b[?25h',
    '\x1b[<0;20;5M',
    '\x1b[<0;20;5m',
    '\x1b[>0;95;0c',
    '\x1b[2J',
  ]) {
    assert.equal(
      isCompleteCsiSequence(complete),
      true,
      `complete CSI recognized: ${JSON.stringify(complete)}`,
    )
  }
  for (const incomplete of [
    '\x1b[1;2',
    '\x1b[<0;20',
    '\x1b[>',
    '\x1b[?9999',
    '\x1b[',
    'a',
    '\x1b',
  ]) {
    assert.equal(
      isCompleteCsiSequence(incomplete),
      false,
      `incomplete/non-CSI rejected: ${JSON.stringify(incomplete)}`,
    )
  }

  // ---- shared: continuation ----
  for (const continuation of [';5M', '5M', '?25h', '2A', ';0;95;0c', '>7721', '<0;20']) {
    assert.equal(
      isCsiContinuation(continuation),
      true,
      `continuation accepted: ${JSON.stringify(continuation)}`,
    )
  }
  for (const notContinuation of ['\x1b[1;2', '\x1b', '\n', '你', '']) {
    assert.equal(
      isCsiContinuation(notContinuation),
      false,
      `non-continuation rejected: ${JSON.stringify(notContinuation)}`,
    )
  }
  assert.equal(isCsiStart('\x1b[1;2'), true)
  assert.equal(isCsiStart('\x1b'), false)
  // 终结符字节（0x40-0x7e）与参数开头都是合法续段：分片响应可能把
  // 终结符单独切出（如 `\x1b[?25` + `h`），重组优先；误拼用户首字符
  // 的窗口仅限 pending 未超时的 50ms 且要求用户恰好输入终结符字节。
  assert.equal(isCsiContinuation('a'), true)
  assert.equal(isCsiContinuation('h'), true)

  // ---- shared: reassembler ----
  {
    const clock = controlledNow(1_000)
    const r = new CsiReassembler({ timeoutMs: 50, now: clock.now })
    assert.deepEqual(r.push('\x1b[<0;20'), [], 'fragment is buffered')
    assert.equal(r.hasPending(), true)
    assert.deepEqual(
      r.push(';5M'),
      ['\x1b[<0;20;5M'],
      'continuation completes the mouse sequence',
    )
    assert.equal(r.hasPending(), false)
  }
  {
    const clock = controlledNow(1_000)
    const r = new CsiReassembler({ timeoutMs: 50, now: clock.now })
    assert.deepEqual(r.push('a'), ['a'], 'plain text passes through')
    assert.deepEqual(r.push('\x1b[1;2A'), ['\x1b[1;2A'], 'complete CSI passes through')
  }
  {
    // 超时：pending 被 fail-closed 丢弃，之后输入恢复正常
    const clock = controlledNow(1_000)
    const r = new CsiReassembler({ timeoutMs: 50, now: clock.now })
    assert.deepEqual(r.push('\x1b[?9999'), [], 'unknown sequence is buffered')
    clock.advance(60)
    r.tick()
    assert.equal(r.hasPending(), false, 'timeout drops the pending fragment')
    clock.advance(60)
    assert.deepEqual(
      r.push('x'),
      ['x'],
      'input resumes after the timeout drop and sink window',
    )
  }
  {
    // 超时后的「第二半」续段碎片进入吞并窗口，不泄漏进输入
    const clock = controlledNow(1_000)
    const r = new CsiReassembler({ timeoutMs: 50, now: clock.now })
    assert.deepEqual(r.push('\x1b[>0'), [], 'DA2 fragment is buffered')
    clock.advance(60)
    r.tick()
    assert.equal(r.hasPending(), false)
    assert.deepEqual(
      r.push('>0;276;0c'),
      [],
      'second-half fragment is sunk after the timeout drop',
    )
    clock.advance(60)
    assert.deepEqual(r.push('>0;276;0c'), ['>0;276;0c'], 'sink window expires')
  }
  {
    // 固定窗口：续段不刷新 deadline，超期后整体丢弃
    const clock = controlledNow(1_000)
    const r = new CsiReassembler({ timeoutMs: 50, now: clock.now })
    assert.deepEqual(r.push('\x1b[<0;20'), [])
    clock.advance(30)
    assert.deepEqual(r.push(';5'), [], 'continuation extends content, not the window')
    clock.advance(30)
    assert.deepEqual(
      r.push('M'),
      [],
      'a late continuation after the fixed window is dropped, not completed',
    )
    assert.equal(r.hasPending(), false)
  }
  {
    // pending 长度上限：超限 fail-closed 丢弃
    const clock = controlledNow(1_000)
    const r = new CsiReassembler({ timeoutMs: 50, now: clock.now })
    assert.deepEqual(r.push('\x1b[1;' + '9'.repeat(400)), [])
    assert.equal(r.hasPending(), false, 'oversized fragment is dropped')
  }
  {
    // 超大 pending 拼接超限丢弃
    const clock = controlledNow(1_000)
    const r = new CsiReassembler({ timeoutMs: 50, now: clock.now })
    assert.deepEqual(r.push('\x1b[1;'), [])
    for (let i = 0; i < 300; i += 1) {
      const out = r.push('9')
      if (out.length > 0) break
    }
    assert.equal(r.hasPending(), false, 'merged pending over the cap is dropped')
  }
  {
    // 新 CSI 开头打断 pending
    const r = new CsiReassembler({ timeoutMs: 50 })
    assert.deepEqual(r.push('\x1b[1;2'), [], 'partial is buffered')
    assert.deepEqual(
      r.push('\x1b[3A'),
      ['\x1b[3A'],
      'a new CSI start discards the pending fragment and passes through',
    )
  }
  {
    // 非续段文本（控制字符/非 ASCII）打断 pending
    const r = new CsiReassembler({ timeoutMs: 50 })
    assert.deepEqual(r.push('\x1b[1;2'), [])
    assert.deepEqual(r.push('\n'), ['\n'], 'control text discards the pending fragment')
  }
  {
    // reset
    const r = new CsiReassembler({ timeoutMs: 50 })
    assert.deepEqual(r.push('\x1b[1;2'), [])
    assert.equal(r.reset(), true, 'reset reports a dropped fragment')
    assert.equal(r.hasPending(), false)
  }

  // ---- adapter integration ----
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(80, 24)
    const controller = createRetainedTuiController({
      writeOut: () => {},
      writeErr: () => {},
      input,
      output,
      env: { NO_COLOR: '1' },
    })
    await controller.start()
    controller.setWelcomeVisible(false)
    await controller.flush()
    const pending = controller.readInput()
    await settle()
    const eventsBefore = controller.getTerminalStats().inputEvents

    // 分片鼠标序列重组后作为单个事件转发（inputEvents +1，非 +2）
    input.send('\x1b[<0;20')
    await new Promise<void>((resolve) => setTimeout(resolve, 15))
    input.send(';5M')
    await settle()
    assert.equal(
      controller.getTerminalStats().inputEvents,
      eventsBefore + 1,
      'fragmented mouse sequence reassembles into exactly one forwarded event',
    )

    // 未知不完整序列超时后 fail-closed 丢弃（不转发）
    input.send('\x1b[?9999')
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    await settle()
    assert.equal(
      controller.getTerminalStats().inputEvents,
      eventsBefore + 1,
      'unknown incomplete sequence is dropped after the timeout',
    )

    // 超时丢弃后（含续段吞并窗口结束）输入恢复正常
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    input.send('a')
    await settle()
    assert.equal(
      controller.getTerminalStats().inputEvents,
      eventsBefore + 2,
      'input resumes normally after the timeout drop and sink window',
    )
    await controller.stop()
    await pending
  }

  console.log('PASS: TERM-2 input CSI reassembly')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
