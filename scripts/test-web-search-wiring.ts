/**
 * AR-T3b S4b：把 webSearch 意图从会话接到 provider
 *
 * 前几刀把方言表和两条 hosted 线路都做好了，但**用户碰不到**——
 * 意图没有从 session 流到 completeStream，也没有开关。
 * 功能在代码里而用户开不了，等于没做。
 *
 * 契约：
 * - `session.webSearch` 一路透传到 provider options
 * - 会话缺省 = `auto`（hosted 两轨据此默认开；其余轨自己判断）
 * - `/websearch` 可查可改，非法值要拒绝而不是静默吞掉
 * - 状态可读，且未配置时读起来不像坏了
 *
 * 运行：npx tsx scripts/test-web-search-wiring.ts
 */
import {
  createSession,
  dispatchSlashCommand,
} from '../packages/core/src/index.ts'
import { queryLoop } from '../packages/core/src/queryLoop.ts'
import {
  createCallModelFromProvider,
  identityPrepareMessages,
} from '../packages/core/src/deps.ts'
import { buildTool } from '../packages/tools/src/index.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
} from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 记录 provider 实际收到的 options */
function spyProvider(seen: CompleteStreamOptions[]): LlmProvider {
  return {
    id: 'mock',
    async *completeStream(
      _messages,
      options,
    ): AsyncIterable<ProviderStreamEvent> {
      seen.push(options ?? {})
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done' }
    },
  }
}

async function main() {
  // ── 1) 意图透传到 provider ──
  {
    const seen: CompleteStreamOptions[] = []
    const callModel = createCallModelFromProvider(spyProvider(seen), false)
    for await (const _ of callModel({
      messages: [{ role: 'user', content: 'q' }],
      webSearch: 'on',
    } as never)) {
      /* drain */
    }
    assert(seen.length === 1, 'provider called once')
    assert(
      seen[0]!.webSearch === 'on',
      `intent reaches the provider, got ${JSON.stringify(seen[0]!.webSearch)}`,
    )
  }

  // ── 2) 不传时不得凭空捏造意图 ──
  {
    const seen: CompleteStreamOptions[] = []
    const callModel = createCallModelFromProvider(spyProvider(seen), false)
    for await (const _ of callModel({
      messages: [{ role: 'user', content: 'q' }],
    } as never)) {
      /* drain */
    }
    assert(
      seen[0]!.webSearch === undefined,
      'absent intent stays absent rather than being invented',
    )
  }

  // ── 3) 会话缺省是 auto（hosted 两轨据此默认开） ──
  {
    const session = await createSession({
      cwd: process.cwd(),
      sessionId: 'sess_ws_default',
      systemPrompt: false,
      permissionMode: 'acceptEdits',
      model: 'mock-model',
    })
    assert(
      session.webSearch === 'auto',
      `session defaults to auto, got ${JSON.stringify(session.webSearch)}`,
    )
  }

  // ── 4) /websearch 查询当前状态 ──
  {
    const session = await createSession({
      cwd: process.cwd(),
      sessionId: 'sess_ws_show',
      systemPrompt: false,
      permissionMode: 'acceptEdits',
      model: 'mock-model',
    })
    const r = await dispatchSlashCommand(session as never, 'websearch', '')
    assert(r.ok === true, `query succeeds: ${JSON.stringify(r)}`)
    assert(
      typeof r.message === 'string' && r.message.length > 0,
      'query reports something',
    )
    // 未配置的线路不能读起来像坏了
    assert(
      !/error|broken|unsupported|unavailable/i.test(r.message ?? ''),
      `must not read like a malfunction: ${r.message}`,
    )
  }

  // ── 5) /websearch on|off|auto 改意图 ──
  {
    const session = await createSession({
      cwd: process.cwd(),
      sessionId: 'sess_ws_set',
      systemPrompt: false,
      permissionMode: 'acceptEdits',
      model: 'mock-model',
    })
    const off = await dispatchSlashCommand(session as never, 'websearch', 'off')
    assert(off.ok === true, 'set off succeeds')
    assert(session.webSearch === 'off', 'session intent updated to off')

    const on = await dispatchSlashCommand(session as never, 'websearch', 'on')
    assert(on.ok === true, 'set on succeeds')
    assert(session.webSearch === 'on', 'session intent updated to on')

    const auto = await dispatchSlashCommand(session as never, 'websearch', 'auto')
    assert(auto.ok === true, 'set auto succeeds')
    assert(session.webSearch === 'auto', 'session intent updated to auto')
  }

  // ── 6) 非法值必须拒绝，且不改状态 ──
  {
    const session = await createSession({
      cwd: process.cwd(),
      sessionId: 'sess_ws_bad',
      systemPrompt: false,
      permissionMode: 'acceptEdits',
      model: 'mock-model',
    })
    const before = session.webSearch
    const bad = await dispatchSlashCommand(session as never, 'websearch', 'yes')
    assert(bad.ok === false, 'invalid value rejected')
    assert(
      session.webSearch === before,
      'rejected command leaves the session alone',
    )
    assert(
      /on|off|auto/i.test(bad.message ?? ''),
      `error lists the valid values: ${bad.message}`,
    )
  }

  // ── 7) disabled 工具不得把 schema 发给模型 ──
  {
    let seenTools: string[] = []
    const enabled = buildTool({
      name: 'EnabledSearchFixture',
      description: 'enabled fixture',
      inputJSONSchema: { type: 'object' },
      isEnabled: () => true,
      async call() {
        return { ok: true, output: 'ok' }
      },
    })
    const disabled = buildTool({
      name: 'DisabledSearchFixture',
      description: 'disabled fixture',
      inputJSONSchema: { type: 'object' },
      isEnabled: () => false,
      async call() {
        return { ok: true, output: 'must not run' }
      },
    })
    const terminal = await queryLoop({
      sessionId: 'sess_ws_enabled_filter',
      cwd: process.cwd(),
      hooks: {},
      messages: [{ role: 'user', content: 'hello' }],
      systemPromptSections: [],
      tools: [enabled, disabled],
      deps: {
        prepareMessages: identityPrepareMessages,
        uuid: () => 'id_enabled_filter',
        callModel: async function* ({ tools }) {
          seenTools = (tools ?? []).map((tool) => tool.name)
          yield { type: 'text_delta', text: 'ok' }
          yield { type: 'done' }
        },
      },
      permissionMode: 'default',
      askPermission: async () => 'deny',
      maxTurns: 1,
    })
    assert(terminal.reason === 'completed', 'fixture query completes')
    assert(seenTools.includes('EnabledSearchFixture'), 'enabled schema reaches model')
    assert(
      !seenTools.includes('DisabledSearchFixture'),
      `disabled schema is absent from model request: ${seenTools.join(', ')}`,
    )
  }

  console.log('PASS: web search wiring')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
