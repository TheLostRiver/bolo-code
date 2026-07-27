/**
 * CLI TUI 行为契约：输入框、turn 活动态与时间线角色。
 *
 * 这里只测纯 reducer/renderer 与注入式 writer，不依赖真人 TTY。
 */
import {
  applyTuiInputKey,
  attachSessionEventPrinter,
  createCliOnEvent,
  createSessionEventPrinter,
  createTuiInputState,
  createTurnActivityIndicator,
  formatTurnActivityLine,
  measureTerminalText,
  readTuiInput,
  renderInkLayout,
  renderTuiInputBox,
  renderUserMessage,
  runOnePrompt,
} from '../packages/cli/src/index.ts'
import { EventEmitter } from 'node:events'
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

  // Raw driver must restore mode and remove listeners after every submitted line.
  class FakeRawInput extends EventEmitter {
    isTTY = true
    isRaw = false
    rawModes: boolean[] = []
    paused = false

    setRawMode(mode: boolean): void {
      this.isRaw = mode
      this.rawModes.push(mode)
    }

    resume(): this {
      this.paused = false
      return this
    }

    pause(): this {
      this.paused = true
      return this
    }

    setEncoding(): this {
      return this
    }
  }
  const fakeInput = new FakeRawInput()
  const driverOut: string[] = []
  const pendingInput = readTuiInput({
    input: fakeInput as never,
    writeOut: (text) => driverOut.push(text),
    columns: 50,
    color: false,
  })
  fakeInput.emit('keypress', 'h', { name: 'h', sequence: 'h' })
  fakeInput.emit('keypress', 'i', { name: 'i', sequence: 'i' })
  fakeInput.emit('keypress', '\r', { name: 'return', sequence: '\r' })
  const driverResult = await pendingInput
  assert(
    driverResult.type === 'submit' && driverResult.value === 'hi',
    'raw driver submits edited value',
  )
  assert(
    fakeInput.rawModes.join(',') === 'true,false',
    `raw mode restored: ${fakeInput.rawModes.join(',')}`,
  )
  assert(fakeInput.listenerCount('keypress') === 0, 'keypress listener removed')
  assert(fakeInput.paused, 'stdin paused after idle editor exits')

  // 欢迎区不再伪装成输入框，也不显示巨型 logo / 内部实现名。
  const welcome = renderInkLayout({
    columns: 100,
    plain: false,
    cwd: 'E:\\DEV\\HelsincyAgent',
    model: 'work/gpt-test',
    sessionId: 'sess_test',
    env: {} as NodeJS.ProcessEnv,
  })
  assert(welcome.includes('BOLO'), 'welcome identifies product')
  assert(!welcome.includes('ink-equiv'), 'internal renderer name is hidden')
  assert(!welcome.includes('bolo>'), 'welcome has no fake input')
  assert(!welcome.includes('____'), 'giant ASCII logo is removed')

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
  const delayedEvents = createCliOnEvent({
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
    onEvent: delayedEvents.onEvent,
    askPermission: async () => 'deny',
  })
  attachSessionEventPrinter(delayedSession, delayedEvents.printer)
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
