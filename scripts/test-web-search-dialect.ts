/**
 * AR-T3b S1：web search 意图 → 每厂 wire 片段（表驱动，纯契约）
 *
 * 与 effort 轨同构：会话只携带**意图**（on|off|auto），厂商片段全住在表里。
 * 这样 `ToolSpec` 不被厂商形状污染，加一家只改表。
 *
 * 本切片**只做发送侧**。流解析、usage、responses/compatible 两轨在后续切片。
 *
 * 运行：npx tsx scripts/test-web-search-dialect.ts
 */
import {
  ANTHROPIC_WEB_SEARCH_TOOL,
  WEB_SEARCH_DIALECTS,
  detectWebSearchDialectId,
  resolveWebSearchPlan,
} from '../packages/providers/src/webSearchDialect.ts'
import { buildAnthropicRequestBody } from '../packages/providers/src/anthropic.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // ── 1) 方言选择：kind + baseUrl 指纹 ──
  assert(
    detectWebSearchDialectId({ kind: 'anthropic', model: 'claude-opus-4-6' }) ===
      'anthropic-hosted',
    'anthropic maps to hosted dialect',
  )
  assert(
    detectWebSearchDialectId({
      kind: 'openai-responses',
      model: 'gpt-5.5',
    }) === 'openai-responses-hosted',
    'responses maps to hosted dialect',
  )
  assert(
    detectWebSearchDialectId({
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-4.6',
    }) === 'openrouter-plugin',
    'openrouter detected by baseUrl',
  )
  // 普通 compatible 端点没有 hosted 搜索——但这不是「坏」，是「无此能力」
  assert(
    detectWebSearchDialectId({
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    }) === 'off',
    'plain compatible endpoints report off, not a broken lane',
  )
  assert(
    detectWebSearchDialectId({ kind: 'mock', model: 'm' }) === 'off',
    'mock provider has no hosted search',
  )

  // ── 2) 意图闸门 ──
  {
    const off = resolveWebSearchPlan('anthropic-hosted', 'off', {
      model: 'claude-opus-4-6',
    })
    assert(off.enabled === false, 'intent off disables regardless of dialect')
    assert(off.toolObjects.length === 0, 'off emits nothing')
  }
  {
    const on = resolveWebSearchPlan('anthropic-hosted', 'on', {
      model: 'claude-opus-4-6',
    })
    assert(on.enabled === true, 'intent on enables on a supporting dialect')
  }
  {
    // auto = 该轨默认；hosted 两轨默认开（无新第三方接收方）
    const auto = resolveWebSearchPlan('anthropic-hosted', 'auto', {
      model: 'claude-opus-4-6',
    })
    assert(auto.enabled === true, 'auto defaults ON for anthropic hosted')
  }
  {
    // OpenRouter 转给 Exa 等新后端且计费 → auto 必须是关
    const auto = resolveWebSearchPlan('openrouter-plugin', 'auto', {
      model: 'x',
    })
    assert(
      auto.enabled === false,
      'auto defaults OFF for openrouter: new third-party recipient and per-request billing',
    )
    const on = resolveWebSearchPlan('openrouter-plugin', 'on', { model: 'x' })
    assert(on.enabled === true, 'explicit on still enables openrouter')
  }
  {
    const off = resolveWebSearchPlan('off', 'on', { model: 'x' })
    assert(
      off.enabled === false,
      'no dialect means even explicit on cannot fabricate a capability',
    )
    assert(
      off.unsupportedReason !== undefined,
      'and it says why, so the CLI can explain instead of failing silently',
    )
  }

  // ── 3) hosted 工具对象形状：绝不能带客户端工具的字段 ──
  {
    const t = ANTHROPIC_WEB_SEARCH_TOOL as Record<string, unknown>
    assert(t.type === 'web_search_20250305', 'versioned hosted type')
    assert(t.name === 'web_search', 'hosted tool name')
    assert(
      !('input_schema' in t),
      'hosted tool must not carry input_schema — that is the client-tool shape',
    )
    assert(
      !('description' in t),
      'hosted tool must not carry description',
    )
    assert(
      typeof t.max_uses === 'number' && (t.max_uses as number) > 0,
      'bounded uses so one turn cannot run away',
    )
  }

  // ── 4) 端到端：请求体里恰好一个 hosted 兄弟对象 ──
  {
    const body = buildAnthropicRequestBody(
      [{ role: 'user', content: 'what changed in node 24?' }],
      { model: 'claude-opus-4-6', maxTokens: 1024 },
      {
        tools: [
          {
            name: 'Read',
            description: 'read a file',
            inputJSONSchema: { type: 'object', properties: {} },
          },
        ] as never,
        webSearch: 'on',
      },
    ).body as { tools?: Array<Record<string, unknown>> }

    const tools = body.tools ?? []
    const hosted = tools.filter((t) => typeof t.type === 'string')
    assert(hosted.length === 1, `exactly one hosted tool, got ${hosted.length}`)
    assert(
      hosted[0]!.type === 'web_search_20250305',
      'hosted entry is the search tool',
    )
    assert(
      !('input_schema' in hosted[0]!),
      'hosted entry went through the hosted branch, not the client mapper',
    )
    // 客户端工具仍在
    assert(
      tools.some((t) => t.name === 'Read' && 'input_schema' in t),
      'client tools still mapped normally',
    )
  }

  // ── 5) 关键：hosted 对象必须落在 cache 前缀内（不能追加在断点之后） ──
  {
    const body = buildAnthropicRequestBody(
      [{ role: 'user', content: 'q' }],
      { model: 'claude-opus-4-6', maxTokens: 1024 },
      {
        tools: [
          {
            name: 'Read',
            description: 'r',
            inputJSONSchema: { type: 'object', properties: {} },
          },
        ] as never,
        webSearch: 'on',
      },
    ).body as { tools?: Array<Record<string, unknown>> }

    const tools = body.tools ?? []
    const breakpointIdx = tools.findIndex((t) => 'cache_control' in t)
    assert(breakpointIdx >= 0, 'a cache breakpoint exists on tools')
    assert(
      breakpointIdx === tools.length - 1,
      'breakpoint is on the last tool entry',
    )
    const hostedIdx = tools.findIndex((t) => t.type === 'web_search_20250305')
    assert(
      hostedIdx <= breakpointIdx,
      `hosted tool must sit inside the cached prefix (hosted=${hostedIdx}, breakpoint=${breakpointIdx})`,
    )
  }

  // ── 6) 关闭时请求体与从前逐字节一致（纯回归） ──
  {
    const mk = () => [{ role: 'user' as const, content: 'q' }]
    const cfg = { model: 'claude-opus-4-6', maxTokens: 1024 }
    const withoutOpt = buildAnthropicRequestBody(mk(), cfg, {
      tools: [
        {
          name: 'Read',
          description: 'r',
          inputJSONSchema: { type: 'object', properties: {} },
        },
      ] as never,
    }).body
    const explicitOff = buildAnthropicRequestBody(mk(), cfg, {
      tools: [
        {
          name: 'Read',
          description: 'r',
          inputJSONSchema: { type: 'object', properties: {} },
        },
      ] as never,
      webSearch: 'off',
    }).body
    assert(
      JSON.stringify(withoutOpt) === JSON.stringify(explicitOff),
      'webSearch:off is byte-identical to not passing the option',
    )
  }

  // ── 7) 表本身自洽 ──
  {
    const ids = Object.keys(WEB_SEARCH_DIALECTS) as Array<
      keyof typeof WEB_SEARCH_DIALECTS
    >
    assert(ids.includes('off'), 'off dialect exists')
    for (const id of ids) {
      const d = WEB_SEARCH_DIALECTS[id]
      assert(d.id === id, `dialect ${id} carries its own id`)
      assert(
        typeof d.defaultEnabled === 'boolean',
        `dialect ${id} states its auto default explicitly`,
      )
    }
  }

  console.log('PASS: web search dialect (S1 send side)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
