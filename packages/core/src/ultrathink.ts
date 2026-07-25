/**
 * CX8 ultrathink — 产品糖（默认 off）
 *
 * - off：无
 * - tip：检测到关键词 → 提示 /effort high，不改状态
 * - turn：仅本轮 effectiveEffort 抬向 high；不写 session.effortLevel
 *
 * 无遥测。见 docs/PROVIDER_UX.md §CX8
 */

import {
  assertEffortChoosable,
  detectEffortDialectId,
  listEffortChoosable,
} from '../../providers/src/effortDialect.ts'

export type UltrathinkMode = 'off' | 'tip' | 'turn'

/** 本 turn 抬档目标（HC 语义：high，非 API ultra 字面量） */
export const ULTRATHINK_TARGET_EFFORT = 'high' as const

/** 用户文本中的触发词（词边界；大小写不敏感） */
const ULTRATHINK_RE = /\bultrathink\b/i

/** 已达 high 及以上时不再压低（boost-only） */
const ALREADY_HIGH_OR_ABOVE = new Set([
  'high',
  'xhigh',
  'max',
  'ultra',
])

export type UltrathinkSessionLike = {
  ultrathinkMode?: UltrathinkMode
  effortLevel?: string
  effortDialect?: string | Record<string, unknown>
  model?: string
  provider?: { id?: string }
  providerProfile?: {
    effortDialect?: string | Record<string, unknown>
    baseUrl?: string
    model?: string
  }
}

export type ResolveUltrathinkModeInput = {
  /** 会话 slash 覆盖 */
  sessionMode?: UltrathinkMode | string | null
  /** config.ultrathink */
  configMode?: UltrathinkMode | string | null
  /** 默认读 process.env.BOLO_ULTRATHINK */
  env?: NodeJS.ProcessEnv
}

/**
 * 优先级：session slash > env BOLO_ULTRATHINK > config > off
 */
export function resolveUltrathinkMode(
  input: ResolveUltrathinkModeInput = {},
): UltrathinkMode {
  const fromSession = normalizeUltrathinkMode(input.sessionMode)
  if (fromSession) return fromSession

  const env = input.env ?? process.env
  const fromEnv = normalizeUltrathinkMode(env.BOLO_ULTRATHINK)
  if (fromEnv) return fromEnv

  const fromConfig = normalizeUltrathinkMode(input.configMode)
  if (fromConfig) return fromConfig

  return 'off'
}

export function normalizeUltrathinkMode(
  raw: string | null | undefined,
): UltrathinkMode | undefined {
  if (raw == null) return undefined
  const t = String(raw).trim().toLowerCase()
  if (!t) return undefined
  if (t === 'off' || t === '0' || t === 'false' || t === 'no' || t === 'disabled') {
    return 'off'
  }
  if (t === 'tip' || t === 'hint' || t === 'suggest') return 'tip'
  // env 真值 / turn → 本轮抬档；tip 必须显式写 tip
  if (
    t === 'turn' ||
    t === 'once' ||
    t === 'this-turn' ||
    t === '1' ||
    t === 'true' ||
    t === 'on'
  ) {
    return 'turn'
  }
  return undefined
}

export function textHasUltrathink(text: string): boolean {
  return ULTRATHINK_RE.test(String(text ?? ''))
}

function resolveDialect(session: UltrathinkSessionLike) {
  return (
    session.effortDialect ??
    session.providerProfile?.effortDialect ??
    detectEffortDialectId({
      kind: session.provider?.id,
      baseUrl: session.providerProfile?.baseUrl,
      model: session.model ?? session.providerProfile?.model,
    })
  )
}

export type UltrathinkTurnPlan = {
  /** 是否在用户文本中检测到 ultrathink */
  detected: boolean
  mode: UltrathinkMode
  /**
   * 本轮 callModel 使用的 effort（仅 turn 且成功抬档时有值）。
   * undefined = 沿用 session.effortLevel（含 auto）。
   */
  effectiveEffort?: string
  /** 是否实际改了本轮 effective（相对 session） */
  boosted: boolean
  /** CLI/Desktop 可见一行；无遥测 */
  notice?: string
}

/**
 * 在 submitPrompt 入模前调用。
 * **不**修改 session.effortLevel。
 */
export function planUltrathinkTurn(
  session: UltrathinkSessionLike,
  userText: string,
  opts?: {
    mode?: UltrathinkMode
    configMode?: string | null
    env?: NodeJS.ProcessEnv
  },
): UltrathinkTurnPlan {
  const mode =
    opts?.mode ??
    resolveUltrathinkMode({
      sessionMode: session.ultrathinkMode,
      configMode: opts?.configMode,
      env: opts?.env,
    })

  const detected = textHasUltrathink(userText)
  if (!detected || mode === 'off') {
    return { detected, mode, boosted: false }
  }

  if (mode === 'tip') {
    return {
      detected: true,
      mode: 'tip',
      boosted: false,
      notice:
        'ultrathink detected → tip only (default sugar is off). Use `/effort high` to raise session effort, or set `ultrathink: "turn"` / `BOLO_ULTRATHINK=turn` for this-turn boost.',
    }
  }

  // mode === 'turn'
  const dialect = resolveDialect(session)
  const model = session.model ?? session.providerProfile?.model
  const current = session.effortLevel?.trim().toLowerCase()

  if (current && ALREADY_HIGH_OR_ABOVE.has(current)) {
    return {
      detected: true,
      mode: 'turn',
      boosted: false,
      effectiveEffort: current,
      notice: `ultrathink → keep ${current} (already ≥ high; this turn; session effort unchanged)`,
    }
  }

  const check = assertEffortChoosable(
    dialect as string | undefined,
    ULTRATHINK_TARGET_EFFORT,
    { isAgent: true, model },
  )

  if (!check.ok) {
    const choosable = listEffortChoosable(dialect as string | undefined, {
      isAgent: true,
      model,
    })
    return {
      detected: true,
      mode: 'turn',
      boosted: false,
      notice:
        `ultrathink → high blocked: ${check.reason}` +
        (choosable.length ? ` (choosable: ${choosable.join(', ')})` : ''),
    }
  }

  return {
    detected: true,
    mode: 'turn',
    boosted: true,
    effectiveEffort: check.intent,
    notice: `ultrathink → ${check.intent} (this turn; session effort unchanged)`,
  }
}

export function formatUltrathinkStatus(mode: UltrathinkMode): string {
  const lines = [
    `ultrathink:      ${mode}`,
    `  off  — default; keyword ignored`,
    `  tip  — detect "ultrathink" → hint /effort high (no state change)`,
    `  turn — detect → this-turn effective effort → high (not session.effortLevel)`,
    `config: ultrathink / env BOLO_ULTRATHINK=off|tip|turn`,
    `target: ${ULTRATHINK_TARGET_EFFORT} · must pass choosable ∩ caps · no telemetry`,
  ]
  return lines.join('\n')
}