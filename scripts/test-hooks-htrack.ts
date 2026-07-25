/**
 * Hooks H0–H3：SessionEnd + exit 语义 + SubagentStart inject
 * 运行：node --import tsx/esm scripts/test-hooks-htrack.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runHooks,
  clampSessionEndTimeoutSec,
  effectiveHookTimeoutSec,
  DEFAULT_SESSION_END_TIMEOUT_SEC,
  MAX_SESSION_END_TIMEOUT_SEC,
} from '../packages/hooks/src/index.ts'
import { HOOK_EVENTS } from '../packages/shared/src/index.ts'
import type { HooksConfig } from '../packages/shared/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type {
  LlmProvider,
  ProviderStreamEvent,
} from '../packages/providers/src/types.ts'
import {
  createSession,
  endSession,
  runSessionEndHooks,
  queryLoop,
  productionDeps,
} from '../packages/core/src/index.ts'
import { createMockProvider } from '../packages/providers/src/index.ts'
import { submitUserInput } from '../packages/core/src/slash.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function createTextOnlyProvider(): LlmProvider {
  let n = 0
  return {
    id: 'text-only-mock',
    async *completeStream(
      _messages: ChatMessage[],
    ): AsyncIterable<ProviderStreamEvent> {
      n += 1
      yield { type: 'text_delta', text: `reply-${n}\n` }
      yield { type: 'done' }
    },
    async completeText(messages: ChatMessage[]) {
      return `summary ${messages.length}`
    },
  }
}

/** 写小 helper 脚本，避免 Windows shell 引号地狱 */
async function writeHelper(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, body, 'utf8')
  return p
}

async function main() {
  assert(HOOK_EVENTS.includes('SessionEnd'), 'SessionEnd in HOOK_EVENTS')
  assert(
    clampSessionEndTimeoutSec(0) === DEFAULT_SESSION_END_TIMEOUT_SEC,
    'session end default',
  )
  assert(
    clampSessionEndTimeoutSec(999) === MAX_SESSION_END_TIMEOUT_SEC,
    'session end max',
  )
  assert(
    effectiveHookTimeoutSec('SessionEnd', undefined) ===
      DEFAULT_SESSION_END_TIMEOUT_SEC,
    'effective session end default',
  )
  assert(effectiveHookTimeoutSec('Stop', undefined) === 30, 'stop default 30')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-htrack-'))
  const marker = path.join(tmp, 'session-end.json')

  const dumpStdin = await writeHelper(
    tmp,
    'dump-stdin.mjs',
    `import fs from 'node:fs';
const out = process.argv[2];
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
fs.writeFileSync(out, Buffer.concat(chunks));
`,
  )
  const dumpCmd = `node "${dumpStdin}" "${marker}"`

  // --- H0: SessionEnd reason matcher + endSession ---
  const hooksEnd: HooksConfig = {
    SessionEnd: [
      {
        matcher: 'clear',
        hooks: [{ type: 'command', command: dumpCmd, timeout: 5 }],
      },
      {
        matcher: 'prompt_input_exit',
        hooks: [
          {
            type: 'command',
            command:
              'node -e "process.stderr.write(\'bye\'); process.exit(1)"',
            timeout: 5,
          },
        ],
      },
    ],
  }

  // 直接 runHooks 先验证 matcher
  const direct = await runHooks(
    'SessionEnd',
    {
      hook_event_name: 'SessionEnd',
      session_id: 'direct',
      cwd: tmp,
      timestamp: new Date().toISOString(),
      reason: 'clear',
    },
    hooksEnd,
  )
  assert(direct.results.length === 1, `direct results ${direct.results.length}`)
  assert(direct.results[0]!.exitCode === 0, `direct exit ${direct.results[0]!.exitCode} ${direct.results[0]!.stderr}`)
  const raw0 = await fs.readFile(marker, 'utf8')
  assert(raw0.includes('SessionEnd'), 'direct stdin SessionEnd')

  const session = await createSession({
    cwd: tmp,
    hooks: hooksEnd,
    provider: createMockProvider(),
    systemPrompt: false,
    onEvent: () => {},
  })
  assert(session.phase === 'ready', 'session ready')

  await fs.unlink(marker).catch(() => {})
  await runSessionEndHooks(session, { reason: 'clear' })
  const raw = await fs.readFile(marker, 'utf8')
  assert(raw.includes('SessionEnd'), 'stdin has SessionEnd')
  assert(raw.includes('clear'), 'reason clear')
  assert(session.phase === 'ready', 'runSessionEndHooks keeps phase')

  await endSession(session, { reason: 'prompt_input_exit' })
  assert(session.phase === 'ended', 'endSession → ended')
  await endSession(session, { reason: 'other' })
  assert(session.phase === 'ended', 'endSession idempotent')

  // --- Stop exit 2 continuation ---
  const countFile = path.join(tmp, 'stop-count')
  await fs.writeFile(countFile, '0', 'utf8')
  const stopHelper = await writeHelper(
    tmp,
    'stop-once.mjs',
    `import fs from 'node:fs';
const p = process.argv[2];
let n = +fs.readFileSync(p, 'utf8') || 0;
n++;
fs.writeFileSync(p, String(n));
if (n === 1) {
  process.stderr.write('cont');
  process.exit(2);
}
process.exit(0);
`,
  )
  const stopCmd = `node "${stopHelper}" "${countFile}"`
  const stopHooks: HooksConfig = {
    Stop: [{ hooks: [{ type: 'command', command: stopCmd, timeout: 5 }] }],
  }

  const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  const term2 = await queryLoop({
    sessionId: 's-stop',
    cwd: tmp,
    hooks: stopHooks,
    messages: msgs,
    systemPromptSections: ['sys'],
    deps: productionDeps(createTextOnlyProvider()),
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    maxTurns: 8,
    maxStopContinuations: 2,
  })
  assert(term2.reason === 'completed', `stop cont terminal ${term2.reason}`)
  const n2 = Number(await fs.readFile(countFile, 'utf8'))
  assert(n2 >= 2, `stop count ${n2}`)
  assert(
    msgs.some(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('Stop hook continuation'),
    ),
    'continuation user msg',
  )

  // --- PostToolUse exit 2 ---
  const post = await runHooks(
    'PostToolUse',
    {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: tmp,
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
      tool_input: {},
      tool_response: { ok: true },
      tool_use_id: 't1',
    },
    {
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command:
                'node -e "process.stderr.write(\'post-feedback\'); process.exit(2)"',
              timeout: 5,
            },
          ],
        },
      ],
    },
  )
  assert(post.continuationText.includes('post-feedback'), 'post continuation')

  // --- SubagentStart inject ---
  const subStart = await runHooks(
    'SubagentStart',
    {
      hook_event_name: 'SubagentStart',
      session_id: 's',
      cwd: tmp,
      timestamp: new Date().toISOString(),
      agent_id: 'a1',
      agent_type: 'explore',
    },
    {
      SubagentStart: [
        {
          matcher: 'explore',
          hooks: [
            {
              type: 'command',
              command: 'node -e "process.stdout.write(\'inject-for-child\')"',
              timeout: 5,
            },
          ],
        },
      ],
    },
  )
  assert(subStart.injectText.includes('inject-for-child'), 'sub inject')

  // --- /clear → SessionEnd clear ---
  const clearMarker = path.join(tmp, 'clear-end.txt')
  const clearHelper = await writeHelper(
    tmp,
    'clear-mark.mjs',
    `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'ok');`,
  )
  const clearWrite = `node "${clearHelper}" "${clearMarker}"`
  const s3 = await createSession({
    cwd: tmp,
    hooks: {
      SessionEnd: [
        {
          matcher: 'clear',
          hooks: [{ type: 'command', command: clearWrite, timeout: 5 }],
        },
      ],
    },
    provider: createMockProvider(),
    systemPrompt: false,
    onEvent: () => {},
  })
  s3.messages.push({ role: 'user', content: 'x' })
  const cleared = await submitUserInput(s3, '/clear')
  assert(cleared.type === 'slash', 'clear slash')
  if (cleared.type === 'slash') {
    assert(/Cleared/i.test(cleared.message), `clear msg: ${cleared.message}`)
  }
  assert(s3.phase !== 'ended', 'clear does not end session')
  assert(s3.messages.length === 0, 'messages cleared')
  const c = await fs.readFile(clearMarker, 'utf8')
  assert(c.includes('ok'), 'clear SessionEnd ran')

  console.log('ok: test-hooks-htrack')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})