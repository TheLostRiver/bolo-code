/**
 * Hooks 硬化 + S8 子权限不升级
 * 运行：node --import tsx/esm scripts/test-hooks-s8.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runCommandHook,
  runHooks,
  clampHookTimeoutSec,
  DEFAULT_HOOK_TIMEOUT_SEC,
} from '../packages/hooks/src/index.ts'
import {
  resolveSubagentPermissionMode,
  permissionModeRank,
} from '../packages/permissions/src/index.ts'
import type { HooksConfig } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  assert(clampHookTimeoutSec(0) === DEFAULT_HOOK_TIMEOUT_SEC, 'clamp 0')
  assert(clampHookTimeoutSec(9999) === 600, 'clamp max')
  assert(clampHookTimeoutSec(5) === 5, 'clamp 5')

  // timeout
  const slowCmd =
    process.platform === 'win32'
      ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 5"'
      : 'sleep 5'
  const t0 = Date.now()
  const timed = await runCommandHook(
    slowCmd,
    {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    },
    1,
  )
  const elapsed = Date.now() - t0
  assert(timed.exitCode === 124, `timeout exit ${timed.exitCode}`)
  assert(timed.timedOut === true, 'timedOut flag')
  assert(elapsed < 4000, `timeout fast enough: ${elapsed}ms`)

  // abort
  const ac = new AbortController()
  const p = runCommandHook(
    slowCmd,
    {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    },
    30,
    ac.signal,
  )
  setTimeout(() => ac.abort(), 50)
  const ab = await p
  assert(ab.aborted === true, 'aborted flag')
  assert(ab.exitCode === 130, `abort exit ${ab.exitCode}`)

  // runHooks timeout aggregation
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-hook-'))
  const cfg: HooksConfig = {
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: slowCmd,
            timeout: 1,
          },
        ],
      },
    ],
  }
  const agg = await runHooks(
    'Stop',
    {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: tmp,
      timestamp: new Date().toISOString(),
    },
    cfg,
  )
  assert(agg.results[0]?.exitCode === 124, 'agg timeout')
  assert(agg.results[0]?.timedOut === true, 'agg timedOut')

  // S8: subagent permission never wider than parent
  assert(
    resolveSubagentPermissionMode('default', 'bypassPermissions') === 'default',
    'child bypass clamped to parent default',
  )
  assert(
    resolveSubagentPermissionMode('bypassPermissions', 'plan') === 'plan',
    'child plan stricter ok',
  )
  assert(
    resolveSubagentPermissionMode('acceptEdits', 'default') === 'default',
    'child default stricter than acceptEdits',
  )
  assert(
    resolveSubagentPermissionMode('plan', undefined) === 'plan',
    'omit def keeps parent',
  )
  assert(
    permissionModeRank('plan') < permissionModeRank('bypassPermissions'),
    'rank order',
  )

  console.log('ok: test-hooks-s8')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})