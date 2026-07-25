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
  status?: number
  /** 原始错误字符串（可截断） */
  raw?: string
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

  const head = clip(raw, 240)
  if (head) lines.push(head)

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