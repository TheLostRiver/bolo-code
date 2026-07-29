/**
 * CLI TUI 行为契约：输入框、turn 活动态与时间线角色。
 *
 * 这里只测纯 reducer/renderer 与注入式 writer，不依赖真人 TTY。
 */
import {
  applyTuiInputKey,
  attachSessionEventPrinter,
  createSessionEventPrinter,
  createTuiInputState,
  createTurnActivityIndicator,
  formatTurnActivityLine,
  getCliSlashCommandCandidates,
  measureTerminalText,
  resolveTuiDockWidth,
  resolveTuiFrameWidth,
  resolveTuiWelcomeWidth,
  renderInkLayout,
  renderTuiInputBox,
  renderUserMessage,
  runOnePrompt,
} from '../packages/cli/src/index.ts'
import { createSession } from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

function visibleWidth(line: string): number {
  return measureTerminalText(line)
}

async function main(): Promise<void> {
  // ANSI 不占宽，CJK 按双宽；这是 Windows Terminal 中文输入不破框的基础。
  assert(measureTerminalText('abc') === 3, 'ASCII display width')
  assert(measureTerminalText('你a') === 3, 'CJK display width')
  assert(measureTerminalText('🙂') === 2, 'emoji display width')
  assert(measureTerminalText('🇨🇳') === 2, 'flag grapheme display width')
  assert(measureTerminalText('1️⃣') === 2, 'keycap grapheme display width')
  assert(
    measureTerminalText('\u001b[32mOK\u001b[0m') === 2,
    'ANSI is zero-width',
  )
  const { getTerminalColumns } = await import('../packages/cli/src/index.ts')
  assert(
    getTerminalColumns({
      env: { COLUMNS: '110' } as NodeJS.ProcessEnv,
      stdoutColumns: 80,
    }) === 80,
    'live stdout width wins over stale COLUMNS env',
  )

  // 输入 reducer：文本、光标编辑、历史与提交动作都不依赖 stdin。
  let input = createTuiInputState({ history: ['older prompt'] })
  input = applyTuiInputKey(input, { sequence: '你' }).state
  input = applyTuiInputKey(input, { sequence: '好' }).state
  input = applyTuiInputKey(input, { name: 'left' }).state
  input = applyTuiInputKey(input, { sequence: '，' }).state
  assert(input.value === '你，好', `cursor insert: ${input.value}`)
  assert(input.cursor === 2, `cursor position: ${input.cursor}`)

  const submitted = applyTuiInputKey(input, { name: 'return' })
  assert(submitted.action === 'submit', 'Enter submits')
  assert(submitted.value === '你，好', 'submit returns current value')

  const history = applyTuiInputKey(
    createTuiInputState({ history: ['older prompt'] }),
    { name: 'up' },
  )
  assert(history.state.value === 'older prompt', 'up recalls history')

  const slashCandidates = [
    {
      name: 'doctor',
      description: 'Show local diagnostics',
      source: 'builtin' as const,
    },
    {
      name: 'diff',
      description: 'Inspect file changes',
      source: 'builtin' as const,
    },
    {
      name: 'effort',
      description: 'Set reasoning effort',
      argumentHint: '[low|high|auto]',
      source: 'builtin' as const,
    },
    {
      name: 'demo:review',
      description: 'Review changes from the demo plugin',
      source: 'plugin' as const,
      sourceLabel: 'demo',
    },
  ]
  const completeCliCatalog = getCliSlashCommandCandidates({})
  assert(
    completeCliCatalog.some((candidate) => candidate.name === 'exit'),
    'interactive catalog includes the CLI-local /exit command',
  )
  assert(
    createTuiInputState({
      slashCandidates: completeCliCatalog,
      value: '/',
    }).slashMenu?.items.some((candidate) => candidate.name === 'exit') === true,
    'bare slash discovers /exit',
  )
  assert(
    createTuiInputState({
      slashCandidates: completeCliCatalog,
      value: '/q',
    }).slashMenu?.items[0]?.name === 'quit',
    'explicit /q discovers the hidden /quit alias',
  )
  let slashInput = createTuiInputState({ slashCandidates })
  slashInput = applyTuiInputKey(slashInput, { sequence: '/' }).state
  assert(
    slashInput.slashMenu?.items.length === slashCandidates.length,
    'bare slash opens the full command menu',
  )
  slashInput = applyTuiInputKey(slashInput, { sequence: 'd' }).state
  assert(
    slashInput.slashMenu?.items[0]?.name === 'doctor',
    '/d filters to /doctor first',
  )
  const slashRendered = renderTuiInputBox({
    state: slashInput,
    columns: 64,
    color: false,
  })
  assert(slashRendered.text.includes('Commands'), 'slash menu has a title')
  assert(slashRendered.text.includes('/doctor'), 'slash menu renders matches')
  assert(
    slashRendered.text.includes('Show local diagnostics'),
    'slash menu renders command descriptions',
  )
  assert(
    slashRendered.lines.every(
      (line) => visibleWidth(line) <= resolveTuiFrameWidth(64),
    ),
    'slash menu stays within the shared frame width',
  )
  const narrowSlashRendered = renderTuiInputBox({
    state: createTuiInputState({ slashCandidates, value: '/' }),
    columns: 24,
    color: false,
    maxMenuRows: 3,
  })
  assert(
    narrowSlashRendered.lines.every(
      (line) => visibleWidth(line) <= resolveTuiFrameWidth(24),
    ),
    `slash menu fits a 24-column terminal: ${narrowSlashRendered.lines
      .map(visibleWidth)
      .join(',')}`,
  )

  let menuNavigation = createTuiInputState({ slashCandidates, value: '/' })
  assert(menuNavigation.slashMenu?.selectedIndex === 0, 'menu selects first row')
  const wrappedMenu = applyTuiInputKey(menuNavigation, { name: 'up' }).state
  assert(
    wrappedMenu.slashMenu?.selectedIndex === slashCandidates.length - 1,
    'up wraps from the first to the last candidate',
  )
  menuNavigation = applyTuiInputKey(menuNavigation, { name: 'down' }).state
  assert(menuNavigation.slashMenu?.selectedIndex === 1, 'down selects next row')
  menuNavigation = applyTuiInputKey(menuNavigation, { name: 'up' }).state
  assert(menuNavigation.slashMenu?.selectedIndex === 0, 'up selects previous row')
  let resetSelection = createTuiInputState({ slashCandidates, value: '/' })
  resetSelection = applyTuiInputKey(resetSelection, { name: 'down' }).state
  resetSelection = applyTuiInputKey(resetSelection, { sequence: 'd' }).state
  assert(
    resetSelection.slashMenu?.selectedIndex === 0 &&
      resetSelection.slashMenu.items[0]?.name === 'doctor',
    'editing the slash query resets selection to the first match',
  )
  const menuBeforeHistory = applyTuiInputKey(
    createTuiInputState({
      history: ['older prompt'],
      slashCandidates,
      value: '/',
    }),
    { name: 'up' },
  ).state
  assert(
    menuBeforeHistory.value === '/' &&
      menuBeforeHistory.slashMenu?.selectedIndex === slashCandidates.length - 1,
    'menu navigation takes priority over prompt history',
  )
  const tabCompletion = applyTuiInputKey(menuNavigation, {
    name: 'tab',
    sequence: '\t',
  })
  assert(
    tabCompletion.state.value === '/doctor ' &&
      tabCompletion.state.slashMenu === null,
    'Tab completes the selected command and closes the menu',
  )
  const effortHintState = createTuiInputState({
    slashCandidates,
    value: '/effort ',
  })
  const effortHintRendered = renderTuiInputBox({
    state: effortHintState,
    columns: 64,
    color: true,
  })
  assert(
    effortHintRendered.text.includes(
      '/effort \u001b[2m[low|high|auto]\u001b[0m',
    ),
    'exact slash command plus one space renders a dim argument hint',
  )
  assert(
    effortHintState.value === '/effort ' &&
      effortHintState.cursor === '/effort '.length,
    'argument hint is display-only and does not move the input cursor',
  )
  const effortWithArgument = renderTuiInputBox({
    state: createTuiInputState({
      slashCandidates,
      value: '/effort h',
    }),
    columns: 64,
    color: true,
  })
  assert(
    !effortWithArgument.text.includes('[low|high|auto]'),
    'argument hint disappears after the user starts an argument',
  )
  const narrowEffortHint = renderTuiInputBox({
    state: effortHintState,
    columns: 24,
    color: false,
  })
  assert(
    narrowEffortHint.lines.every(
      (line) => visibleWidth(line) <= resolveTuiDockWidth(24),
    ),
    `argument hint is clipped within a 24-column dock: ${narrowEffortHint.lines
      .map(visibleWidth)
      .join(',')}`,
  )
  const enterCompletion = applyTuiInputKey(
    createTuiInputState({ slashCandidates, value: '/d' }),
    { name: 'return', sequence: '\r' },
  )
  assert(
    enterCompletion.action === undefined &&
      enterCompletion.state.value === '/doctor ',
    'Enter completes a menu item without executing it',
  )
  const escapedMenu = applyTuiInputKey(
    createTuiInputState({ slashCandidates, value: '/d' }),
    { name: 'escape', sequence: '\u001b' },
  )
  assert(
    escapedMenu.state.value === '/d' && escapedMenu.state.slashMenu === null,
    'Esc closes the menu without deleting user input',
  )
  const reopenedMenu = applyTuiInputKey(escapedMenu.state, { sequence: 'o' })
  assert(reopenedMenu.state.slashMenu !== null, 'editing reopens slash matches')
  let cursorContext = createTuiInputState({
    slashCandidates,
    value: '/doctor',
  })
  cursorContext = applyTuiInputKey(cursorContext, { name: 'left' }).state
  assert(
    cursorContext.slashMenu === null,
    'moving away from the command-token end closes the menu',
  )
  cursorContext = applyTuiInputKey(cursorContext, { name: 'end' }).state
  assert(cursorContext.slashMenu !== null, 'moving back to the end reopens it')
  assert(
    createTuiInputState({ slashCandidates, value: '//' }).slashMenu === null,
    'double slash remains a normal prompt',
  )
  const noMatches = createTuiInputState({
    slashCandidates,
    value: '/does-not-exist',
  })
  assert(
    noMatches.slashMenu?.items.length === 0 &&
      renderTuiInputBox({
        state: noMatches,
        columns: 64,
        color: false,
      }).text.includes('No matching commands'),
    'unknown command prefix has an explicit empty state',
  )
  const unknownSubmit = applyTuiInputKey(noMatches, {
    name: 'return',
    sequence: '\r',
  })
  assert(
    unknownSubmit.action === 'submit' &&
      unknownSubmit.value === '/does-not-exist',
    'Enter still submits an unknown slash command from the empty state',
  )
  const restoredMatch = applyTuiInputKey(
    createTuiInputState({ slashCandidates, value: '/doz' }),
    { name: 'backspace' },
  ).state
  assert(
    restoredMatch.value === '/do' &&
      restoredMatch.slashMenu?.items[0]?.name === 'doctor',
    'deleting an unmatched suffix restores live candidates',
  )

  const multiline = applyTuiInputKey(
    createTuiInputState({ value: 'line one' }),
    { name: 'j', ctrl: true },
  )
  assert(multiline.state.value === 'line one\n', 'Ctrl+J inserts newline')
  const tabbed = applyTuiInputKey(
    createTuiInputState({ value: 'a' }),
    { name: 'tab', sequence: '\t' },
  )
  assert(tabbed.state.value === 'a  ', 'Tab inserts predictable spaces')
  const windowsMultiline = applyTuiInputKey(
    createTuiInputState({ value: 'windows line' }),
    { name: 'enter', sequence: '\n' },
  )
  assert(
    windowsMultiline.state.value === 'windows line\n' &&
      windowsMultiline.action === undefined,
    'Windows PTY LF inserts newline instead of submitting',
  )

  // 真输入框：上下边界、光标提示、状态/快捷键；窄终端与中文都不能越界。
  const box = renderTuiInputBox({
    state: createTuiInputState({
      value: '请检查这个项目的 TUI 排版并给出修改建议',
    }),
    columns: 40,
    color: false,
    status: {
      permissionMode: 'default',
      providerId: 'work',
      model: 'gpt-test',
      effortLevel: 'high',
    },
  })
  assert(box.text.includes('╭'), 'input has top border')
  assert(box.text.includes('╰'), 'input has bottom border')
  assert(box.text.includes('❯'), 'input has recognizable prompt')
  assert(box.text.includes('Enter send'), 'input shows send shortcut')
  assert(box.lines.every((line) => visibleWidth(line) <= 39), 'box fits 40 cols')
  assert(box.cursorRow >= 1, 'cursor points into input body')
  assert(box.cursorColumn >= 3, 'cursor column follows prompt')

  const user = renderUserMessage('你是谁\n第二行', {
    columns: 40,
    color: false,
  })
  assert(user.includes('❯ 你是谁'), 'user message has role marker')
  assert(user.includes('  第二行'), 'user continuation is indented')
  assert(!user.includes('bolo>'), 'legacy prompt is gone')

  // 欢迎首页：宽屏将 Bolo 水晶与运行状态组成工作台，窄屏再回落单列。
  const welcome = renderInkLayout({
    columns: 120,
    plain: false,
    cwd: 'E:\\DEV\\HelsincyAgent',
    model: 'work/gpt-test',
    sessionId: 'sess_test',
    session: {
      permissionMode: 'default',
      model: 'gpt-test',
      effortLevel: 'high',
      messages: [],
      providerId: 'work',
    },
    env: {} as NodeJS.ProcessEnv,
  })
  assert(welcome.includes('BOLO'), 'welcome identifies product')
  assert(welcome.includes('──◆──'), 'welcome gives Bolo a crystal identity')
  assert(welcome.includes('WORKSPACE'), 'welcome exposes workspace metadata')
  assert(welcome.includes('MODEL'), 'welcome exposes model metadata')
  assert(welcome.includes('SESSION'), 'welcome exposes session metadata')
  assert(!welcome.includes('ink-equiv'), 'internal renderer name is hidden')
  assert(!welcome.includes('bolo>'), 'welcome has no fake input')
  assert(!welcome.includes('____'), 'giant ASCII logo is removed')
  const welcomeLines = welcome.split('\n')
  assert(
    welcomeLines.every(
      (line) => visibleWidth(line) === resolveTuiWelcomeWidth(120),
    ),
    `wide welcome uses the bounded welcome width: ${welcomeLines
      .map(visibleWidth)
      .join(',')}`,
  )
  assert(
    welcomeLines[0]?.startsWith('\u001b') ||
      welcomeLines[0]?.startsWith('╭'),
    'wide welcome starts with a titled workbench border',
  )
  assert(
    welcomeLines.some((line) => line.split('│').length >= 4),
    'wide welcome separates the crystal from runtime status',
  )

  const ultraWideWelcome = renderInkLayout({
    columns: 220,
    cwd: 'E:\\DEV\\HelsincyAgent',
    model: 'work/gpt-test',
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  const ultraWideInput = renderTuiInputBox({
    state: createTuiInputState(),
    columns: 220,
    color: false,
  })
  const ultraWideUser = renderUserMessage('wide user history', {
    columns: 220,
    color: false,
  })
  assert(
    visibleWidth(ultraWideWelcome.split('\n')[0] ?? '') ===
      resolveTuiWelcomeWidth(220) &&
      visibleWidth(ultraWideInput.lines[0] ?? '') ===
        resolveTuiDockWidth(220) &&
      visibleWidth(ultraWideUser) === resolveTuiDockWidth(220) &&
      resolveTuiDockWidth(220) > resolveTuiWelcomeWidth(220),
    'ultra-wide welcome stays bounded while user history and input share the dock width',
  )

  const mediumWelcome = renderInkLayout({
    columns: 76,
    plain: false,
    cwd: 'E:\\DEV\\中文项目',
    model: 'work/gpt-test',
    sessionId: 'sess_medium',
    env: { NO_COLOR: '1' } as NodeJS.ProcessEnv,
  })
  assert(mediumWelcome.includes('──◆──'), 'medium welcome keeps the crystal')
  assert(
    mediumWelcome.includes('WORKSPACE'),
    'NO_COLOR keeps the structured metadata',
  )
  assert(
    !/\u001b\[[0-9;]*m/.test(mediumWelcome),
    'NO_COLOR welcome emits no SGR styles',
  )
  assert(
    mediumWelcome
      .split('\n')
      .every((line) => visibleWidth(line) <= 74),
    'medium welcome stays inside terminal width',
  )
  assert(
    !mediumWelcome
      .split('\n')
      .some((line) => line.split('│').length >= 4),
    'medium welcome uses one responsive column',
  )

  const compactWelcome = renderInkLayout({
    columns: 46,
    plain: false,
    cwd: 'E:\\DEV\\a-very-long-workspace-name',
    model: 'work/a-very-long-model-name',
    sessionId: 'sess_compact',
    env: {} as NodeJS.ProcessEnv,
  })
  assert(
    compactWelcome.includes('╔██╗'),
    'compact welcome keeps a recognizable crystal',
  )
  assert(
    compactWelcome
      .split('\n')
      .every((line) => visibleWidth(line) <= 44),
    'compact welcome clips every row safely',
  )
  assert(
    !compactWelcome
      .split('\n')
      .some((line) => line.split('│').length >= 4),
    'compact welcome uses one responsive column',
  )

  // 首 provider 事件前必须立即可见；elapsed 是活动态的一部分。
  const activityLine = formatTurnActivityLine({
    label: 'Thinking',
    elapsedMs: 1_240,
    frame: 1,
    color: false,
  })
  assert(activityLine.includes('Thinking'), 'activity label')
  assert(activityLine.includes('1.2s'), 'activity elapsed time')
  assert(activityLine.includes('Ctrl+C'), 'activity shows interrupt shortcut')
  const laterActivityLine = formatTurnActivityLine({
    label: 'Thinking',
    elapsedMs: 1_540,
    frame: 8,
    color: false,
  })
  assert(
    activityLine[0] !== laterActivityLine[0] &&
      visibleWidth(activityLine[0] ?? '') === 1 &&
      visibleWidth(laterActivityLine[0] ?? '') === 1,
    'activity glyph visibly animates without blank or wide frames',
  )
  const animationGlyphs = [0, 1, 2, 3].map(
    (frame) =>
      formatTurnActivityLine({
        label: 'Thinking',
        elapsedMs: 1_240,
        frame,
        color: false,
      })[0] ?? '',
  )
  assert(
    new Set(animationGlyphs).size >= 3 &&
      animationGlyphs.every((glyph) => visibleWidth(glyph) === 1),
    `activity has a visible, single-cell frame sequence: ${animationGlyphs.join(
      ',',
    )}`,
  )
  const narrowActivityLine = formatTurnActivityLine({
    label: 'Running read_a_very_long_tool_name',
    elapsedMs: 1_240,
    frame: 1,
    color: false,
    columns: 24,
  })
  assert(
    visibleWidth(narrowActivityLine) <= 24,
    `activity fits narrow terminal: ${visibleWidth(narrowActivityLine)}`,
  )

  const activityOut: string[] = []
  const activity = createTurnActivityIndicator({
    writeOut: (text) => activityOut.push(text),
    color: false,
    now: () => 1_000,
  })
  activity.start('Thinking')
  assert(
    activityOut.length === 1 &&
      activityOut[0]!.startsWith('\r✦ Thinking') &&
      activityOut[0]!.endsWith('\u001b[K'),
    `activity first frame is one atomic in-place write: ${JSON.stringify(
      activityOut,
    )}`,
  )
  assert(activityOut.join('').includes('Thinking'), 'activity writes immediately')
  assert(activity.isActive(), 'activity becomes active')
  activity.beforeEvent({ type: 'phase', phase: 'running' })
  activity.afterEvent({ type: 'phase', phase: 'running' })
  assert(activity.isActive(), 'running phase keeps visible activity')
  activity.beforeEvent({ type: 'tool_start', id: 't1', name: 'Read' })
  assert(!activity.isActive(), 'event clears stale activity line')
  activity.afterEvent({ type: 'tool_start', id: 't1', name: 'Read' })
  assert(activity.isActive(), 'tool start switches to running activity')
  assert(activityOut.join('').includes('Running Read'), 'tool activity is named')
  activity.finish('completed')
  assert(!activity.isActive(), 'finish stops timer')

  // TTY printer：提交就回显 user + Thinking；正文到达后显示 Bolo 角色。
  const out: string[] = []
  const printerActivity = createTurnActivityIndicator({
    writeOut: (text) => out.push(text),
    color: false,
    now: () => 2_000,
  })
  const printer = createSessionEventPrinter({
    writeOut: (text) => out.push(text),
    writeErr: (text) => out.push(text),
    color: false,
    activity: printerActivity,
    timeline: true,
  })
  printer.beginTurn({
    prompt: '分析当前项目',
    echoUser: true,
    activity: true,
  })
  const immediate = out.join('')
  assert(immediate.includes('❯ 分析当前项目'), 'submitted user message echoes')
  assert(immediate.includes('Thinking'), 'turn is visibly active before events')
  printer.onEvent({ type: 'text', text: '**开始分析**' })
  printer.endTurn({ terminalReason: 'completed' })
  const completed = out.join('')
  assert(completed.includes('Bolo'), 'assistant has a role header')
  assert(completed.includes('开始分析'), 'assistant text still streams')
  assert(!completed.includes('**'), 'interactive timeline renders markdown')

  // NO_COLOR keeps cursor-control for the live line, but must not leak SGR
  // styling through legacy tool formatters.
  const noColorOut: string[] = []
  const noColorActivity = createTurnActivityIndicator({
    writeOut: (text) => noColorOut.push(text),
    color: false,
  })
  const noColorPrinter = createSessionEventPrinter({
    writeOut: (text) => noColorOut.push(text),
    writeErr: (text) => noColorOut.push(text),
    color: false,
    activity: noColorActivity,
    timeline: true,
  })
  noColorPrinter.beginTurn({ prompt: 'run tool', activity: true })
  noColorPrinter.onEvent({
    type: 'tool_progress',
    id: 'tool_1',
    name: 'Read',
    message: 'loading',
  })
  assert(
    !noColorOut.join('').includes('… Read loading\n'),
    'tool progress updates the activity line instead of appending ticks',
  )
  assert(
    noColorOut.join('').includes('Read · loading'),
    'tool activity keeps tool name and progress detail',
  )
  assert(
    !/\u001b\[[0-9;]*m/.test(noColorOut.join('')),
    'NO_COLOR timeline does not emit SGR styles',
  )
  noColorPrinter.endTurn({ terminalReason: 'completed' })

  // A visible warning is useful, but a slow provider must return to an active
  // state after the warning instead of looking frozen.
  const warningOut: string[] = []
  const warningActivity = createTurnActivityIndicator({
    writeOut: (text) => warningOut.push(text),
    color: false,
  })
  const warningPrinter = createSessionEventPrinter({
    writeOut: (text) => warningOut.push(text),
    writeErr: (text) => warningOut.push(text),
    color: false,
    activity: warningActivity,
    timeline: true,
  })
  warningPrinter.beginTurn({ prompt: 'wait after warning', activity: true })
  warningPrinter.onEvent({ type: 'warning', message: 'provider notice' })
  assert(
    warningActivity.isActive(),
    'warning returns to Thinking while the turn is still running',
  )
  warningPrinter.endTurn({ terminalReason: 'completed' })

  // 默认（非动态/非 TTY）printer 保持旧的追加式协议，不凭空打印 ANSI/UI。
  const plainOut: string[] = []
  const plain = createSessionEventPrinter({
    writeOut: (text) => plainOut.push(text),
  })
  plain.beginTurn({ prompt: 'pipe input', echoUser: true, activity: true })
  plain.onEvent({ type: 'text', text: 'pipe output' })
  plain.endTurn({ terminalReason: 'completed' })
  assert(plainOut.join('') === 'pipe output\n', 'plain printer stays append-only')

  // Full queryLoop wiring: the first token is deliberately blocked, but the
  // user echo and Thinking state must already be visible.
  let releaseFirstToken: (() => void) | undefined
  const firstTokenGate = new Promise<void>((resolve) => {
    releaseFirstToken = resolve
  })
  const delayedProvider: LlmProvider = {
    id: 'mock',
    async *completeStream() {
      await firstTokenGate
      yield { type: 'text_delta', text: 'delayed answer' }
      yield { type: 'done' }
    },
  }
  const delayedOut: string[] = []
  const delayedActivity = createTurnActivityIndicator({
    writeOut: (text) => delayedOut.push(text),
    color: false,
  })
  const delayedPrinter = createSessionEventPrinter({
    writeOut: (text) => delayedOut.push(text),
    writeErr: (text) => delayedOut.push(text),
    timeline: true,
    color: false,
    activity: delayedActivity,
  })
  const delayedSession = await createSession({
    cwd: process.cwd(),
    provider: delayedProvider,
    systemPrompt: false,
    onEvent: delayedPrinter.onEvent,
    askPermission: async () => 'deny',
  })
  attachSessionEventPrinter(delayedSession, delayedPrinter)
  const pendingTurn = runOnePrompt(delayedSession, 'wait for first token', {
    writeOut: (text) => delayedOut.push(text),
    writeErr: (text) => delayedOut.push(text),
  })
  await Promise.resolve()
  const beforeFirstToken = delayedOut.join('')
  assert(
    beforeFirstToken.includes('❯ wait for first token'),
    'queryLoop echoes user before first token',
  )
  assert(
    beforeFirstToken.includes('Thinking'),
    'queryLoop shows activity before first token',
  )
  assert(
    delayedActivity.isActive(),
    'queryLoop keeps activity visible after running phase',
  )
  assert(
    !beforeFirstToken.includes('delayed answer'),
    'provider token is still blocked',
  )
  releaseFirstToken?.()
  await pendingTurn
  assert(delayedOut.join('').includes('delayed answer'), 'delayed text streams')

  console.log('ok: test-cli-tui')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
