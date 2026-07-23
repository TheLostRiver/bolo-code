/**
 * HookBus 骨架 — 实现见 docs/HOOKS.md
 */

import {
  HOOK_EVENTS_WITHOUT_MATCHER,
  type HookBaseInput,
  type HookEvent,
  type HooksConfig,
} from '@bolo/shared'

export type HookRunResult = {
  event: HookEvent
  exitCode: number
  stdout: string
  stderr: string
  blocked: boolean
}

const noMatcher = new Set<string>(HOOK_EVENTS_WITHOUT_MATCHER)

export function shouldIgnoreMatcher(event: HookEvent): boolean {
  return noMatcher.has(event)
}

/**
 * 选出应执行的 hook 组（尚未真正 spawn 进程）
 */
export function selectHookGroups(event: HookEvent, cfg: HooksConfig, matchValue?: string) {
  const groups = cfg[event] ?? []
  if (shouldIgnoreMatcher(event)) return groups
  if (matchValue == null) return groups
  return groups.filter((g) => !g.matcher || matcherHits(g.matcher, matchValue))
}

export function matcherHits(matcher: string, value: string): boolean {
  if (matcher === '*') return true
  if (matcher.endsWith('*')) return value.startsWith(matcher.slice(0, -1))
  return matcher === value
}

export async function runHooksPlaceholder(
  event: HookEvent,
  _input: HookBaseInput,
  cfg: HooksConfig,
  matchValue?: string,
): Promise<HookRunResult[]> {
  const groups = selectHookGroups(event, cfg, matchValue)
  // v0：只返回将执行的数量，不 spawn
  return groups.flatMap((g) =>
    g.hooks.map(() => ({
      event,
      exitCode: 0,
      stdout: '',
      stderr: '',
      blocked: false,
    })),
  )
}

export { HOOK_EVENTS_WITHOUT_MATCHER }