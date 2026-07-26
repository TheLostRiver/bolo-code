/**
 * 错误解释：状态码会撒谎，body 才是真相
 *
 * 活体实测发现（第三方中转，2026-07-26）：
 *   HTTP 503 + {"code":"model_not_found","message":"…无可用渠道…"}
 * 我的解释器只看 503，回了「这是上游问题，不是你的配置」——
 * 而 body 明说是 model 找不到，**恰恰是配置问题**。把人往反方向指
 * 比不给提示更糟。
 *
 * 中转/网关经常返回语义不符的状态码，所以：**body 优先于 status**。
 *
 * 运行：npx tsx scripts/test-provider-error-status-vs-body.ts
 */
import { explainProviderError } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const CTX = {
  providerId: 'resp',
  kind: 'openai-responses',
  model: 'gpt-5.5',
  baseUrl: 'https://relay.example/v1',
}

async function main() {
  // ── 1) 真实案例：503 包着 model_not_found ──
  {
    const raw =
      'OpenAI Responses HTTP 503: {"error":{"code":"model_not_found","message":"分组 codex-混池 下模型 gpt-5.5 无可用渠道（distributor）","type":"new_api_error"}}'
    const out = explainProviderError(new Error(raw), { ...CTX, status: 503 })

    assert(
      !/not a problem with your setup/i.test(out),
      `must not claim the setup is fine when the body says model_not_found:\n${out}`,
    )
    assert(
      /model/i.test(out),
      `must point at the model:\n${out}`,
    )
    assert(
      out.includes('gpt-5.5'),
      `must name the model actually requested:\n${out}`,
    )
    assert(
      /\/model|available|check/i.test(out),
      `must offer a next step:\n${out}`,
    )
  }

  // ── 2) 各种 model 找不到的说法都要认 ──
  for (const body of [
    'HTTP 404: {"error":{"code":"model_not_found"}}',
    'HTTP 400: The model `gpt-9` does not exist',
    'HTTP 503: 无可用渠道',
    'HTTP 500: {"error":{"message":"no available channel for model x"}}',
  ]) {
    const out = explainProviderError(new Error(body), CTX)
    assert(
      /model/i.test(out) && /hint:/i.test(out),
      `model-not-found variant explained: ${body}\n${out}`,
    )
    assert(
      !/not a problem with your setup/i.test(out),
      `variant must not be misattributed upstream: ${body}\n${out}`,
    )
  }

  // ── 3) 回归：真正的上游 5xx 仍然说是上游 ──
  {
    const out = explainProviderError(
      new Error('Anthropic HTTP 503: upstream unavailable'),
      { ...CTX, kind: 'anthropic', status: 503 },
    )
    assert(
      /upstream|not your|server/i.test(out),
      `a genuine 5xx is still attributed upstream:\n${out}`,
    )
    assert(
      !/check.*model/i.test(out),
      `and must not send the user chasing their model config:\n${out}`,
    )
  }

  // ── 4) 回归：401 / 网络 / 限流 分支不受影响 ──
  {
    const auth = explainProviderError(new Error('HTTP 401 unauthorized'), {
      ...CTX,
      apiKeyEnv: 'MY_KEY',
    })
    assert(auth.includes('MY_KEY'), 'auth branch intact')

    const net = explainProviderError(new Error('fetch failed'), CTX)
    assert(/reach|network/i.test(net), 'network branch intact')

    const rate = explainProviderError(new Error('HTTP 429 rate limit'), {
      ...CTX,
      status: 429,
    })
    assert(/rate limit/i.test(rate), 'rate limit branch intact')
  }

  console.log('PASS: status vs body attribution')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
