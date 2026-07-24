/**
 * Auto 权限分类器（Y2 单阶段）
 * 对照 HC yoloClassifier 语义：侧路模型决策 allow/deny；失败 deny。
 * 无遥测、无两阶段（Y4）、无 GrowthBook。
 */

import type { ChatMessage } from '../../shared/src/index.ts'

export type AutoClassifyInput = {
  toolName: string
  toolInput: unknown
  cwd: string
  /** 近期对话摘要（截断） */
  recentSummary?: string
  userRulesHint?: string
}

export type AutoClassifyResult =
  | {
      decision: 'allow' | 'deny'
      reason: string
      model?: string
      durationMs?: number
      unavailable?: false
    }
  | {
      decision: 'deny'
      reason: string
      unavailable: true
      durationMs?: number
    }

export type AutoClassifyFn = (
  input: AutoClassifyInput,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<AutoClassifyResult>

export const DEFAULT_AUTO_CLASSIFY_TIMEOUT_MS = 20_000

/** 分类器 system 提示（精炼；对照 HC 安全评估意图） */
export function buildAutoClassifierSystemPrompt(): string {
  return `You are a security permission classifier for a coding agent.
Decide whether a single tool invocation is SAFE to auto-approve.

Reply with ONLY a single JSON object (no markdown fences):
{"decision":"allow"|"deny","reason":"<short English reason>"}

Rules:
- Allow: read-only inspection, safe listing, non-destructive workspace edits that match user intent.
- Deny: destructive shell (rm -rf, disk wipe, curl|sh), secrets exfiltration, privilege escalation, path escape outside project, ambiguous high-risk commands.
- When unsure, deny.
- Do not include any other keys or text.`
}

export function buildAutoClassifierUserPrompt(input: AutoClassifyInput): string {
  const payload = {
    toolName: input.toolName,
    cwd: input.cwd,
    toolInput: input.toolInput,
    recentSummary: (input.recentSummary ?? '').slice(0, 4000),
    userRulesHint: (input.userRulesHint ?? '').slice(0, 1000),
  }
  return `Classify this tool call:\n${JSON.stringify(payload, null, 2)}`
}

/**
 * 从模型文本解析 decision；失败返回 null。
 */
export function parseAutoClassifierResponse(text: string): {
  decision: 'allow' | 'deny'
  reason: string
} | null {
  const raw = text.trim()
  if (!raw) return null
  // 剥 markdown fence
  let body = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) body = fence[1].trim()
  // 取第一个 {...}
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as {
      decision?: string
      reason?: string
    }
    const d = (o.decision ?? '').toLowerCase()
    if (d !== 'allow' && d !== 'deny') return null
    const reason =
      typeof o.reason === 'string' && o.reason.trim()
        ? o.reason.trim().slice(0, 500)
        : d === 'allow'
          ? 'classifier allow'
          : 'classifier deny'
    return { decision: d, reason }
  } catch {
    return null
  }
}

export function buildClassifierMessages(input: AutoClassifyInput): ChatMessage[] {
  return [
    { role: 'system', content: buildAutoClassifierSystemPrompt() },
    { role: 'user', content: buildAutoClassifierUserPrompt(input) },
  ]
}

/**
 * 用 completeText 侧路调用做分类。
 */
export function createAutoClassifyFromCompleteText(
  completeText: (
    messages: ChatMessage[],
    options?: { signal?: AbortSignal },
  ) => Promise<string>,
  opts?: { model?: string },
): AutoClassifyFn {
  return async (input, options) => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_AUTO_CLASSIFY_TIMEOUT_MS
    const started = Date.now()
    const controller = new AbortController()
    const onParent = () => controller.abort()
    options?.signal?.addEventListener('abort', onParent, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const text = await completeText(buildClassifierMessages(input), {
        signal: controller.signal,
      })
      const parsed = parseAutoClassifierResponse(text)
      const durationMs = Date.now() - started
      if (!parsed) {
        return {
          decision: 'deny',
          reason: 'invalid classifier response',
          unavailable: true,
          durationMs,
        }
      }
      return {
        decision: parsed.decision,
        reason: parsed.reason,
        model: opts?.model,
        durationMs,
      }
    } catch (e) {
      const durationMs = Date.now() - started
      const msg = e instanceof Error ? e.message : String(e)
      const aborted =
        options?.signal?.aborted ||
        controller.signal.aborted ||
        /abort/i.test(msg)
      return {
        decision: 'deny',
        reason: aborted ? `classifier timeout/abort: ${msg}` : `classifier error: ${msg}`,
        unavailable: true,
        durationMs,
      }
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onParent)
    }
  }
}