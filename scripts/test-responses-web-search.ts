/**
 * AR-T3b S3：openai-responses 的 hosted 搜索（发送 + 解析）
 *
 * 与 Anthropic 那刀同样的两个要害：
 * 1. hosted 调用**绝不能**被当成本地工具执行
 * 2. 搜索发生过必须可见，否则用户为看不见的工作付费
 *
 * Responses 侧比 Anthropic 安全一层：`:415` 按 `item.type` 白名单分流，
 * 且发射受 `cur.name` 真值门控——hosted 的 `web_search_call` 没有 name。
 * 但「不会被误执行」不等于「不会被静默丢弃」，后者才是本刀要解决的。
 *
 * 运行：npx tsx scripts/test-responses-web-search.ts
 */
import {
  buildResponsesRequest,
  processResponsesSseJson,
} from '../packages/providers/src/openaiResponses.ts'
import type { ProviderStreamEvent } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const CLIENT_TOOLS = [
  {
    name: 'Read',
    description: 'read a file',
    inputJSONSchema: { type: 'object', properties: {} },
  },
] as never

function freshState() {
  return {
    toolAcc: new Map<string, { id: string; name: string; arguments: string }>(),
  }
}

function feed(
  events: Array<Record<string, unknown>>,
): ProviderStreamEvent[] {
  const state = freshState()
  const out: ProviderStreamEvent[] = []
  for (const e of events) {
    out.push(...processResponsesSseJson(e, state).events)
  }
  return out
}

async function main() {
  // ── 1) 发送侧：hosted 条目与 function 工具并存，且不被包成 function ──
  {
    const body = buildResponsesRequest(
      [{ role: 'user', content: 'what shipped in node 24?' }],
      { model: 'gpt-5.5' },
      { tools: CLIENT_TOOLS, webSearch: 'on' },
    ) as { tools?: Array<Record<string, unknown>> }

    const tools = body.tools ?? []
    const hosted = tools.filter((t) => t.type === 'web_search')
    assert(hosted.length === 1, `exactly one hosted entry, got ${hosted.length}`)
    assert(
      !('name' in hosted[0]!) && !('parameters' in hosted[0]!),
      `hosted entry must not be shaped like a function tool: ${JSON.stringify(hosted[0])}`,
    )
    assert(
      tools.some((t) => t.type === 'function' && t.name === 'Read'),
      'client function tools still mapped normally',
    )
  }

  // ── 2) 只有搜索、没有客户端工具时也要能发出去 ──
  {
    const body = buildResponsesRequest(
      [{ role: 'user', content: 'q' }],
      { model: 'gpt-5.5' },
      { webSearch: 'on' },
    ) as { tools?: Array<Record<string, unknown>> }
    const tools = body.tools ?? []
    assert(
      tools.some((t) => t.type === 'web_search'),
      'hosted search is sent even with no client tools',
    )
  }

  // ── 3) 关闭时与不传逐字节一致（同 S1 的教训：缺省绝不能静默开启） ──
  {
    const mk = () => [{ role: 'user' as const, content: 'q' }]
    const cfg = { model: 'gpt-5.5' }
    const omitted = buildResponsesRequest(mk(), cfg, { tools: CLIENT_TOOLS })
    const explicitOff = buildResponsesRequest(mk(), cfg, {
      tools: CLIENT_TOOLS,
      webSearch: 'off',
    })
    assert(
      JSON.stringify(omitted) === JSON.stringify(explicitOff),
      'omitting webSearch is byte-identical to off — no silent opt-in',
    )
    assert(
      !JSON.stringify(omitted).includes('web_search'),
      'omitted means no hosted entry at all',
    )
  }

  // ── 4) 回归：普通 function_call 仍产出 tool_call ──
  {
    const evs = feed([
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'fc_1',
          name: 'Read',
          arguments: '{"path":"a.ts"}',
        },
      },
    ])
    const calls = evs.filter((e) => e.type === 'tool_call')
    assert(calls.length === 1, `client tool still emits a call, got ${calls.length}`)
    assert(
      calls[0]!.type === 'tool_call' && calls[0]!.name === 'Read',
      'client tool name preserved',
    )
  }

  // ── 5) 核心：web_search_call 绝不能变成 tool_call ──
  {
    const evs = feed([
      {
        type: 'response.output_item.added',
        item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', query: 'node 24 release notes' },
        },
      },
    ])
    const calls = evs.filter((e) => e.type === 'tool_call')
    assert(
      calls.length === 0,
      `hosted search must never become a local tool_call, got ${JSON.stringify(calls)}`,
    )
  }

  // ── 6) 但它必须可见 ──
  {
    const evs = feed([
      {
        type: 'response.output_item.done',
        item: {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', query: 'node 24 release notes' },
        },
      },
    ])
    const ws = evs.filter((e) => e.type === 'web_search')
    assert(ws.length >= 1, `a web_search event is emitted, got ${JSON.stringify(evs)}`)
    const q = ws.find((e) => e.type === 'web_search' && e.phase === 'query')
    assert(q !== undefined, 'query phase surfaced')
    assert(
      q!.type === 'web_search' && q!.query === 'node 24 release notes',
      `query text surfaced: ${JSON.stringify(q)}`,
    )
  }

  // ── 7) 查询词缺失时不伪造，但仍要报告搜索发生过 ──
  {
    const evs = feed([
      {
        type: 'response.output_item.done',
        item: { type: 'web_search_call', id: 'ws_2', status: 'completed' },
      },
    ])
    const ws = evs.filter((e) => e.type === 'web_search')
    assert(ws.length >= 1, 'search still reported without a query')
    assert(
      ws[0]!.type === 'web_search' && ws[0]!.query === undefined,
      'absent query stays absent rather than being invented',
    )
  }

  // ── 8) 引用不得静默丢弃 ──
  {
    const evs = feed([
      {
        type: 'response.output_text.annotation.added',
        annotation: {
          type: 'url_citation',
          url: 'https://nodejs.org/a',
          title: 'Node 24',
        },
      },
    ])
    const cited = evs.filter((e) => e.type === 'web_search' && e.phase === 'citation')
    assert(cited.length === 1, `citation surfaced, got ${JSON.stringify(evs)}`)
    assert(
      cited[0]!.type === 'web_search' && cited[0]!.url === 'https://nodejs.org/a',
      'citation carries its url',
    )
  }

  // ── 9) 正文流不受影响（回归） ──
  {
    const evs = feed([
      { type: 'response.output_text.delta', delta: 'Node 24 shipped.' },
    ])
    assert(
      evs.some((e) => e.type === 'text_delta' && e.text === 'Node 24 shipped.'),
      'body text still streams',
    )
  }

  // ── 10) 端到端：搜索必须真的出现在用户终端上 ──
  // 只产生事件不够——没人渲染就等于用户仍然为看不见的搜索付费。
  {
    const { createSessionEventPrinter } = await import(
      '../packages/cli/src/tui/formatSessionEvent.ts'
    )
    const out: string[] = []
    const printer = createSessionEventPrinter({
      writeOut: (s: string) => out.push(s),
      writeErr: () => {},
    })
    printer.onEvent({
      type: 'web_search',
      phase: 'query',
      query: 'node 24 release notes',
    } as never)
    printer.onEvent({ type: 'web_search', phase: 'results', resultCount: 3 } as never)
    printer.onEvent({
      type: 'web_search',
      phase: 'citation',
      url: 'https://nodejs.org/a',
      title: 'Node 24',
    } as never)

    const joined = out.join('')
    assert(
      joined.includes('node 24 release notes'),
      `user sees the query: ${joined}`,
    )
    assert(joined.includes('3'), `user sees the result count: ${joined}`)
    assert(
      joined.includes('https://nodejs.org/a'),
      `user sees the citation: ${joined}`,
    )
    // 不能长得像本地工具调用
    assert(
      !/→ web_search|tool_call/.test(joined),
      `must not render like a local tool call: ${joined}`,
    )
  }

  console.log('PASS: responses hosted web search')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
