/**
 * AR-T3b 前置：provider 流里不认识的内容块不得静默消失
 *
 * 两个 provider 的流解析都是**白名单**：
 *   anthropic.ts       content_block_start 只认 thinking / redacted_thinking / text / tool_use
 *   openaiResponses.ts output_item 只认 reasoning / function_call / custom_tool_call
 *
 * 白名单对「防误执行」是对的——hosted 搜索调用绝不该被当成本地工具跑。
 * 但它没有 else 兜底，于是任何新块类型（server_tool_use、web_search_tool_result、
 * web_search_call…）**连痕迹都不留**。用户会付搜索的钱、拿不到结果，
 * 而且完全看不出发生过什么。这比报错糟得多：报错能诊断，静默丢弃不能。
 *
 * 契约：
 * - 未知块**不得**被当作本地工具调用（安全第一，白名单保持）
 * - 但必须产生一个可观测的 `provider_notice` 事件，带上块类型
 * - 同一类型在一条流里只提示一次（不刷屏）
 * - 已知类型的行为**完全不变**（纯回归）
 *
 * 运行：npx tsx scripts/test-provider-unknown-block.ts
 */
import {
  eventsFromAnthropicSseEvent,
  type ProviderStreamEvent,
} from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function notices(events: readonly ProviderStreamEvent[]): string[] {
  return events
    .filter((e) => e.type === 'provider_notice')
    .map((e) => (e.type === 'provider_notice' ? e.detail : ''))
}

async function main() {
  // ── 1) 已知块行为不变（回归） ──
  {
    const st: Record<string, unknown> = {}
    const out = eventsFromAnthropicSseEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      st as never,
    )
    assert(
      notices(out).length === 0,
      `known block "text" produces no notice: ${JSON.stringify(out)}`,
    )
  }
  {
    const st: Record<string, unknown> = {}
    const out = eventsFromAnthropicSseEvent(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'hmm' },
      },
      st as never,
    )
    assert(
      out.some((e) => e.type === 'reasoning_delta'),
      'thinking still yields reasoning_delta',
    )
    assert(notices(out).length === 0, 'thinking produces no notice')
  }

  // ── 2) 未知块必须留下痕迹 ──
  {
    const st: Record<string, unknown> = {}
    const out = eventsFromAnthropicSseEvent(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', name: 'web_search' },
      },
      st as never,
    )
    const n = notices(out)
    assert(n.length === 1, `unknown block yields exactly one notice, got ${n.length}`)
    assert(
      n[0]!.includes('server_tool_use'),
      `notice names the block type so it is diagnosable: ${n[0]}`,
    )
  }

  // ── 3) 未知块绝不能变成本地工具调用 ──
  {
    const st: Record<string, unknown> = {}
    const out = eventsFromAnthropicSseEvent(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', name: 'web_search' },
      },
      st as never,
    )
    assert(
      !out.some((e) => e.type === 'tool_call'),
      'a server-side block must never become a local tool_call',
    )
  }

  // ── 4) 同类型只提示一次（不刷屏） ──
  {
    const st: Record<string, unknown> = {}
    const first = eventsFromAnthropicSseEvent(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'web_search_tool_result' },
      },
      st as never,
    )
    const second = eventsFromAnthropicSseEvent(
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'web_search_tool_result' },
      },
      st as never,
    )
    assert(notices(first).length === 1, 'first occurrence notices')
    assert(
      notices(second).length === 0,
      'repeat of the same type stays quiet',
    )

    // 但不同类型仍要各提示一次
    const other = eventsFromAnthropicSseEvent(
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'some_future_block' },
      },
      st as never,
    )
    assert(
      notices(other).length === 1,
      'a different unknown type still gets noticed',
    )
  }

  // ── 5) 未知 delta 同样不能悄悄吞掉 ──
  {
    const st: Record<string, unknown> = {}
    const out = eventsFromAnthropicSseEvent(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta' },
      },
      st as never,
    )
    assert(
      notices(out).length === 1,
      `unknown delta type is surfaced: ${JSON.stringify(out)}`,
    )
  }

  // ── 6) 缺 content_block 不得炸 ──
  {
    const st: Record<string, unknown> = {}
    const out = eventsFromAnthropicSseEvent(
      { type: 'content_block_start', index: 0 },
      st as never,
    )
    assert(Array.isArray(out), 'missing content_block handled without throwing')
  }

  // ── 7) 端到端：notice 必须真的到达用户终端 ──
  // 只在解析层产生事件不够——没人打印就等于还是静默。
  {
    const { createSessionEventPrinter } = await import(
      '../packages/cli/src/tui/formatSessionEvent.ts'
    )
    const errLines: string[] = []
    const printer = createSessionEventPrinter({
      writeOut: () => {},
      writeErr: (s: string) => errLines.push(s),
    })
    printer.onEvent({
      type: 'warning',
      message:
        'unhandled anthropic content block "server_tool_use" — this client did not surface its content',
    } as never)
    const joined = errLines.join('')
    assert(joined.length > 0, 'printer emits something for a warning')
    assert(
      joined.includes('server_tool_use'),
      `user sees the block type: ${joined}`,
    )
    assert(/warn/i.test(joined), `rendered as a warning, not an error: ${joined}`)
  }

  console.log('PASS: unknown provider blocks are surfaced, not swallowed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
