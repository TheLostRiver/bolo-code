/**
 * OI-11D: auditable operation details and a keyboard permission selector.
 */
import {
  applyPermissionPanelKey,
  createTtyAskPermission,
  formatPermissionPanelScreen,
  measureTerminalText,
  resolveTuiDockWidth,
  runPermissionPanel,
} from '../packages/cli/src/index.ts'
import { runToolUse } from '../packages/core/src/toolExecution.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

async function main(): Promise<void> {
  const request = {
    toolName: 'Bash',
    toolInput: {
      command: 'npm.cmd test -- --runInBand',
      timeout: 120_000,
      run_in_background: false,
    },
    toolUseId: 'bash_1',
    cwd: process.cwd(),
  }

  const screen = formatPermissionPanelScreen(request, 2, {
    columns: 72,
    color: false,
  })
  assert(screen.includes('npm.cmd test -- --runInBand'), 'shows full command')
  assert(screen.includes(process.cwd()), 'shows actual working directory')
  assert(screen.includes('120s'), 'shows effective timeout')
  assert(screen.includes('Foreground'), 'shows execution mode')
  assert(screen.includes('Allow once'), 'shows one-shot choice')
  assert(screen.includes('Always allow'), 'shows persistent choice')
  assert(
    screen.includes('every Bash request for this session'),
    'always choice names its real scope',
  )
  assert(screen.includes('Deny'), 'shows deny choice')

  for (const columns of [24, 40, 72]) {
    const narrow = formatPermissionPanelScreen(request, 2, {
      columns,
      color: false,
    })
    assert(
      narrow
        .split('\n')
        .every((line) => measureTerminalText(line) <= resolveTuiDockWidth(columns)),
      `${columns}-column permission panel never overflows`,
    )
  }
  assert(
    formatPermissionPanelScreen(request, 2, {
      columns: 72,
      color: true,
    }).includes('\u001b[7m'),
    'selected permission choice is visibly highlighted',
  )

  const background = formatPermissionPanelScreen(
    {
      ...request,
      toolInput: {
        command: 'npm.cmd run dev',
        run_in_background: true,
      },
    },
    0,
    { columns: 72, color: false },
  )
  assert(background.includes('Background'), 'shows background execution mode')
  assert(background.includes('No timeout'), 'background mode explains timeout')

  let keyResult = applyPermissionPanelKey(2, 'up')
  assert(keyResult.index === 1, 'up moves from deny to always')
  keyResult = applyPermissionPanelKey(keyResult.index, 'enter')
  assert(
    keyResult.decision === 'allow_always',
    'enter selects the highlighted always choice',
  )
  assert(
    applyPermissionPanelKey(2, 'y').decision === 'allow',
    'y directly allows once',
  )
  assert(
    applyPermissionPanelKey(0, 'a').decision === 'allow_always',
    'a directly allows for the session',
  )
  assert(
    applyPermissionPanelKey(0, 'esc').decision === 'deny',
    'escape denies',
  )

  const panelWrites: string[] = []
  const panelKeys = ['up', 'enter']
  const panelDecision = await runPermissionPanel({
    request,
    readKey: async () => panelKeys.shift() ?? 'n',
    writeOut: (text) => panelWrites.push(text),
    isTty: true,
    columns: 72,
    color: false,
  })
  assert(panelDecision === 'allow_always', 'panel returns selected decision')
  assert(
    panelWrites.join('').includes('npm.cmd test -- --runInBand'),
    'interactive panel renders operation details',
  )
  assert(
    !panelWrites.join('').includes('\u001b[2J'),
    'permission panel never clears the full screen',
  )

  let pauses = 0
  let resumes = 0
  const askWrites: string[] = []
  const askKeys = ['up', 'enter']
  const ask = createTtyAskPermission({
    isTty: true,
    readKey: async () => askKeys.shift() ?? 'n',
    writeOut: (text) => askWrites.push(text),
    pauseInput: () => pauses++,
    resumeInput: () => resumes++,
    suspendTextPrompt: true,
  })
  assert(
    (await ask(request)) === 'allow_always',
    'TTY ask uses the structured choice panel',
  )
  assert(pauses === 1 && resumes === 1, 'panel owns input exactly once')
  assert(askWrites.join('').includes(process.cwd()), 'TTY ask exposes cwd')

  let interrupted = 0
  const interruptedAsk = createTtyAskPermission({
    isTty: true,
    readKey: async () => 'ctrl-c',
    writeOut: () => {},
    onInterrupt: () => interrupted++,
  })
  assert((await interruptedAsk(request)) === 'deny', 'Ctrl+C fails closed')
  assert(interrupted === 1, 'Ctrl+C notifies the active turn')

  let legacyPrompt = ''
  const legacyAsk = createTtyAskPermission({
    isTty: true,
    readAnswer: async (prompt) => {
      legacyPrompt = prompt
      return 'y'
    },
  })
  assert((await legacyAsk(request)) === 'allow', 'explicit readAnswer stays compatible')
  assert(legacyPrompt.includes('[y/a/N]'), 'legacy injection receives text prompt')

  const nonTty = createTtyAskPermission({ isTty: false })
  assert((await nonTty(request)) === 'deny', 'non-TTY remains fail-closed')

  let permissionCwd: string | undefined
  await runToolUse(
    {
      id: 'bash_cwd',
      name: 'Bash',
      input: { command: 'echo should-not-run' },
    },
    {
      sessionId: 'permission-panel-test',
      cwd: process.cwd(),
      hooks: {},
      permissionMode: 'default',
      askPermission: async (permissionRequest) => {
        permissionCwd = (
          permissionRequest as typeof permissionRequest & { cwd?: string }
        ).cwd
        return 'deny'
      },
    },
  )
  assert(
    permissionCwd === process.cwd(),
    'core passes the actual cwd into permission requests',
  )

  console.log('PASS: CLI permission panel')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
