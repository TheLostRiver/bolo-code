/**
 * AR-T3b S5：OpenRouter web plugin（openai-compatible 轨的 hosted 特例）
 *
 * 形状**已活体验证**（免费模型 `inclusionai/ling-3.0-flash:free`，零余额）：
 * - 请求：`plugins: [{ id: 'web' }]`（另有 `:online` 后缀简写，等价）
 * - 响应：`annotations[].url_citation.{url,title,content,start_index,end_index}`
 *   —— **嵌套**，与 OpenAI Responses 的扁平 `annotation.url` **不同形状**，不能照搬
 *
 * 两条硬约束，都有实测依据：
 *
 * ① **baseUrl 硬门控。** DeepSeek 官方 API 实测：body 顶层未知字段
 *    `plugins` 被**静默忽略**并正常返回。广撒这个字段会让用户以为搜索开着、
 *    实际什么都没发生——静默失败比报错危险得多。
 *
 * ② **默认关。** 官方文档明写 *"web search incurs extra costs even with free
 *    models"*，且转给 Exa 等**新的**第三方后端。两条都成立时不能替用户默认外发。
 *
 * 运行：npx tsx scripts/test-openrouter-web-plugin.ts
 */
import {
  detectWebSearchDialectId,
  resolveWebSearchPlan,
} from '../packages/providers/src/webSearchDialect.ts'
import {
  buildOpenAICompatibleRequestBody,
  parseOpenAIAnnotations,
} from '../packages/providers/src/openaiCompatible.ts'
import type { ProviderStreamEvent } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const OR = 'https://openrouter.ai/api/v1'
const MSGS = [{ role: 'user' as const, content: 'latest node LTS?' }]

async function main() {
  // ── 1) 只有 OpenRouter 命中这个方言 ──
  {
    assert(
      detectWebSearchDialectId({
        kind: 'openai-compatible',
        baseUrl: OR,
        model: 'inclusionai/ling-3.0-flash:free',
      }) === 'openrouter-plugin',
      'openrouter detected',
    )
    // DeepSeek 实测：未知 body 字段被静默忽略 → 绝不能广撒
    for (const url of [
      'https://api.deepseek.com/v1',
      'https://api.openai.com/v1',
      'http://127.0.0.1:11434/v1',
    ]) {
      assert(
        detectWebSearchDialectId({
          kind: 'openai-compatible',
          baseUrl: url,
          model: 'm',
        }) === 'off',
        `${url} must not get the plugin field`,
      )
    }
  }

  // ── 2) auto 必须是关（计费 + 新第三方接收方） ──
  {
    const auto = resolveWebSearchPlan('openrouter-plugin', 'auto', { model: 'm' })
    assert(auto.enabled === false, 'auto stays off: billed per request')
    const on = resolveWebSearchPlan('openrouter-plugin', 'on', { model: 'm' })
    assert(on.enabled === true, 'explicit on enables it')
    assert(
      on.bodyPatch !== undefined,
      'enabled plan carries a body patch',
    )
  }

  // ── 3) 请求体：plugins 字段按文档形状写入 ──
  {
    const body = buildOpenAICompatibleRequestBody(
      MSGS,
      { model: 'inclusionai/ling-3.0-flash:free', maxTokens: 256, baseUrl: OR },
      { webSearch: 'on' },
    )

    const plugins = body.plugins as Array<Record<string, unknown>> | undefined
    assert(Array.isArray(plugins), `plugins array present: ${JSON.stringify(body.plugins)}`)
    assert(plugins!.length === 1, 'exactly one plugin entry')
    assert(plugins![0]!.id === 'web', 'plugin id is web')
    // 模型名不能被改写成 :online —— 那会绕过方言表、也改变计费模型
    assert(
      body.model === 'inclusionai/ling-3.0-flash:free',
      `model slug untouched, got ${String(body.model)}`,
    )
  }

  // ── 4) 关闭/缺省时逐字节一致（同前几轨的教训） ──
  {
    const cfg = { model: 'm', maxTokens: 256, baseUrl: OR }
    const omitted = buildOpenAICompatibleRequestBody(MSGS, cfg, {})
    const off = buildOpenAICompatibleRequestBody(MSGS, cfg, {
      webSearch: 'off',
    })
    assert(
      JSON.stringify(omitted) === JSON.stringify(off),
      'omitting is byte-identical to off — never bill someone silently',
    )
    assert(
      !JSON.stringify(omitted).includes('plugins'),
      'no plugins field when disabled',
    )
  }

  // ── 5) 非 OpenRouter 端点即使 intent=on 也不得发 plugins ──
  {
    const body = buildOpenAICompatibleRequestBody(
      MSGS,
      {
        model: 'deepseek-v4-flash',
        maxTokens: 256,
        baseUrl: 'https://api.deepseek.com/v1',
      },
      { webSearch: 'on' },
    )
    assert(
      body.plugins === undefined,
      'a non-openrouter endpoint never receives the plugin field',
    )
  }

  // ── 6) 响应解析：url_citation 是**嵌套**的，与 Responses 不同 ──
  {
    const evs = parseOpenAIAnnotations([
      {
        type: 'url_citation',
        url_citation: {
          url: 'https://nodejs.org/a',
          title: 'Node.js',
          content: 'snippet',
          start_index: 10,
          end_index: 20,
        },
      },
    ])
    assert(evs.length === 1, `one citation event, got ${evs.length}`)
    const e = evs[0] as Extract<ProviderStreamEvent, { type: 'web_search' }>
    assert(e.type === 'web_search', 'emits a web_search event')
    assert(e.phase === 'citation', 'citation phase')
    assert(e.url === 'https://nodejs.org/a', `nested url extracted: ${e.url}`)
    assert(e.title === 'Node.js', `nested title extracted: ${e.title}`)
  }

  // ── 7) 形状不对时不猜、不炸 ──
  {
    assert(parseOpenAIAnnotations(undefined).length === 0, 'absent → nothing')
    assert(parseOpenAIAnnotations([]).length === 0, 'empty → nothing')
    assert(
      parseOpenAIAnnotations([{ type: 'url_citation' }]).length === 0,
      'missing url_citation payload → nothing, not a fabricated entry',
    )
    assert(
      parseOpenAIAnnotations([{ type: 'other', url_citation: { url: 'x' } }])
        .length === 0,
      'non-citation annotation ignored',
    )
    // 万一 OpenRouter 改成扁平，也要能认（防御，不是猜测）
    const flat = parseOpenAIAnnotations([
      { type: 'url_citation', url: 'https://flat.example' },
    ])
    assert(
      flat.length === 1,
      'tolerates a flat shape too rather than silently dropping it',
    )
  }

  console.log('PASS: openrouter web plugin')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
