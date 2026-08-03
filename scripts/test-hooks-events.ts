/**
 * HKP-1: hooks 事件面扩展 — PermissionDenied / PostToolUseFailure 事件、
 * 结构化 per-hook status、fail-open 语义。
 */
import { strict as assert } from 'node:assert'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import {
  HOOK_EVENTS,
  type HookEvent,
  type HooksConfig,
} from '../packages/shared/src/index.ts'
import {
  runHooks,
  type HookRunResult,
} from '../packages/hooks/src/index.ts'
import { runToolUse } from '../packages/core/src/toolExecution.ts'
import type { BoloTool } from '../packages/tools/src/index.ts'

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    if (predicate()) return
  }
  throw new Error(`FAIL: ${message}`)
}

function writeMarkerCommand(marker: string, extra = ''): string {
  const safe = marker.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
  return `node -e "require('fs').writeFileSync('${safe}','x');${extra}"`
}

function makeTool(overrides: Partial<BoloTool> = {}): BoloTool {
  return {
    name: 'MockTool',
    description: 'mock tool',
    inputJSONSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    requiresPermission: true,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    isEnabled: () => true,
    interruptBehavior: () => 'block',
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => ({ ok: true, output: 'ok' }),
    ...overrides,
  }
}

async function main(): Promise<void> {
  // ---- shared: event registry ----
  assert(
    HOOK_EVENTS.includes('PermissionDenied' as HookEvent) &&
      HOOK_EVENTS.includes('PostToolUseFailure' as HookEvent),
    'new events are registered',
  )

  // ---- hooks: matcher by tool name ----
  {
    const cfg: HooksConfig = {
      PermissionDenied: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node -e ""' }] },
      ],
      PostToolUseFailure: [
        {
          matcher: 'MockTool',
          hooks: [{ type: 'command', command: 'node -e ""' }],
        },
      ],
    }
    const matching = await runHooks(
      'PermissionDenied',
      {
        hook_event_name: 'PermissionDenied',
        session_id: 's',
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        tool_name: 'Bash',
        tool_input: { command: 'x' },
        tool_use_id: 't1',
        reason: 'denied by policy',
      },
      cfg,
    )
    assert.equal(matching.results.length, 1, 'PermissionDenied matches by tool name')
    const nonMatching = await runHooks(
      'PermissionDenied',
      {
        hook_event_name: 'PermissionDenied',
        session_id: 's',
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        tool_name: 'Read',
        tool_input: { path: 'x' },
        tool_use_id: 't2',
      },
      cfg,
    )
    assert.equal(nonMatching.results.length, 0, 'non-matching tool is skipped')
  }

  // ---- hooks: structured per-hook status ----
  {
    const base = {
      hook_event_name: 'PostToolUseFailure' as const,
      session_id: 's',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      tool_name: 'MockTool',
      tool_input: { value: 'x' },
      tool_use_id: 't',
      tool_response: { ok: false },
      error: 'boom',
    }
    const okRun = await runHooks('PostToolUseFailure', base, {
      PostToolUseFailure: [
        {
          hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
        },
      ],
    })
    assert.equal(
      (okRun.results[0] as HookRunResult).status,
      'ok',
      'exit 0 maps to status ok',
    )
    const failedRun = await runHooks('PostToolUseFailure', base, {
      PostToolUseFailure: [
        {
          hooks: [{ type: 'command', command: 'node -e "process.exit(3)"' }],
        },
      ],
    })
    assert.equal(
      (failedRun.results[0] as HookRunResult).status,
      'failed',
      'non-zero exit maps to status failed',
    )
    const timeoutRun = await runHooks('PostToolUseFailure', base, {
      PostToolUseFailure: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node -e "setTimeout(()=>{},60000)"',
              timeout: 0.05,
            },
          ],
        },
      ],
    })
    assert.equal(
      (timeoutRun.results[0] as HookRunResult).status,
      'timeout',
      'timeout maps to status timeout',
    )
    const abort = new AbortController()
    abort.abort()
    const abortedRun = await runHooks(
      'PostToolUseFailure',
      base,
      {
        PostToolUseFailure: [
          {
            hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
          },
        ],
      },
      { signal: abort.signal },
    )
    assert.equal(
      abortedRun.results.length,
      0,
      'a pre-aborted signal skips hook execution (results stay empty)',
    )
    assert.equal(abortedRun.aborted, true, 'abort flag is surfaced')
  }

  // ---- core: PermissionDenied fires on deny (fire-and-forget, fail-open) ----
  const root = path.resolve('.bolo-tmp', 'test-hooks-events')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
  const deniedMarker = path.join(root, 'denied.marker')
  {
    const ctx = {
      sessionId: 's1',
      cwd: root,
      hooks: {
        PermissionDenied: [
          {
            hooks: [
              {
                type: 'command' as const,
                command: writeMarkerCommand(deniedMarker),
              },
            ],
          },
        ],
      },
      permissionMode: 'default' as const,
      askPermission: async () => 'deny' as const,
      tools: [makeTool()],
    }
    const result = await runToolUse(
      { id: 'deny-1', name: 'MockTool', input: { value: 'x' } },
      ctx,
    )
    assert.equal(result.denied, true, 'tool is denied')
    assert(
      result.toolResultMessage.content.includes('permission denied'),
      'deny reason reaches the tool result',
    )
    await waitFor(
      () => existsSync(deniedMarker),
      'PermissionDenied hook runs (fire-and-forget) and writes its marker',
    )
  }

  // ---- core: PostToolUseFailure fires on tool error, exit 2 feeds the model ----
  const failureMarker = path.join(root, 'failure.marker')
  {
    const ctx = {
      sessionId: 's2',
      cwd: root,
      hooks: {
        PostToolUseFailure: [
          {
            hooks: [
              {
                type: 'command' as const,
                command: writeMarkerCommand(
                  failureMarker,
                  "console.error('fix the input')",
                ),
              },
            ],
          },
        ],
      },
      permissionMode: 'bypassPermissions' as const,
      askPermission: async () => 'allow' as const,
      tools: [
        makeTool({
          call: async () => ({ ok: false, isError: true, output: 'boom' }),
        }),
      ],
    }
    const result = await runToolUse(
      { id: 'fail-1', name: 'MockTool', input: { value: 'x' } },
      ctx,
    )
    assert.equal(result.denied, false, 'tool failed without a deny')
    assert(
      result.toolResultMessage.content.includes('boom'),
      'error output reaches the tool result',
    )
    await waitFor(
      () => existsSync(failureMarker),
      'PostToolUseFailure hook runs and writes its marker',
    )
  }

  // ---- core: PostToolUseFailure exit 2 feedback merges into the result ----
  {
    const ctx = {
      sessionId: 's3',
      cwd: root,
      hooks: {
        PostToolUseFailure: [
          {
            hooks: [
              {
                type: 'command' as const,
                command:
                  'node -e "console.error(\'check the schema\')" && exit 2',
              },
            ],
          },
        ],
      },
      permissionMode: 'bypassPermissions' as const,
      askPermission: async () => 'allow' as const,
      tools: [
        makeTool({
          call: async () => ({ ok: false, isError: true, output: 'boom' }),
        }),
      ],
    }
    const result = await runToolUse(
      { id: 'fail-2', name: 'MockTool', input: { value: 'x' } },
      ctx,
    )
    assert(
      result.toolResultMessage.content.includes(
        '[PostToolUseFailure hook]',
      ) && result.toolResultMessage.content.includes('check the schema'),
      'exit 2 feedback from PostToolUseFailure reaches the model',
    )
  }

  await fs.rm(root, { recursive: true, force: true })
  console.log('PASS: HKP-1 hooks event surface and fail-open results')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
