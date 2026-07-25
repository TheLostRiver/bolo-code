/**
 * HookBus — 匹配 + command 执行 + 结果归约
 * 契约见 docs/HOOKS.md
 */

import { spawn } from 'node:child_process'
import {
  HOOK_EVENTS_WITHOUT_MATCHER,
  type AnyHookInput,
  type HookEvent,
  type HooksConfig,
  type PermissionDecision,
} from '../../shared/src/index.ts'

export type HookRunResult = {
  event: HookEvent
  exitCode: number
  stdout: string
  stderr: string
  /** PreToolUse exit 2 等 */
  blocked: boolean
  permissionDecision?: PermissionDecision
  /** PreToolUse exit 0 解析到的 updatedInput */
  updatedInput?: unknown
  /** exit 124 或 aborted 时 true */
  timedOut?: boolean
  aborted?: boolean
}

const noMatcher = new Set<string>(HOOK_EVENTS_WITHOUT_MATCHER)

/** 默认 / 上限（秒）；对照 HC 有 timeout 字段 */
export const DEFAULT_HOOK_TIMEOUT_SEC = 30
export const MAX_HOOK_TIMEOUT_SEC = 600

/**
 * SessionEnd 默认更短（teardown headroom）。
 * 对照 HC ~1500ms；Codex ~1–3s。可用 hook.timeout 覆盖，仍受 MAX 限制。
 */
export const DEFAULT_SESSION_END_TIMEOUT_SEC = 3
export const MAX_SESSION_END_TIMEOUT_SEC = 30

export function clampHookTimeoutSec(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOOK_TIMEOUT_SEC
  return Math.min(MAX_HOOK_TIMEOUT_SEC, Math.max(1, Math.floor(n)))
}

export function clampSessionEndTimeoutSec(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_END_TIMEOUT_SEC
  return Math.min(MAX_SESSION_END_TIMEOUT_SEC, Math.max(1, Math.floor(n)))
}

/** 某事件 command 的有效超时（秒） */
export function effectiveHookTimeoutSec(
  event: HookEvent,
  hookTimeout: unknown,
): number {
  if (event === 'SessionEnd') {
    if (hookTimeout == null || hookTimeout === '') {
      return DEFAULT_SESSION_END_TIMEOUT_SEC
    }
    return clampSessionEndTimeoutSec(hookTimeout)
  }
  return clampHookTimeoutSec(
    hookTimeout == null || hookTimeout === ''
      ? DEFAULT_HOOK_TIMEOUT_SEC
      : hookTimeout,
  )
}

export function shouldIgnoreMatcher(event: HookEvent): boolean {
  return noMatcher.has(event)
}

export function matcherHits(matcher: string, value: string): boolean {
  if (matcher === '*') return true
  if (matcher.endsWith('*')) return value.startsWith(matcher.slice(0, -1))
  return matcher === value
}

export function selectHookGroups(
  event: HookEvent,
  cfg: HooksConfig,
  matchValue?: string,
) {
  const groups = cfg[event] ?? []
  if (shouldIgnoreMatcher(event)) return groups
  if (matchValue == null) return groups
  return groups.filter((g) => !g.matcher || matcherHits(g.matcher, matchValue))
}

function matchValueFor(event: HookEvent, input: AnyHookInput): string | undefined {
  if (shouldIgnoreMatcher(event)) return undefined
  const rec = input as Record<string, unknown>
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest':
      return typeof rec.tool_name === 'string' ? rec.tool_name : undefined
    case 'SessionStart':
      return typeof rec.source === 'string' ? rec.source : undefined
    case 'SessionEnd':
      return typeof rec.reason === 'string' ? rec.reason : undefined
    case 'PreCompact':
    case 'PostCompact':
      return typeof rec.trigger === 'string' ? rec.trigger : undefined
    case 'SubagentStart':
    case 'SubagentStop':
      return typeof rec.agent_type === 'string' ? rec.agent_type : undefined
    default:
      return undefined
  }
}

function parsePermissionDecision(stdout: string): PermissionDecision | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    const json = JSON.parse(text) as {
      hookSpecificOutput?: { decision?: string; permissionDecision?: string }
      decision?: string
    }
    const d =
      json.hookSpecificOutput?.decision ??
      json.hookSpecificOutput?.permissionDecision ??
      json.decision
    if (d === 'allow' || d === 'deny' || d === 'ask') return d
  } catch {
    // ignore non-json
  }
  return undefined
}

/**
 * PreToolUse stdout JSON → updatedInput（对照 HC / Codex）。
 * 接受：
 * - `{ "hookSpecificOutput": { "updatedInput": {...} } }`
 * - `{ "updatedInput": {...} }`
 * - 顶层即为 object（非 array）的 plain rewrite（宽松）
 * 非法 JSON / 非 object → undefined（忽略改写）。
 */
export function parseUpdatedInput(stdout: string): unknown | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    const json = JSON.parse(text) as unknown
    if (json == null || typeof json !== 'object' || Array.isArray(json)) {
      return undefined
    }
    const rec = json as Record<string, unknown>
    const specific = rec.hookSpecificOutput
    if (specific && typeof specific === 'object' && !Array.isArray(specific)) {
      const ui = (specific as Record<string, unknown>).updatedInput
      if (ui !== undefined && ui !== null && typeof ui === 'object') {
        return ui
      }
    }
    if (
      rec.updatedInput !== undefined &&
      rec.updatedInput !== null &&
      typeof rec.updatedInput === 'object'
    ) {
      return rec.updatedInput
    }
    // 宽松：整段 stdout 就是新 input object（且无 hook 元字段）
    if (
      !('hookSpecificOutput' in rec) &&
      !('decision' in rec) &&
      !('permissionDecision' in rec) &&
      !('hookEventName' in rec)
    ) {
      return rec
    }
  } catch {
    // ignore
  }
  return undefined
}

export function runCommandHook(
  command: string,
  input: AnyHookInput,
  timeoutSec = DEFAULT_HOOK_TIMEOUT_SEC,
  signal?: AbortSignal,
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}> {
  const sec = clampHookTimeoutSec(timeoutSec)
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        exitCode: 130,
        stdout: '',
        stderr: 'hook aborted before start',
        timedOut: false,
        aborted: true,
      })
      return
    }

    const child = spawn(command, {
      shell: true,
      cwd: input.cwd,
      env: process.env,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (r: {
      exitCode: number
      stdout: string
      stderr: string
      timedOut: boolean
      aborted: boolean
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        signal?.removeEventListener('abort', onAbort)
      } catch {
        /* ignore */
      }
      resolve(r)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({
        exitCode: 124,
        stdout,
        stderr: stderr + '\nhook timeout',
        timedOut: true,
        aborted: false,
      })
    }, sec * 1000)

    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({
        exitCode: 130,
        stdout,
        stderr: stderr + '\nhook aborted',
        timedOut: false,
        aborted: true,
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })

    child.on('error', (err) => {
      finish({
        exitCode: 1,
        stdout,
        stderr: String(err),
        timedOut: false,
        aborted: false,
      })
    })

    child.on('close', (code) => {
      // timeout/abort 已 settle 时忽略 close
      if (settled) return
      finish({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut: false,
        aborted: false,
      })
    })

    try {
      child.stdin?.write(JSON.stringify(input))
      child.stdin?.end()
    } catch {
      // ignore broken pipe
    }
  })
}

export type AggregatedHookResult = {
  results: HookRunResult[]
  blocked: boolean
  blockReason: string
  permissionDecision?: PermissionDecision
  /**
   * PreToolUse exit 0：最后一个有效 updatedInput 覆盖（对照 Codex last-wins）
   */
  updatedInput?: unknown
  /**
   * exit 0 stdout 可注入（UserPromptSubmit / SessionStart / PreCompact /
   * SubagentStart）
   */
  injectText: string
  /**
   * Stop / SubagentStop exit 2：续跑提示（stderr 优先）
   * PostToolUse exit 2：立即给模型的反馈
   */
  continuationText: string
  /** 是否因 AbortSignal 提前结束 */
  aborted: boolean
}

export type RunHooksOptions = {
  /** 会话/工具取消时中止后续 hook 与当前 command */
  signal?: AbortSignal
  /**
   * 覆盖默认超时（秒）。SessionEnd 调用方可传短超时；
   * 仍会经 effectiveHookTimeoutSec / clamp。
   */
  defaultTimeoutSec?: number
}

function pickContinuationText(stderr: string, stdout: string): string {
  const err = stderr.replace(/\nhook (timeout|aborted)\s*$/i, '').trim()
  if (err) return err
  return stdout.trim()
}

export async function runHooks(
  event: HookEvent,
  input: AnyHookInput,
  cfg: HooksConfig,
  options?: RunHooksOptions,
): Promise<AggregatedHookResult> {
  const matchValue = matchValueFor(event, input)
  const groups = selectHookGroups(event, cfg, matchValue)
  const results: HookRunResult[] = []
  let blocked = false
  let blockReason = ''
  let permissionDecision: PermissionDecision | undefined
  let updatedInput: unknown | undefined
  const injectParts: string[] = []
  const continuationParts: string[] = []
  let aborted = false
  const signal = options?.signal

  outer: for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.type !== 'command') continue
      if (signal?.aborted) {
        aborted = true
        break outer
      }
      const timeoutSec = effectiveHookTimeoutSec(
        event,
        hook.timeout ?? options?.defaultTimeoutSec,
      )
      const { exitCode, stdout, stderr, timedOut, aborted: hookAborted } =
        await runCommandHook(hook.command, input, timeoutSec, signal)
      if (hookAborted) aborted = true

      const row: HookRunResult = {
        event,
        exitCode,
        stdout,
        stderr,
        blocked: false,
        ...(timedOut ? { timedOut: true } : {}),
        ...(hookAborted ? { aborted: true } : {}),
      }

      if (event === 'PreToolUse' && exitCode === 2) {
        row.blocked = true
        blocked = true
        blockReason = stderr || 'PreToolUse blocked'
      }
      if (event === 'UserPromptSubmit' && exitCode === 2) {
        row.blocked = true
        blocked = true
        blockReason = stderr || 'UserPromptSubmit blocked'
      }
      if (event === 'PreCompact' && exitCode === 2) {
        row.blocked = true
        blocked = true
        blockReason = stderr || 'PreCompact blocked'
      }
      // Stop / SubagentStop exit 2：不结束对话，续跑
      if (
        (event === 'Stop' || event === 'SubagentStop') &&
        exitCode === 2
      ) {
        row.blocked = true
        blocked = true
        const text =
          pickContinuationText(stderr, stdout) ||
          `${event} hook requested continuation`
        blockReason = text
        continuationParts.push(text)
      }
      // PostToolUse exit 2：立即给模型
      if (event === 'PostToolUse' && exitCode === 2) {
        const text =
          pickContinuationText(stderr, stdout) ||
          'PostToolUse hook feedback'
        continuationParts.push(text)
      }
      if (event === 'PermissionRequest' && exitCode === 0) {
        const d = parsePermissionDecision(stdout)
        if (d) {
          row.permissionDecision = d
          // 最后一个有效决策覆盖
          permissionDecision = d
        }
      }
      // H4：PreToolUse exit 0 → updatedInput（后写覆盖）
      if (event === 'PreToolUse' && exitCode === 0) {
        const ui = parseUpdatedInput(stdout)
        if (ui !== undefined) {
          row.updatedInput = ui
          updatedInput = ui
        }
      }
      if (
        (event === 'UserPromptSubmit' ||
          event === 'SessionStart' ||
          event === 'PreCompact' ||
          event === 'SubagentStart') &&
        exitCode === 0 &&
        stdout.trim()
      ) {
        injectParts.push(stdout.trim())
      }

      results.push(row)
      if (hookAborted) break outer
      if (blocked && (event === 'PreToolUse' || event === 'UserPromptSubmit')) {
        return {
          results,
          blocked,
          blockReason,
          permissionDecision,
          ...(updatedInput !== undefined ? { updatedInput } : {}),
          injectText: injectParts.join('\n'),
          continuationText: continuationParts.join('\n'),
          aborted,
        }
      }
    }
  }

  return {
    results,
    blocked,
    blockReason,
    permissionDecision,
    ...(updatedInput !== undefined ? { updatedInput } : {}),
    injectText: injectParts.join('\n'),
    continuationText: continuationParts.join('\n'),
    aborted,
  }
}

export { HOOK_EVENTS_WITHOUT_MATCHER }