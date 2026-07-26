/**
 * AR3A · runtime protocol client + normalized store
 *
 * 契约层（`packages/shared/src/runtimeProtocol.ts`）早已完整：版本常量、
 * snapshot/query/command 形状、fail-closed 解析器、协商函数，都有测试。
 * 缺的是**消费侧**：没有 client、没有 transport 抽象、没有 store，
 * 且 `negotiateRuntimeProtocol` 在生产代码里**零调用者**。
 *
 * CLI 之所以不需要，是因为它进程内直连 core，从不跨传输边界。Desktop 要跨 IPC，
 * 于是所有「跨边界才会出的问题」第一次变成真问题：
 *
 * - **不兼容要有明确空态。** 版本对不上时给一个泛化的 error，用户只会看到
 *   「出错了」然后去排查完全错误的方向。必须能区分「协议不兼容」与「服务挂了」。
 * - **超时不能挂死。** IPC 对端可能永远不回；一个永不 resolve 的 Promise
 *   会让界面卡在 loading，且没有任何报错。
 * - **未知字段必须容忍。** 新版服务端加字段是常态，旧客户端不能因此整体拒绝——
 *   否则协议永远无法演进。
 * - **stale command 要被识别。** 界面上看到的状态可能已经过期，
 *   照着它发的命令必须拿到结构化错误码，而不是静默成功。
 *
 * store 只能有一个：renderer 不得持第二状态机（薄壳纪律）。
 *
 * 运行：npx tsx scripts/test-runtime-client.ts
 */
import {
  createRuntimeClient,
  createMockRuntimeTransport,
  type RuntimeTransport,
} from '../packages/shared/src/runtimeClient.ts'
import {
  RUNTIME_PROTOCOL_VERSION,
  createRuntimeProtocolHello,
  type RuntimeSnapshot,
} from '../packages/shared/src/runtimeProtocol.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function snapshot(overrides?: Partial<RuntimeSnapshot>): RuntimeSnapshot {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.snapshot',
    generatedAt: '2026-07-27T00:00:00.000Z',
    features: [],
    session: {
      sessionId: 'sess_1',
      cwd: '/w',
      phase: 'ready',
      runner: { state: 'idle' },
      turns: [],
      controls: [],
      tasks: [],
    },
    ...overrides,
  } as RuntimeSnapshot
}

async function main() {
  // ── 1) 正常握手：协商 → ready，并且**真的调用了**协商 ──
  {
    const transport = createMockRuntimeTransport({ snapshot: snapshot() })
    const client = createRuntimeClient({ transport })
    assert(client.getState().status === 'disconnected', 'starts disconnected')

    const seen: string[] = []
    client.subscribe((s) => seen.push(s.status))
    await client.connect()

    const st = client.getState()
    assert(st.status === 'ready', `connects to ready: ${JSON.stringify(st)}`)
    assert(
      st.status === 'ready' && st.protocolVersion === RUNTIME_PROTOCOL_VERSION,
      'carries the negotiated version',
    )
    assert(
      seen.includes('connecting') && seen.includes('ready'),
      `subscribers see the transition, got ${seen.join('→')}`,
    )
  }

  // ── 2) 版本不兼容 → **独立空态**，不是泛化 error ──
  {
    const transport: RuntimeTransport = {
      async hello() {
        return { ...createRuntimeProtocolHello(), supportedVersions: [999] }
      },
      async query() {
        throw new Error('should not be reached')
      },
      async command() {
        throw new Error('should not be reached')
      },
    }
    const client = createRuntimeClient({ transport })
    await client.connect()
    const st = client.getState()
    assert(
      st.status === 'incompatible',
      `version mismatch is its own state, not a generic error: ${JSON.stringify(st)}`,
    )
    assert(
      st.status === 'incompatible' && st.code === 'unsupported_version',
      `carries the structured reason: ${JSON.stringify(st)}`,
    )
    assert(
      st.status === 'incompatible' && /version/i.test(st.detail),
      'the detail is actionable, not just a code',
    )
  }

  // ── 3) 超时不得挂死 ──
  // 一个永不 resolve 的对端会让界面永远停在 loading，且没有任何报错。
  {
    const transport: RuntimeTransport = {
      hello: () => new Promise(() => {}),
      query: () => new Promise(() => {}),
      command: () => new Promise(() => {}),
    }
    const client = createRuntimeClient({ transport, timeoutMs: 150 })
    const res = await Promise.race([
      client.connect().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ])
    assert(res === 'settled', 'connect must not hang when the peer never answers')
    const st = client.getState()
    assert(
      st.status === 'error',
      `a silent peer lands in error, not in a permanent loading state: ${JSON.stringify(st)}`,
    )
    assert(
      st.status === 'error' && /timeout|timed out/i.test(st.detail),
      `and says it was a timeout: ${JSON.stringify(st)}`,
    )
  }

  // ── 4) 未知字段必须容忍（前向兼容）──
  // 新版服务端加字段是常态；旧客户端整体拒绝会让协议再也没法演进。
  {
    const withExtra = {
      ...snapshot(),
      futureField: { anything: true },
      session: { ...snapshot().session, unknownThing: 42 },
    }
    const transport = createMockRuntimeTransport({
      snapshot: withExtra as unknown as RuntimeSnapshot,
    })
    const client = createRuntimeClient({ transport })
    await client.connect()
    assert(client.getState().status === 'ready', 'unknown fields do not break the handshake')
    const snap = client.getSnapshot()
    assert(snap, 'snapshot is available')
    assert(snap!.session.sessionId === 'sess_1', 'known fields still parse')
    assert(snap!.generatedAt.length > 0, 'the wrapper fields survive too — the UI needs freshness')
  }

  // ── 5) 服务端回来的东西根本不是快照 → 明确失败，不得当成空会话 ──
  // 「解析不出来」和「会话是空的」必须区分开，否则界面会显示一个不存在的空会话。
  {
    const transport: RuntimeTransport = {
      hello: async () => createRuntimeProtocolHello(),
      query: async () => ({ kind: 'not.a.snapshot' }),
      command: async () => ({}),
    }
    const client = createRuntimeClient({ transport })
    await client.connect()
    const st = client.getState()
    assert(
      st.status === 'error',
      `an unparseable payload is an error, never an empty session: ${JSON.stringify(st)}`,
    )
    assert(client.getSnapshot() === undefined, 'and no snapshot is exposed')
  }

  // ── 6) stale command：结构化错误码，不静默成功 ──
  {
    const transport = createMockRuntimeTransport({
      snapshot: snapshot(),
      commandResult: {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'runtime.result',
        requestId: 'req_1',
        action: 'turn.interrupt',
        ok: false,
        code: 'state_conflict',
        detail: 'turn already completed',
      },
    })
    const client = createRuntimeClient({ transport })
    await client.connect()
    const r = await client.send({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command',
      requestId: 'req_1',
      action: 'turn.interrupt',
      turnId: 'turn_gone',
    } as never)
    assert(r.ok === false, 'a stale command does not silently succeed')
    assert(
      r.ok === false && r.code === 'state_conflict',
      `and carries the structured code: ${JSON.stringify(r)}`,
    )
  }

  // ── 7) 未连接时发命令要被挡住，而不是打到一个没握手的对端 ──
  {
    const transport = createMockRuntimeTransport({ snapshot: snapshot() })
    const client = createRuntimeClient({ transport })
    const r = await client.send({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command',
      requestId: 'req_x',
      action: 'runtime.inspect',
      entity: 'turn',
      entityId: 't1',
    } as never)
    assert(r.ok === false, 'commands before connect are refused')
    assert(
      r.ok === false && r.code === 'invalid_command',
      `with a structured code: ${JSON.stringify(r)}`,
    )
  }

  // ── 8) store 只有一个：refresh 后订阅者拿到的是同一份 ──
  {
    const transport = createMockRuntimeTransport({ snapshot: snapshot() })
    const client = createRuntimeClient({ transport })
    await client.connect()
    let notified = 0
    const off = client.subscribe(() => notified++)
    await client.refresh()
    assert(notified > 0, 'refresh notifies subscribers')
    const a = client.getSnapshot()
    const b = client.getSnapshot()
    assert(a === b, 'getSnapshot returns the stored value, not a fresh copy each call')
    off()
    const before = notified
    await client.refresh()
    assert(notified === before, 'unsubscribe actually stops notifications')
  }

  // ── 9) 断线后可重连，且状态先回到非 ready ──
  {
    let fail = false
    const base = createMockRuntimeTransport({ snapshot: snapshot() })
    const transport: RuntimeTransport = {
      hello: () => base.hello(),
      query: () => (fail ? Promise.reject(new Error('EPIPE')) : base.query({})),
      command: (c) => base.command(c),
    }
    const client = createRuntimeClient({ transport })
    await client.connect()
    assert(client.getState().status === 'ready', 'connected')

    fail = true
    await client.refresh()
    assert(
      client.getState().status === 'error',
      `a dropped connection leaves ready: ${JSON.stringify(client.getState())}`,
    )

    fail = false
    await client.connect()
    assert(
      client.getState().status === 'ready',
      'reconnect works after the transport recovers',
    )
  }

  console.log('PASS: runtime client')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
