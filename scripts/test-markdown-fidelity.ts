/**
 * REN-1: markdown render-fidelity 自检 —
 * shared 纯契约（意图/产物对比）+ transcript/controller 集成（零误报、去重）。
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import {
  checkMarkdownFidelity,
  detectMarkdownIntent,
  detectMarkdownRenderedStructures,
  type MarkdownFidelityIssue,
} from '../packages/shared/src/index.ts'
import {
  createRetainedTuiController,
} from '../packages/cli/src/index.ts'
import { HeadlessTerminalHarness } from './lib/headlessTerminalHarness.ts'

const TABLE_SOURCE = [
  '| name | value |',
  '|------|-------|',
  '| a    | 1     |',
  '| b    | 2     |',
].join('\n')

const LIST_SOURCE = '- one\n- two\n1. three'

const CODE_SOURCE = '```ts\nconst x = 1\n```'

class RawInputHarness extends EventEmitter {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
}

class ResizableOutput extends EventEmitter {
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
}

async function settle(
  controller: { flush(): Promise<void> },
  terminal: { flush(): Promise<void> },
): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  await controller.flush()
  await terminal.flush()
}

async function main(): Promise<void> {
  // ---- shared: intent detection ----
  const intent = detectMarkdownIntent(
    `${TABLE_SOURCE}\n\n${LIST_SOURCE}\n\n${CODE_SOURCE}`,
  )
  assert.equal(intent.table, 1, 'table intent requires header + separator row')
  assert.equal(intent.list, 3, 'list intent counts line-start markers')
  assert.equal(intent['code-block'], 1, 'code intent counts fence pairs')
  assert.equal(
    detectMarkdownIntent('plain | pipe | text').table,
    0,
    'pipe text without a separator row is not a table intent',
  )
  assert.equal(
    detectMarkdownIntent('this - not a list').list,
    0,
    'mid-line dash is not a list intent',
  )
  assert.equal(
    detectMarkdownIntent('```\nunclosed')['code-block'],
    0,
    'odd fences are not a code intent',
  )

  // ---- shared: rendered structure detection ----
  assert.equal(
    detectMarkdownRenderedStructures(['│ a │ b │', '├───┼───┤']).table,
    1,
    'box-drawing borders count as rendered tables',
  )
  assert.equal(
    detectMarkdownRenderedStructures(['| a | b |']).table,
    1,
    'fallback raw syntax counts as rendered tables',
  )
  assert.equal(
    detectMarkdownRenderedStructures(['│ quote prefix']).table,
    0,
    'a single blockquote prefix is not a rendered table',
  )
  assert.equal(
    detectMarkdownRenderedStructures(['─'.repeat(20)]).table,
    0,
    'an HR rule is not a rendered table',
  )
  assert.equal(
    detectMarkdownRenderedStructures(['• one', '2. two']).list,
    2,
    'bullet and ordered markers count as rendered lists',
  )
  assert.equal(
    detectMarkdownRenderedStructures(['```', 'x', '```'])['code-block'],
    1,
    'fence pairs count as rendered code blocks',
  )

  // ---- shared: fidelity check ----
  const full = checkMarkdownFidelity(
    `${TABLE_SOURCE}\n\n${LIST_SOURCE}\n\n${CODE_SOURCE}`,
    ['│ a │ b │', '• one', '```', 'x', '```'],
  )
  assert.equal(full.length, 0, 'normally rendered structures produce zero issues')

  const lostTable = checkMarkdownFidelity(TABLE_SOURCE, [
    'plain paragraph without any pipe',
  ])
  assert.deepEqual(
    lostTable.map((issue: MarkdownFidelityIssue) => issue.kind),
    ['table'],
    'a table that fully vanished is reported',
  )
  assert.equal(lostTable[0]!.intent, 1)
  assert.equal(lostTable[0]!.rendered, 0)

  const fallbackTable = checkMarkdownFidelity(TABLE_SOURCE, ['| a | b |'])
  assert.equal(
    fallbackTable.length,
    0,
    'narrow-width fallback (raw syntax kept) is not a fidelity failure',
  )

  const lostList = checkMarkdownFidelity(LIST_SOURCE, ['one two three'])
  assert.deepEqual(
    lostList.map((issue: MarkdownFidelityIssue) => issue.kind),
    ['list'],
    'a list that fully vanished is reported',
  )

  const lostCode = checkMarkdownFidelity(CODE_SOURCE, ['const x = 1'])
  assert.deepEqual(
    lostCode.map((issue: MarkdownFidelityIssue) => issue.kind),
    ['code-block'],
    'a code block that fully vanished is reported',
  )

  // ---- integration: normal rendering, zero warnings, dedup ----
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(90, 40)
    const terminal = new HeadlessTerminalHarness({
      columns: 90,
      rows: 40,
      scrollback: 400,
    })
    const warnings: string[] = []
    const controller = createRetainedTuiController({
      writeOut: (text) => terminal.write(text),
      writeErr: (text) => terminal.write(text),
      input,
      output,
      env: { NO_COLOR: '1' },
    })
    // 覆写 printer.onEvent 捕获 fidelity warning，并转发非 warning 事件
    // （保证 markdown 内容真实进入 transcript 渲染）
    const originalOnEvent = controller.printer.onEvent.bind(controller.printer)
    const printerSpy = controller.printer as unknown as {
      onEvent: (event: {
        type: string
        message?: string
        text?: string
      }) => void
    }
    printerSpy.onEvent = (event) => {
      if (event.type === 'warning') warnings.push(event.message ?? '')
      else originalOnEvent(event)
    }
    controller.setWelcomeVisible(false)
    await controller.start()
    await terminal.flush()
    controller.printer.beginTurn({ prompt: 'render markdown' })
    controller.printer.onEvent({
      type: 'text',
      text: `intro\n\n${TABLE_SOURCE}\n\n${LIST_SOURCE}\n\n${CODE_SOURCE}`,
    })
    controller.printer.endTurn({ terminalReason: 'completed' })
    await settle(controller, terminal)
    assert(
      terminal.viewport().some((line) => line.text.includes('intro')),
      'markdown content genuinely reached the transcript renderer',
    )
    assert.equal(
      warnings.length,
      0,
      `normal markdown rendering produces zero fidelity warnings (got ${warnings.join('; ')})`,
    )
    await controller.stop()
    terminal.dispose()
  }

  // ---- integration: ANSI enabled (real terminal styles) still zero warnings ----
  {
    const input = new RawInputHarness()
    const output = new ResizableOutput(90, 40)
    const terminal = new HeadlessTerminalHarness({
      columns: 90,
      rows: 40,
      scrollback: 400,
    })
    const warnings: string[] = []
    const rawWrites: string[] = []
    const controller = createRetainedTuiController({
      writeOut: (text) => {
        rawWrites.push(text)
        terminal.write(text)
      },
      writeErr: (text) => {
        rawWrites.push(text)
        terminal.write(text)
      },
      input,
      output,
      env: { COLORTERM: 'truecolor' },
    })
    const originalOnEvent = controller.printer.onEvent.bind(controller.printer)
    const printerSpy = controller.printer as unknown as {
      onEvent: (event: {
        type: string
        message?: string
        text?: string
      }) => void
    }
    printerSpy.onEvent = (event) => {
      if (event.type === 'warning') warnings.push(event.message ?? '')
      else originalOnEvent(event)
    }
    controller.setWelcomeVisible(false)
    await controller.start()
    await terminal.flush()
    controller.printer.beginTurn({ prompt: 'render markdown' })
    controller.printer.onEvent({
      type: 'text',
      text: `intro\n\n${TABLE_SOURCE}\n\n${LIST_SOURCE}\n\n${CODE_SOURCE}`,
    })
    controller.printer.endTurn({ terminalReason: 'completed' })
    await settle(controller, terminal)
    assert(
      terminal.viewport().some((line) => line.text.includes('intro')),
      'ANSI fixture also renders markdown for real',
    )
    assert(
      rawWrites.join('').includes('\x1b['),
      'the ANSI-enabled fixture genuinely emits styled output',
    )
    assert.equal(
      warnings.length,
      0,
      `ANSI-styled markdown still produces zero fidelity warnings (got ${warnings.join('; ')})`,
    )
    await controller.stop()
    terminal.dispose()
  }

  console.log('PASS: REN-1 markdown render-fidelity self-check')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
