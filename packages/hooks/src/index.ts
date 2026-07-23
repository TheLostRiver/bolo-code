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
}

const noMatcher = new Set<string>(HOOK_EVENTS_WITHOUT_MATCHER)

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
  timeoutSec = 30,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: input.cwd,
      env: process.env,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ exitCode: 124, stdout, stderr: stderr + '\nhook timeout' })
    }, timeoutSec * 1000)

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: 1, stdout, stderr: String(err) })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr })
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
}

export async function runHooks(
  event: HookEvent,
  input: AnyHookInput,
  cfg: HooksConfig,
): Promise<AggregatedHookResult> {
  const matchValue = matchValueFor(event, input)
  const groups = selectHookGroups(event, cfg, matchValue)
  const results: HookRunResult[] = []
  let blocked = false
  let blockReason = ''
  let permissionDecision: PermissionDecision | undefined
  const injectParts: string[] = []

  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.type !== 'command') continue
      const { exitCode, stdout, stderr } = await runCommandHook(
        hook.command,
        input,
        hook.timeout ?? 30,
      )

      const row: HookRunResult = {
        event,
        exitCode,
        stdout,
        stderr,
        blocked: false,
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
      if (blocked && (event === 'PreToolUse' || event === 'UserPromptSubmit')) {
        return {
          results,
          blocked,
          blockReason,
          permissionDecision,
          injectText: injectParts.join('\n'),
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
  }
}

export { HOOK_EVENTS_WITHOUT_MATCHER }