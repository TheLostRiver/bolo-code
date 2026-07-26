/**
 * AR-T3b S2：Anthropic 服务端搜索的流解析
 *
 * 本切片最重要的不是「解析出结果」，而是**别把服务端块当本地工具执行**。
 *
 * 陷阱（调研指出、已自验）：`anthropic.ts` 的 `flushTools()` 遍历共享的
 * `toolByIndex`，只要有 name 就 `yield { type:'tool_call' }`。把
 * `server_tool_use` 存进那个 map（最省事的写法）→ 流末发出一个
 * `name:'web_search'` 的**本地**工具调用 → Bolo 去执行一个不存在的本地工具。
 * 必须走独立通道。
 *
 * 契约：
 * - `server_tool_use` **绝不**产生 `tool_call`
 * - 搜索发生过要可见（查询词 + 结果条数），否则用户付了钱看不到
 * - 引用（citations）不得静默丢弃
 * - 服务端搜索的 usage 要能读出来
 * - 客户端 `tool_use` 行为**完全不变**（纯回归）
 *
 * 运行：npx tsx scripts/test-anthropic-web-search-stream.ts
 */
import {
  parseAnthropicStreamUsage,
  type ProviderStreamEvent,
} from '../packages/providers/src/index.ts'
import { streamAnthropicSse } from '../packages/providers/src/anthropic.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 把 SSE 事件对象列表拼成 Anthropic 风格的字节流 */
function sseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`))
      }
      controller.close()
    },
  })
}

async function collect(
  events: Array<Record<string, unknown>>,
): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of streamAnthropicSse(sseStream(events))) out.push(ev)
  return out
}

async function main() {
  // ── 1) 回归：客户端 tool_use 仍然正常产出 tool_call ──
  {
    const evs = await collect([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])
    const calls = evs.filter((e) => e.type === 'tool_call')
    assert(calls.length === 1, `client tool still emits one call, got ${calls.length}`)
    assert(
      calls[0]!.type === 'tool_call' && calls[0]!.name === 'Read',
      'client tool name preserved',
    )
    assert(
      calls[0]!.type === 'tool_call' && calls[0]!.arguments === '{"path":"a.ts"}',
      'client tool arguments preserved',
    )
  }

  // ── 2) 核心：server_tool_use 绝不能变成本地 tool_call ──
  {
    const evs = await collect([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"node 24 release"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])
    const calls = evs.filter((e) => e.type === 'tool_call')
    assert(
      calls.length === 0,
      `server_tool_use must NEVER become a local tool_call, got ${JSON.stringify(calls)}`,
    )
  }

  // ── 3) 但搜索发生过必须可见（否则付了钱看不到） ──
  {
    const evs = await collect([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"node 24 release"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 's1',
          content: [
            { type: 'web_search_result', title: 'Node 24', url: 'https://nodejs.org/a' },
            { type: 'web_search_result', title: 'Changelog', url: 'https://nodejs.org/b' },
          ],
        },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ])
    const ws = evs.filter((e) => e.type === 'web_search')
    assert(ws.length >= 1, `a web_search event is emitted, got ${JSON.stringify(evs.map((e) => e.type))}`)
    const started = ws.find((e) => e.type === 'web_search' && e.phase === 'query')
    assert(started !== undefined, 'query phase surfaced')
    assert(
      started!.type === 'web_search' && started!.query === 'node 24 release',
      `query text surfaced: ${JSON.stringify(started)}`,
    )
    const done = ws.find((e) => e.type === 'web_search' && e.phase === 'results')
    assert(done !== undefined, 'results phase surfaced')
    assert(
      done!.type === 'web_search' && done!.resultCount === 2,
      `result count surfaced: ${JSON.stringify(done)}`,
    )
  }

  // ── 4) 未知块兜底仍在（S1 前置切片的安全网不能被 S2 破坏） ──
  {
    const evs = await collect([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'some_future_block' },
      },
      { type: 'message_stop' },
    ])
    assert(
      evs.some((e) => e.type === 'provider_notice'),
      'genuinely unknown blocks are still surfaced',
    )
  }

  // ── 5) 已被处理的搜索块不得再报「未知」 ──
  {
    const evs = await collect([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])
    const notices = evs.filter((e) => e.type === 'provider_notice')
    assert(
      notices.length === 0,
      `handled search blocks must not be reported unknown: ${JSON.stringify(notices)}`,
    )
  }

  // ── 6) 引用不得静默丢弃 ──
  {
    const evs = await collect([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Node 24 shipped.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: { type: 'web_search_result_location', url: 'https://nodejs.org/a', title: 'Node 24' },
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])
    assert(
      evs.some((e) => e.type === 'text_delta' && e.text === 'Node 24 shipped.'),
      'body text still streams',
    )
    const cited = evs.filter((e) => e.type === 'web_search' && e.phase === 'citation')
    assert(cited.length === 1, `citation surfaced, got ${cited.length}`)
    assert(
      cited[0]!.type === 'web_search' && cited[0]!.url === 'https://nodejs.org/a',
      'citation carries its url',
    )
  }

  // ── 7) 服务端搜索用量可读 ──
  {
    const u = parseAnthropicStreamUsage({
      type: 'message_delta',
      usage: { output_tokens: 50, server_tool_use: { web_search_requests: 3 } },
    })
    assert(u !== null, 'usage parsed')
    assert(
      u!.webSearchRequests === 3,
      `server-side search request count surfaced: ${JSON.stringify(u)}`,
    )
  }
  {
    const plain = parseAnthropicStreamUsage({
      type: 'message_delta',
      usage: { output_tokens: 50 },
    })
    assert(
      plain!.webSearchRequests === undefined,
      'absent search usage stays absent, not zero',
    )
  }

  console.log('PASS: anthropic web search stream')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
