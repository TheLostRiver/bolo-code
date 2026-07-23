/**
 * 窄链路冒烟 — 走 queryLoop 管道
 * 运行：npx tsx scripts/smoke-turn.ts
 */

import {
  createSession,
  submitPrompt,
  spawnSubagentStub,
  compactSession,
} from '../packages/core/src/index.ts'
import type { HooksConfig } from '../packages/shared/src/index.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cwd = path.resolve(__dirname, '..')

const hooks: HooksConfig = {
  UserPromptSubmit: [
    {
      matcher: 'should-be-ignored',
      hooks: [{ type: 'command', command: 'node -e "process.stdout.write(\'hook-user-prompt\')" ' }],
    },
  ],
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
    },
  ],
  PermissionRequest: [
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command:
            'node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:\'PermissionRequest\',decision:\'allow\'}}))" ',
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
    },
  ],
  Stop: [
    {
      matcher: 'also-ignored',
      hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
    },
  ],
  PreCompact: [
    {
      matcher: 'manual',
      hooks: [
        {
          type: 'command',
          command: 'node -e "process.stdout.write(\'keep-file-paths\')" ',
        },
      ],
    },
  ],
  PostCompact: [
    {
      matcher: 'manual',
      hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
    },
  ],
}

async function main() {
  const log: string[] = []
  const session = await createSession({
    cwd,
    hooks,
    // smoke：default 下 Bash 会 ask；hook 已 allow。再兜底 askPermission。
    permissionMode: 'default',
    askPermission: async () => 'allow',
    compactSummarizer: async ({ compactPrompt }) => {
      if (!compactPrompt.includes('keep-file-paths')) {
        throw new Error('PreCompact hook instructions missing from compact prompt')
      }
      return {
        text: `<analysis>draft</analysis><summary>
1. Primary Request and Intent:
   Run bash via smoke test
8. Current Work:
   Verifying agent loop pipeline
</summary>`,
      }
    },
    onEvent: (e) => {
      if (e.type === 'phase') log.push(`phase:${e.phase}`)
      if (e.type === 'text') log.push(`text:${e.text.trim()}`)
      if (e.type === 'tool_start') log.push(`tool_start:${e.name}`)
      if (e.type === 'tool_end')
        log.push(`tool_end:${e.name}:${e.ok}:${e.output.slice(0, 80)}`)
      if (e.type === 'hook')
        log.push(`hook:${e.event}:${e.exitCode}${e.blocked ? ':blocked' : ''}`)
      if (e.type === 'permission_decision')
        log.push(`gate:${e.mode}:${e.behavior}`)
      if (e.type === 'permission_request') log.push(`permission:${e.name}`)
      if (e.type === 'done')
        log.push(`done:${e.terminal?.reason ?? 'ok'}`)
      if (e.type === 'error') log.push(`error:${e.message}`)
    },
  })

  const terminal = await submitPrompt(session, 'please run bash')
  if (terminal.reason !== 'completed') {
    console.error('SMOKE FAIL terminal:', terminal)
    process.exit(1)
  }

  await spawnSubagentStub(session, 'explore')

  const compact = await compactSession(session, {
    trigger: 'manual',
    keepRecentMessageCount: 0,
  })
  if (!compact.ok) {
    console.error('SMOKE FAIL compact:', compact.reason)
    process.exit(1)
  }
  if (!session.messages.some((m) => m.content.includes('Run bash via smoke'))) {
    console.error('SMOKE FAIL: summary not in messages after compact')
    process.exit(1)
  }
  log.push('compact:ok')

  const joined = log.join('\n')
  console.log('--- event log ---')
  console.log(joined)

  const need = [
    'phase:ready',
    'gate:default:ask',
    'tool_start:Bash',
    'tool_end:Bash:true',
    'hook:Stop:0',
    'done:completed',
    'hook:PreCompact:0',
    'hook:PostCompact:0',
    'compact:ok',
  ]
  const missing = need.filter((n) => !joined.includes(n))
  if (missing.length) {
    console.error('SMOKE FAIL missing:', missing)
    process.exit(1)
  }
  console.log('SMOKE PASS (queryLoop pipeline)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})