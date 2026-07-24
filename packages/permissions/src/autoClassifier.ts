/**
 * Auto 权限分类器（Y2 单阶段 + Y4 两阶段）
 * 对照 HC yoloClassifier：侧路模型决策；fast 否决 / deep 再评；失败 deny。
 * 无遥测、无 GrowthBook。
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
      /** Y4：fast | deep | single */
      stage?: 'fast' | 'deep' | 'single'
    }
  | {
      decision: 'deny'
      reason: string
      unavailable: true
      durationMs?: number
      stage?: 'fast' | 'deep' | 'single'
    }

export type AutoClassifyFn = (
  input: AutoClassifyInput,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<AutoClassifyResult>

export const DEFAULT_AUTO_CLASSIFY_TIMEOUT_MS = 20_000

/** Y4.2 分类器上下文上限（字符，非 tokenizer） */
export const MAX_CLASSIFIER_SUMMARY_CHARS = 2_500
export const MAX_CLASSIFIER_INPUT_JSON_CHARS = 2_000
export const MAX_CLASSIFIER_RULES_HINT_CHARS = 500

/** 分类器 system 提示（deep / single） */
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

/** Y4.1 fast stage：更短、更严（宁可 deny） */
export function buildAutoClassifierFastSystemPrompt(): string {
  return `You are a FAST security screen for a coding agent tool call.
Reply ONLY JSON: {"decision":"allow"|"deny","reason":"<short>"}
Deny anything destructive, network-pipe-to-shell, privilege escalation, or unclear.
Only allow if clearly safe (e.g. simple echo, list files, non-destructive).
When unsure, deny.`
}

export function truncateForClassifier(
  text: string,
  maxChars: number,
): string {
  const t = text ?? ''
  if (t.length <= maxChars) return t
  return `${t.slice(0, maxChars)}…`
}

export function serializeToolInputForClassifier(toolInput: unknown): unknown {
  try {
    const s = JSON.stringify(toolInput ?? {})
    if (s.length <= MAX_CLASSIFIER_INPUT_JSON_CHARS) {
      return toolInput ?? {}
    }
    return {
      _truncated: true,
      preview: s.slice(0, MAX_CLASSIFIER_INPUT_JSON_CHARS),
    }
  } catch {
    return { _error: 'unserializable' }
  }
}

export function buildAutoClassifierUserPrompt(
  input: AutoClassifyInput,
  opts?: { includeSummary?: boolean },
): string {
  const includeSummary = opts?.includeSummary !== false
  const payload: Record<string, unknown> = {
    toolName: input.toolName,
    cwd: input.cwd,
    toolInput: serializeToolInputForClassifier(input.toolInput),
  }
  if (includeSummary) {
    payload.recentSummary = truncateForClassifier(
      input.recentSummary ?? '',
      MAX_CLASSIFIER_SUMMARY_CHARS,
    )
    payload.userRulesHint = truncateForClassifier(
      input.userRulesHint ?? '',
      MAX_CLASSIFIER_RULES_HINT_CHARS,
    )
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
  let body = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) body = fence[1].trim()
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

export function buildClassifierMessages(
  input: AutoClassifyInput,
  opts?: { stage?: 'fast' | 'deep' | 'single' },
): ChatMessage[] {
  const stage = opts?.stage ?? 'single'
  if (stage === 'fast') {
    return [
      { role: 'system', content: buildAutoClassifierFastSystemPrompt() },
      {
        role: 'user',
        content: buildAutoClassifierUserPrompt(input, {
          includeSummary: false,
        }),
      },
    ]
  }
  return [
    { role: 'system', content: buildAutoClassifierSystemPrompt() },
    {
      role: 'user',
      content: buildAutoClassifierUserPrompt(input, { includeSummary: true }),
    },
  ]
}

type CompleteTextFn = (
  messages: ChatMessage[],
  options?: { signal?: AbortSignal },
) => Promise<string>

async function runOneStage(
  completeText: CompleteTextFn,
  messages: ChatMessage[],
  signal: AbortSignal,
  model: string | undefined,
  stage: 'fast' | 'deep' | 'single',
  started: number,
): Promise<AutoClassifyResult> {
  try {
    const text = await completeText(messages, { signal })
    const parsed = parseAutoClassifierResponse(text)
    const durationMs = Date.now() - started
    if (!parsed) {
      return {
        decision: 'deny',
        reason: 'invalid classifier response',
        unavailable: true,
        durationMs,
        stage,
      }
    }
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      model,
      durationMs,
      stage,
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    const aborted = signal.aborted || /abort/i.test(msg)
    return {
      decision: 'deny',
      reason: aborted
        ? `classifier timeout/abort: ${msg}`
        : `classifier error: ${msg}`,
      unavailable: true,
      durationMs,
      stage,
    }
  }
}

/**
 * 用 completeText 侧路调用做分类。
 * @param opts.twoStage Y4 默认 true：fast 否决后不再 deep；fast allow 再 deep 确认
 */
export function createAutoClassifyFromCompleteText(
  completeText: CompleteTextFn,
  opts?: { model?: string; twoStage?: boolean },
): AutoClassifyFn {
  const twoStage = opts?.twoStage !== false
  return async (input, options) => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_AUTO_CLASSIFY_TIMEOUT_MS
    const started = Date.now()
    const controller = new AbortController()
    const onParent = () => controller.abort()
    options?.signal?.addEventListener('abort', onParent, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      if (!twoStage) {
        return await runOneStage(
          completeText,
          buildClassifierMessages(input, { stage: 'single' }),
          controller.signal,
          opts?.model,
          'single',
          started,
        )
      }

      // Stage 1 fast：deny 即终局（否决）
      const fast = await runOneStage(
        completeText,
        buildClassifierMessages(input, { stage: 'fast' }),
        controller.signal,
        opts?.model,
        'fast',
        started,
      )
      if (fast.unavailable) return fast
      if (fast.decision === 'deny') {
        return {
          ...fast,
          reason: `fast: ${fast.reason}`,
          stage: 'fast',
        }
      }

      // Stage 2 deep：确认 allow（对照 HC stage2）
      if (controller.signal.aborted) {
        return {
          decision: 'deny',
          reason: 'classifier aborted before deep stage',
          unavailable: true,
          durationMs: Date.now() - started,
          stage: 'deep',
        }
      }
      const deep = await runOneStage(
        completeText,
        buildClassifierMessages(input, { stage: 'deep' }),
        controller.signal,
        opts?.model,
        'deep',
        started,
      )
      if (deep.unavailable) return deep
      return {
        ...deep,
        reason: `deep: ${deep.reason}`,
        stage: 'deep',
      }
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onParent)
    }
  }
}