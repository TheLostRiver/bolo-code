/**
 * TERM-1: 终端能力探测 — shared 解析/推断纯契约 + adapter DA2 查询/拦截/回退。
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import {
  DA2_QUERY,
  createDefaultTerminalCapabilities,
  familyFromEnv,
  familyFromVendorId,
  isDa2Response,
  parseDa2Response,
  resolveTerminalCapabilities,
  type TerminalCapabilities,
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

async function main(): Promise<void> {
  // ---- shared: DA2 parsing ----
  assert.deepEqual(
    parseDa2Response('\x1b[>7721;336;0c'),
    { vendorId: 7721, versionId: 336 },
    'Windows Terminal DA2 parses',
  )
  assert.deepEqual(
    parseDa2Response('\x1b[>1c'),
    { vendorId: 1 },
    'short DA2 with vendor only parses',
  )
  for (const bad of ['x', '\x1b[>ac', '\x1b[>1;2', '\x1b[c', '\x1b[?1;2c']) {
    assert.equal(
      parseDa2Response(bad),
      undefined,
      `malformed DA2 rejected: ${JSON.stringify(bad)}`,
    )
    assert.equal(isDa2Response(bad), false, `not a DA2 response: ${bad}`)
  }
  assert.equal(isDa2Response('\x1b[>7721;336;0c'), true)
  assert.equal(isDa2Response('\x1b[>0;0;0c'), true, 'all-zero DA2 is a response')

  // ---- shared: vendor mapping ----
  assert.equal(familyFromVendorId(7721), 'windows-terminal')
  assert.equal(familyFromVendorId(1), 'xterm')
  assert.equal(familyFromVendorId(0), 'iterm2')
  assert.equal(familyFromVendorId(99999), undefined)

  // ---- shared: env inference ----
  assert.equal(familyFromEnv({ WT_SESSION: 'abc' }), 'windows-terminal')
  assert.equal(familyFromEnv({ TERM_PROGRAM: 'WezTerm' }), 'wezterm')
  assert.equal(familyFromEnv({ TERM: 'xterm-256color' }), 'xterm')
  assert.equal(familyFromEnv({}), undefined)

  // ---- shared: resolution priority ----
  const da2 = resolveTerminalCapabilities(
    { vendorId: 7721, versionId: 336 },
    { TERM_PROGRAM: 'WezTerm' },
  )
  assert.equal(da2.family, 'windows-terminal')
  assert.equal(da2.source, 'da2')
  const env = resolveTerminalCapabilities(undefined, { TERM_PROGRAM: 'WezTerm' })
  assert.equal(env.family, 'wezterm')
  assert.equal(env.source, 'env')
  const fallback = resolveTerminalCapabilities(undefined, {})
  assert.equal(fallback.family, 'unknown')
  assert.equal(fallback.source, 'default')
  const tmux = resolveTerminalCapabilities(undefined, {
    TERM: 'screen-256color',
    TMUX: '/tmp/tmux-1/default,1,0',
  })
  assert.equal(tmux.insideTmux, true)
  const defaults = createDefaultTerminalCapabilities()
  assert.equal(defaults.family, 'unknown')
  assert.equal(defaults.source, 'default')

  // ---- adapter: query sent, response intercepted, keys unaffected ----
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(80, 24)
    const writes: string[] = []
    const controller = createRetainedTuiController({
      writeOut: (text) => writes.push(text),
      writeErr: (text) => writes.push(text),
      input,
      output,
      env: { NO_COLOR: '1', TERM_PROGRAM: 'WezTerm' },
    })
    await controller.start()
    controller.setWelcomeVisible(false)
    await controller.flush()
    assert.equal(
      controller.getTerminalCapabilities().source,
      'default',
      'before input acquisition the capabilities stay conservative',
    )

    const pending = controller.readInput()
    await settle()
    assert(
      writes.join('').includes(DA2_QUERY),
      'acquiring input sends the DA2 query',
    )
    assert.equal(
      controller.getTerminalCapabilities().family,
      'wezterm',
      'before the response arrives the env inference is active',
    )

    const eventsBefore = controller.getTerminalStats().inputEvents
    input.send('\x1b[>7721;1;0c')
    await settle()
    const caps = controller.getTerminalCapabilities()
    assert.equal(caps.family, 'windows-terminal')
    assert.equal(caps.source, 'da2')
    assert.equal(caps.vendorId, 7721)
    assert.equal(
      controller.getTerminalStats().inputEvents,
      eventsBefore,
      'the DA2 response is intercepted and never reaches the input handler',
    )

    // 普通按键照常进入输入
    input.send('a')
    await settle()
    assert.equal(
      controller.getTerminalStats().inputEvents,
      eventsBefore + 1,
      'ordinary keys still reach the input handler',
    )
    await controller.stop()
    await pending
  }

  // ---- adapter: no response → env fallback after the window ----
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(80, 24)
    const writes: string[] = []
    const controller = createRetainedTuiController({
      writeOut: (text) => writes.push(text),
      writeErr: (text) => writes.push(text),
      input,
      output,
      env: { NO_COLOR: '1', TERM: 'xterm-256color' },
    })
    await controller.start()
    controller.setWelcomeVisible(false)
    await controller.flush()
    const pending = controller.readInput()
    await settle()
    assert(
      writes.join('').includes(DA2_QUERY),
      'non-dumb terminals send the query',
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
    const caps = controller.getTerminalCapabilities()
    assert.equal(caps.family, 'xterm')
    assert.equal(caps.source, 'env')
    await controller.stop()
    await pending
  }

  // ---- adapter: dumb terminal sends no query ----
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(80, 24)
    const writes: string[] = []
    const controller = createRetainedTuiController({
      writeOut: (text) => writes.push(text),
      writeErr: (text) => writes.push(text),
      input,
      output,
      env: { NO_COLOR: '1', TERM: 'dumb' },
    })
    await controller.start()
    controller.setWelcomeVisible(false)
    await controller.flush()
    const pending = controller.readInput()
    await settle()
    assert(
      !writes.join('').includes(DA2_QUERY),
      'dumb terminals never send terminal queries',
    )
    const caps: TerminalCapabilities =
      controller.getTerminalCapabilities()
    assert.equal(caps.source, 'default')
    await controller.stop()
    await pending
  }

  console.log('PASS: TERM-1 terminal capability probe')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
