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
  /** exit 124 或 aborted 时 true */
  timedOut?: boolean
  aborted?: boolean
}

const noMatcher = new Set<string>(HOOK_EVENTS_WITHOUT_MATCHER)

/** 默认 / 上限（秒）；对照 HC 有 timeout 字段 */
export const DEFAULT_HOOK_TIMEOUT_SEC = 30
export const MAX_HOOK_TIMEOUT_SEC = 600

export function clampHookTimeoutSec(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOOK_TIMEOUT_SEC
  return Math.min(MAX_HOOK_TIMEOUT_SEC, Math.max(1, Math.floor(n)))
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
      hookSpecificOutput?: { decision?: string }
      decision?: string
    }
    const d = json.hookSpecificOutput?.decision ?? json.decision
    if (d === 'allow' || d === 'deny' || d === 'ask') return d
  } catch {
    // ignore non-json
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
  /** UserPromptSubmit exit 0 stdout 可注入 */
  injectText: string
  /** 是否因 AbortSignal 提前结束 */
  aborted: boolean
}

export type RunHooksOptions = {
  /** 会话/工具取消时中止后续 hook 与当前 command */
  signal?: AbortSignal
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
  const injectParts: string[] = []
  let aborted = false
  const signal = options?.signal

  outer: for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.type !== 'command') continue
      if (signal?.aborted) {
        aborted = true
        break outer
      }
      const { exitCode, stdout, stderr, timedOut, aborted: hookAborted } =
        await runCommandHook(
          hook.command,
          input,
          hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SEC,
          signal,
        )
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
      if (event === 'PermissionRequest' && exitCode === 0) {
        const d = parsePermissionDecision(stdout)
        if (d) {
          row.permissionDecision = d
          // 最后一个有效决策覆盖
          permissionDecision = d
        }
      }
      if (
        (event === 'UserPromptSubmit' ||
          event === 'SessionStart' ||
          event === 'PreCompact') &&
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
          injectText: injectParts.join('\n'),
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
    injectText: injectParts.join('\n'),
    aborted,
  }
}

export { HOOK_EVENTS_WITHOUT_MATCHER }