/**
 * 门槛 3b：provider 错误必须说清「怎么了 + 下一步干嘛」
 *
 * explainProviderError（CX3）本来只覆盖 401 / effort-400 / 404 / model。
 * 而新用户最容易撞上的恰恰不在里面：baseUrl 打错、公司网络出不去、
 * 代理没配、上游 5xx。这些当时一律落到兜底分支，用户看到的就是
 * `error: fetch failed` 四个字母加两个单词。
 *
 * 契约：每条都得回答三个问题——发生了什么、为什么、下一步。
 * 且**绝不泄漏密钥**。
 *
 * 运行：npx tsx scripts/test-provider-error-explain.ts
 */
import { explainProviderError } from '../packages/providers/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const CTX = {
  providerId: 'work',
  kind: 'openai-compatible',
  model: 'gpt-4o-mini',
  baseUrl: 'http://127.0.0.1:9/v1',
}

async function main() {
  // ── 1) 网络不通：最常见的「baseUrl 打错 / 出不去网」 ──
  {
    const out = explainProviderError(new Error('fetch failed'), CTX)
    assert(/hint:/i.test(out), `network error offers a hint:\n${out}`)
    assert(
      /reach|network|connect|offline|proxy/i.test(out),
      `names it as a connectivity problem:\n${out}`,
    )
    assert(
      out.includes('127.0.0.1:9') || /baseUrl/i.test(out),
      `points at the endpoint actually being dialed:\n${out}`,
    )
  }

  for (const raw of [
    'connect ECONNREFUSED 127.0.0.1:9',
    'getaddrinfo ENOTFOUND api.exmaple.com',
    'connect ETIMEDOUT 10.0.0.1:443',
    'request to https://x/v1 failed, reason: socket hang up',
  ]) {
    const out = explainProviderError(new Error(raw), CTX)
    assert(
      /hint:/i.test(out) && /reach|network|connect|proxy|offline/i.test(out),
      `network-class error explained: ${raw}\n${out}`,
    )
  }

  // ── 2) 超时 ──
  {
    const out = explainProviderError(
      new Error('The operation was aborted due to timeout'),
      CTX,
    )
    assert(/hint:/i.test(out), `timeout offers a hint:\n${out}`)
    assert(
      /timeout|timed out|slower|slow/i.test(out),
      `timeout is named as such:\n${out}`,
    )
  }

  // ── 3) 限流：现在会尊重 Retry-After，提示要说清等待 ──
  {
    const out = explainProviderError(
      new Error('OpenAI-compatible HTTP 429: rate limit exceeded'),
      { ...CTX, status: 429 },
    )
    assert(/hint:/i.test(out), `429 offers a hint:\n${out}`)
    assert(
      /rate limit|slow down|wait|retry/i.test(out),
      `429 explains rate limiting:\n${out}`,
    )
    assert(
      /provider use|another provider|switch/i.test(out),
      `429 offers switching providers as a way out:\n${out}`,
    )
  }

  // ── 4) 上游 5xx：不是用户的错，要说出来 ──
  {
    const out = explainProviderError(
      new Error('Anthropic HTTP 503: upstream unavailable'),
      { ...CTX, kind: 'anthropic', status: 503 },
    )
    assert(/hint:/i.test(out), `5xx offers a hint:\n${out}`)
    assert(
      /upstream|provider side|not your|server/i.test(out),
      `5xx makes clear it is upstream, not user error:\n${out}`,
    )
  }

  // ── 5) 回归：既有四类仍然工作 ──
  {
    const auth = explainProviderError(
      new Error('401 Unauthorized invalid api key'),
      { ...CTX, apiKeyEnv: 'WORK_KEY' },
    )
    assert(auth.includes('WORK_KEY'), `401 still names the env var:\n${auth}`)

    const notFound = explainProviderError(new Error('404 Not Found /v1/responses'), CTX)
    assert(
      /provider kind/i.test(notFound),
      `404 still explains kind mismatch:\n${notFound}`,
    )
  }

  // ── 6) 绝不回显密钥 ──
  {
    const leaky =
      'HTTP 401: Incorrect API key provided: sk-proj-ABCDEF1234567890SECRET'
    const out = explainProviderError(new Error(leaky), {
      ...CTX,
      apiKeyEnv: 'WORK_KEY',
    })
    assert(
      !out.includes('sk-proj-ABCDEF1234567890SECRET'),
      `api key must never be echoed back:\n${out}`,
    )
  }

  // ── 7) 兜底仍带上下文，不能是空壳 ──
  {
    const out = explainProviderError(new Error('something odd happened'), CTX)
    assert(
      /provider=work/.test(out),
      `unknown errors still carry provider context:\n${out}`,
    )
  }

  console.log('PASS: provider error explanations')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
