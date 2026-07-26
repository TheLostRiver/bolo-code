/**
 * AR3A · runtime protocol 的消费侧：transport 抽象 + client + normalized store
 *
 * 契约层（`runtimeProtocol.ts`）早已完整，缺的一直是消费侧。CLI 不需要它，
 * 因为它进程内直连 core、从不跨传输边界；Desktop 要跨 IPC，
 * 于是「跨边界才会出的问题」第一次变成真问题。
 *
 * 本模块**纯数据 + 纯逻辑**：不认识 Electron、不认识 Node IPC，
 * 只依赖一个三方法的 `RuntimeTransport`。这样 mock 与真 core adapter
 * 可以是同一个接口，测试不需要起进程。
 *
 * 四条设计约束，每条对着一种跨边界才会出现的失败：
 *
 * ① **不兼容是独立状态**，不是泛化 error。版本对不上和服务挂了要能分开——
 *    否则用户看到「出错了」会去排查完全错误的方向。
 * ② **一切等待都带超时。** IPC 对端可能永远不回；永不 resolve 的 Promise
 *    会让界面卡在 loading 且不报任何错。
 * ③ **未知字段一律容忍。** 新版服务端加字段是常态，旧客户端整体拒绝
 *    会让协议再也无法演进。
 * ④ **解析失败 ≠ 空会话。** 二者混淆会让界面显示一个并不存在的空会话。
 */

import {
  RUNTIME_PROTOCOL_SUPPORTED_VERSIONS,
  RUNTIME_PROTOCOL_FEATURES,
  createRuntimeProtocolHello,
  negotiateRuntimeProtocol,
  parseRuntimeSnapshot,
  parseRuntimeCommandResult,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeProtocolFeature,
  type RuntimeProtocolVersion,
  type RuntimeSnapshot,
} from './runtimeProtocol.ts'

/**
 * 传输层。三个方法都收发**未解析的 unknown**——解析与校验一律在 client 里做，
 * 这样 adapter 无论走 IPC、WebSocket 还是进程内，都不会各自实现一遍校验。
 */
export type RuntimeTransport = {
  hello(): Promise<unknown>
  query(request: unknown): Promise<unknown>
  command(command: unknown): Promise<unknown>
}

export type RuntimeClientState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | {
      status: 'ready'
      protocolVersion: RuntimeProtocolVersion
      features: RuntimeProtocolFeature[]
    }
  /** 协议不兼容——与「服务挂了」是两回事，故独立成态 */
  | {
      status: 'incompatible'
      code: 'unsupported_version' | 'unsupported_features'
      detail: string
    }
  | { status: 'error'; detail: string }

export type RuntimeClient = {
  getState(): RuntimeClientState
  /**
   * 已解析的完整快照；未就绪或解析失败时为 undefined。
   *
   * 刻意返回**整个** snapshot 而不是只给 `session`：`generatedAt` 与 `features`
   * 界面同样要用（显示数据新鲜度、按能力开关 UI），在这一层丢掉它们
   * 只会逼消费方再开一条取数路径。
   */
  getSnapshot(): RuntimeSnapshot | undefined
  subscribe(listener: (state: RuntimeClientState) => void): () => void
  connect(): Promise<void>
  refresh(): Promise<void>
  send(command: RuntimeCommand): Promise<RuntimeCommandResult>
}

export type RuntimeClientOptions = {
  transport: RuntimeTransport
  /** 单次等待上限；对端不回时用它兜底，默认 10s */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/** 与超时竞速。绝不留下一个可能永不 resolve 的等待。 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function localResult(
  command: RuntimeCommand,
  code: RuntimeCommandResult extends { code: infer C } ? C : never,
  detail: string,
): RuntimeCommandResult {
  return {
    protocolVersion: command.protocolVersion,
    kind: 'runtime.result',
    requestId: command.requestId,
    action: command.action,
    ok: false,
    code,
    detail,
  } as RuntimeCommandResult
}

export function createRuntimeClient(
  opts: RuntimeClientOptions,
): RuntimeClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const listeners = new Set<(s: RuntimeClientState) => void>()

  // 单一 store：状态与快照都只此一份，消费方不得再持第二状态机
  let state: RuntimeClientState = { status: 'disconnected' }
  let snapshot: RuntimeSnapshot | undefined

  function setState(next: RuntimeClientState): void {
    state = next
    for (const l of [...listeners]) {
      try {
        l(next)
      } catch {
        /* 订阅者抛错不得影响其它订阅者或 client 自身 */
      }
    }
  }

  /** 解析失败必须把快照清掉：留着旧的会让界面显示已经不成立的状态 */
  function fail(detail: string): void {
    snapshot = undefined
    setState({ status: 'error', detail })
  }

  async function loadSnapshot(): Promise<boolean> {
    let raw: unknown
    try {
      raw = await withTimeout(opts.transport.query({}), timeoutMs, 'runtime query')
    } catch (e) {
      fail(errText(e))
      return false
    }
    const parsed = parseRuntimeSnapshot(raw)
    if (!parsed.ok) {
      // 「解析不出来」与「会话是空的」必须区分：混淆会让界面显示一个不存在的空会话
      fail(`runtime snapshot could not be parsed (${parsed.code}): ${parsed.detail}`)
      return false
    }
    snapshot = parsed.value
    return true
  }

  return {
    getState: () => state,
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async connect() {
      setState({ status: 'connecting' })

      let helloRaw: unknown
      try {
        helloRaw = await withTimeout(
          opts.transport.hello(),
          timeoutMs,
          'runtime hello',
        )
      } catch (e) {
        fail(errText(e))
        return
      }

      // 服务端声明它支持哪些版本；拿不到就按本地能力兜底再协商，
      // 让不兼容仍然走 incompatible 而不是被当成解析错误
      const peer = helloRaw as Partial<ReturnType<typeof createRuntimeProtocolHello>>
      const peerVersions = Array.isArray(peer?.supportedVersions)
        ? peer.supportedVersions
        : [...RUNTIME_PROTOCOL_SUPPORTED_VERSIONS]

      const negotiated = negotiateRuntimeProtocol({
        supportedVersions: peerVersions,
        requestedFeatures: Array.isArray(peer?.features)
          ? peer.features
          : [...RUNTIME_PROTOCOL_FEATURES],
      })
      if (!negotiated.ok) {
        snapshot = undefined
        setState({
          status: 'incompatible',
          code: negotiated.code,
          detail: negotiated.detail,
        })
        return
      }

      if (!(await loadSnapshot())) return

      setState({
        status: 'ready',
        protocolVersion: negotiated.protocolVersion,
        features: negotiated.features,
      })
    },

    async refresh() {
      if (!(await loadSnapshot())) return
      // 快照变了也要通知订阅者，否则界面不会重画
      setState(state)
    },

    async send(command) {
      if (state.status !== 'ready') {
        // 没握手就发命令，对端可能根本没协商过版本；本地挡住比让它打过去更安全
        return localResult(
          command,
          'invalid_command' as never,
          `runtime client is ${state.status}; connect before sending commands`,
        )
      }
      let raw: unknown
      try {
        raw = await withTimeout(
          opts.transport.command(command),
          timeoutMs,
          'runtime command',
        )
      } catch (e) {
        return localResult(command, 'internal_error' as never, errText(e))
      }
      const parsed = parseRuntimeCommandResult(raw)
      if (!parsed.ok) {
        return localResult(
          command,
          'internal_error' as never,
          `runtime command result could not be parsed (${parsed.code}): ${parsed.detail}`,
        )
      }
      return parsed.value
    },
  }
}

export type MockRuntimeTransportOptions = {
  snapshot?: RuntimeSnapshot
  commandResult?: RuntimeCommandResult
  /** 覆盖 hello（测不兼容用） */
  hello?: unknown
}

/**
 * 测试与 Desktop 离线开发用的 mock transport。
 *
 * **与真 adapter 是同一个接口**——这正是 AR3A 要求「mock 与真 core adapter
 * 同接口」的落点：换 adapter 不用改 client、不用改 store、不用改界面。
 */
export function createMockRuntimeTransport(
  opts: MockRuntimeTransportOptions = {},
): RuntimeTransport {
  return {
    async hello() {
      return opts.hello ?? createRuntimeProtocolHello()
    },
    async query() {
      if (!opts.snapshot) throw new Error('mock transport has no snapshot configured')
      return opts.snapshot
    },
    async command() {
      if (!opts.commandResult) {
        throw new Error('mock transport has no command result configured')
      }
      return opts.commandResult
    },
  }
}
