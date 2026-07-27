/**
 * OI-11B: timeline hierarchy, user block, and structured composer footer.
 */
import {
  createSessionEventPrinter,
  createTuiInputState,
  formatTuiTokenCount,
  measureTerminalText,
  renderTuiInputBox,
  renderUserMessage,
  resolveTuiFrameWidth,
  stripTerminalAnsi,
} from '../packages/cli/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function plainLines(text: string): string[] {
  return stripTerminalAnsi(text).split('\n')
}

async function main() {
  assert(formatTuiTokenCount(0) === '0', 'zero token format')
  assert(formatTuiTokenCount(999) === '999', 'sub-thousand token format')
  assert(formatTuiTokenCount(1_000) === '1k', 'one-thousand token format')
  assert(formatTuiTokenCount(20_234) === '20.2k', 'compact thousand precision')
  assert(formatTuiTokenCount(1_250_000) === '1.3m', 'compact million precision')

  const user = renderUserMessage('检查中文🙂\n第二行', {
    columns: 48,
    color: true,
  })
  assert(
    user.includes('\u001b[48;5;'),
    'submitted user message uses a terminal background',
  )
  const userLines = user.split('\n')
  assert(userLines.length === 2, 'user message preserves line structure')
  assert(
    userLines.every(
      (line) => measureTerminalText(line) === resolveTuiFrameWidth(48),
    ),
    'every user block row has stable frame width',
  )
  assert(stripTerminalAnsi(user).includes('❯ 检查中文🙂'), 'user marker remains visible')

  const userNoColor = renderUserMessage('plain user', {
    columns: 48,
    color: false,
  })
  assert(!userNoColor.includes('\u001b['), 'NO_COLOR user block has no ANSI')
  assert(
    measureTerminalText(userNoColor) === resolveTuiFrameWidth(48),
    'NO_COLOR keeps the same block geometry',
  )

  const out: string[] = []
  const printer = createSessionEventPrinter({
    writeOut: (text) => out.push(text),
    writeErr: (text) => out.push(text),
    timeline: true,
    color: false,
  })
  printer.beginTurn({
    prompt: 'timeline hierarchy',
    echoUser: true,
    activity: false,
  })
  printer.onEvent({ type: 'text', text: 'first line\nsec' })
  printer.onEvent({ type: 'text', text: 'ond line' })
  printer.onEvent({
    type: 'tool_end',
    id: 'tool_1',
    name: 'Read',
    ok: true,
  })
  printer.onEvent({ type: 'text', text: 'after tool' })
  printer.endTurn({ terminalReason: 'completed' })
  const timeline = plainLines(out.join(''))
  for (const expected of ['● Bolo', 'first line', 'second line', '✓ Read', 'after tool']) {
    const line = timeline.find((candidate) => candidate.includes(expected))
    assert(line !== undefined, `timeline contains ${expected}`)
    assert(line.startsWith('  '), `${expected} uses the shared gutter: ${line}`)
  }
  assert(
    !timeline.some(
      (line) =>
        line.startsWith('● Bolo') ||
        line.startsWith('first line') ||
        line.startsWith('second line'),
    ),
    'assistant content never starts in column zero',
  )

  const footer = renderTuiInputBox({
    state: createTuiInputState(),
    columns: 96,
    color: true,
    status: {
      permissionMode: 'default',
      providerId: 'work',
      model: 'gpt-5.6-sol',
      effortLevel: 'high',
      usage: {
        inputTokens: 20_234,
        outputTokens: 1_500,
        totalTokens: 21_734,
        estimated: false,
      },
    },
  })
  const footerText = stripTerminalAnsi(footer.text)
  assert(footerText.includes('work/gpt-5.6-sol'), 'footer names the active model')
  assert(footer.text.includes('\u001b[1m'), 'model/keys use highlighted weight')
  assert(footerText.includes('↓20.2k'), 'footer shows cumulative input tokens')
  assert(footerText.includes('↑1.5k'), 'footer shows cumulative output tokens')
  assert(footerText.includes('Enter send'), 'shortcut labels remain available')

  const estimated = renderTuiInputBox({
    state: createTuiInputState(),
    columns: 64,
    color: false,
    status: {
      model: 'fixture',
      usage: {
        inputTokens: 1_200,
        outputTokens: 300,
        totalTokens: 1_500,
        estimated: true,
      },
    },
  })
  assert(
    estimated.text.includes('~↓1.2k ↑300'),
    'estimated usage is explicitly marked',
  )

  for (const columns of [24, 38, 64, 96]) {
    const narrow = renderTuiInputBox({
      state: createTuiInputState(),
      columns,
      color: true,
      status: {
        permissionMode: 'acceptEdits',
        providerId: 'a-very-long-provider-name',
        model: 'a-very-long-model-name',
        effortLevel: 'ultrathink',
        usage: {
          inputTokens: 120_000,
          outputTokens: 8_000,
          totalTokens: 128_000,
        },
      },
    })
    assert(
      narrow.lines.every((line) => measureTerminalText(line) <= Math.max(24, columns - 2)),
      `${columns}-column footer never overflows`,
    )
  }

  console.log('PASS: CLI timeline hierarchy')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
