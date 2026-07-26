/**
 * CX3：可行动 provider 错误解释（无密钥、无遥测）。
 * 见 docs/PROVIDER_UX.md
 */

import {
  listEffortChoosable,
  resolveEffortDialect,
  type EffortDialect,
} from './effortDialect.ts'

export type ProviderErrorContext = {
  providerId?: string
  kind?: string
  model?: string
  effortLevel?: string
  dialect?: string | EffortDialect | null
  apiKeyEnv?: string
  /** 实际拨号的端点；网络类错误里最值钱的一条信息 */
  baseUrl?: string
  status?: number
  /** 原始错误字符串（可截断） */
  raw?: string
}

/**
 * 抹掉可能被上游原样回显的密钥。
 * 错误文案会进终端、也可能被用户贴进 issue —— 绝不能把 key 带出去。
 */
function redactSecrets(s: string): string {
  return s
    .replace(/(sk|pk|api|key)[-_][A-Za-z0-9_-]{8,}/gi, '<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>')
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  return t.slice(0, n - 1) + '…'
}

function extractStatus(raw: string): number | undefined {
  const m =
    raw.match(/\bstatus(?:Code)?[=:\s]+(\d{3})\b/i) ||
    raw.match(/\bHTTP\s+(\d{3})\b/i) ||
    raw.match(/\b(\d{3})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found)/i)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/**
 * 把上游/本地错误变成「下一步怎么修」文案。
 */
export function explainProviderError(
  err: unknown,
  ctx: ProviderErrorContext = {},
): string {
  const raw =
    ctx.raw?.trim() ||
    (err instanceof Error ? err.message : typeof err === 'string' ? err : String(err))
  const lower = raw.toLowerCase()
  const status = ctx.status ?? extractStatus(raw)
  const lines: string[] = []

  const head = clip(redactSecrets(raw), 240)
  if (head) lines.push(head)

  // 网络够不着：baseUrl 打错、出不去网、代理没配。
  // 这是新用户最容易撞上的一类，却最容易只看到 "fetch failed" 三个字。
  if (
    /fetch failed|econnrefused|enotfound|eai_again|econnreset|ehostunreach|enetunreach|socket hang up|network|tunneling socket|self.signed certificate|unable to verify/i.test(
      raw,
    )
  ) {
    lines.push(
      `hint: could not reach the provider${ctx.baseUrl ? ` at ${ctx.baseUrl}` : ''} — the request never got a response`,
    )
    lines.push(
      'hint: check baseUrl for typos · confirm you are online · if behind a proxy set HTTPS_PROXY',
    )
    if (ctx.providerId) {
      lines.push(`hint: or switch backend with /provider use <other>`)
    }
    return lines.join('\n')
  }

  // 超时：请求发出去了但没等到
  if (
    /timed?\s*out|etimedout|aborted due to timeout|deadline exceeded/i.test(raw)
  ) {
    lines.push(
      'hint: the provider did not answer in time — the request may still have been charged',
    )
    lines.push(
      'hint: retry · try a smaller request · or raise timeoutMs in the provider config',
    )
    return lines.join('\n')
  }

  // 限流：现在会尊重 Retry-After，但仍要告诉用户还能干嘛
  if (status === 429 || /rate.?limit|too many requests|quota/i.test(raw)) {
    lines.push(
      'hint: rate limited — Bolo waits for the delay the provider asks for, then retries',
    )
    lines.push(
      'hint: if it keeps happening, slow down, raise your plan limits, or switch backend with /provider use <other>',
    )
    return lines.join('\n')
  }

  // model 找不到 —— **必须排在 5xx 之前**。
  //
  // 中转/网关常把配置错误包在语义不符的状态码里：实测见过
  // `HTTP 503 + {"code":"model_not_found","message":"…无可用渠道…"}`。
  // 只看状态码就会回「这是上游问题，不是你的配置」，把人往反方向指——
  // 比不给提示更糟。body 优先于 status。
  if (
    // 「无可用渠道」是中转的常见说法，独立成条：它表示这个 model 在该端点
    // 没有可路由的通道，属于配置/选型问题，不是临时故障
    /model_not_found|model.{0,20}(not found|does not exist|not available)|no available channel|无可用渠道/i.test(
      raw,
    )
  ) {
    lines.push(
      `hint: the endpoint does not have model${ctx.model ? ` "${ctx.model}"` : ''} — despite the status code, this is a configuration problem, not an outage`,
    )
    lines.push(
      'hint: check the model name with /model, or list what this endpoint offers (GET /models)',
    )
    if (ctx.providerId) {
      lines.push(`hint: or switch backend with /provider use <other>`)
    }
    return lines.join('\n')
  }

  // 上游 5xx：不是用户的错，明说，免得他去乱改配置
  if (status !== undefined && status >= 500 && status < 600) {
    lines.push(
      `hint: the provider returned a server error (${status}) — this is upstream, not a problem with your setup`,
    )
    lines.push('hint: retry shortly · or switch backend with /provider use <other>')
    return lines.join('\n')
  }

  // 缺 key
  if (
    /missing api key|api key|unauthorized|401|invalid.?api.?key|authentication/i.test(
      raw,
    ) ||
    status === 401
  ) {
    const env =
      ctx.apiKeyEnv ||
      (ctx.kind === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : ctx.providerId?.includes('deepseek')
          ? 'DEEPSEEK_API_KEY'
          : 'OPENAI_API_KEY / BOLO_API_KEY')
    lines.push(
      `hint: set env ${env}` +
        (ctx.providerId ? ` · or /provider use <other>` : ''),
    )
    return lines.join('\n')
  }

  // effort / reasoning 类 400
  const effortish =
    /effort|reasoning_effort|output_config|reasoning\.effort|unsupported.*effort|invalid.*effort/i.test(
      raw,
    ) ||
    (status === 400 &&
      /reasoning|thinking|max_tokens|output_config/i.test(raw))

  if (effortish || (status === 400 && ctx.effortLevel)) {
    try {
      const choosable = listEffortChoosable(ctx.dialect, {
        model: ctx.model,
        isAgent: true,
      })
      if (choosable.length) {
        lines.push(`hint: choosable efforts: ${choosable.join(', ')}`)
      }
      lines.push(
        'hint: try /effort list · /effort high · or BOLO_EFFORT_LOOSE=1 for fold aliases',
      )
      if (/max/i.test(raw) || ctx.effortLevel === 'max') {
        lines.push(
          'hint: anthropic max may need opus-4.6+ or BOLO_EFFORT_ALLOW_MAX=1',
        )
      }
    } catch {
      lines.push('hint: check /effort list for current dialect')
    }
    return lines.join('\n')
  }

  // kind / 端点疑错
  if (
    /not found|404|unknown endpoint|\/responses|\/chat\/completions|\/messages/i.test(
      raw,
    ) ||
    status === 404
  ) {
    lines.push(
      'hint: check provider kind — openai-compatible (chat/completions) · openai-responses (/responses) · anthropic (/v1/messages)',
    )
    if (ctx.providerId) {
      lines.push(`hint: /provider use ${ctx.providerId} or /provider list`)
    }
    return lines.join('\n')
  }

  // model
  if (/model|does not exist|not support/i.test(lower) && status === 404) {
    lines.push(
      `hint: check model${ctx.model ? ` "${ctx.model}"` : ''} · /model <name>`,
    )
  }

  if (ctx.providerId || ctx.kind) {
    lines.push(
      `context: provider=${ctx.providerId ?? '(unset)'} kind=${ctx.kind ?? '?'} model=${ctx.model ?? '(unset)'}`,
    )
  }

  // dialect 一行（可选）
  try {
    const d = resolveEffortDialect(ctx.dialect)
    if (d.id) {
      lines.push(`dialect: ${d.id}`)
    }
  } catch {
    /* ignore */
  }

  return lines.join('\n')
}