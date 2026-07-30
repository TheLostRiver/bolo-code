/**
 * OUT-1: shared tool presentation plus core pre-truncation projection.
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getWorkspaceSessionsDir } from '../packages/config/src/index.ts'
import {
  runToolUse,
  type ToolExecutionEvent,
} from '../packages/core/src/index.ts'
import {
  DEFAULT_TOOL_PREVIEW_MAX_CHARS,
  classifyToolPresentation,
  createCliTuiViewState,
  createToolPresentation,
  isToolPresentation,
  projectCliTuiSessionEvent,
  reduceCliTuiViewState,
  type CliTuiSessionEvent,
} from '../packages/shared/src/index.ts'
import { buildTool } from '../packages/tools/src/index.ts'

async function main(): Promise<void> {
  assert.equal(classifyToolPresentation('Read', false), 'read')
  assert.equal(classifyToolPresentation('Bash', false), 'shell')
  assert.equal(classifyToolPresentation('Grep', false), 'search')
  assert.equal(classifyToolPresentation('mcp__docs__lookup', false), 'mcp')
  assert.equal(classifyToolPresentation('Anything', true), 'error')

  const ansiCjk =
    '\u001b[31m第一行\u001b[0m\n' +
    '中间内容'.repeat(40) +
    '\n最后一行'
  const direct = createToolPresentation({
    toolName: 'Read',
    toolInput: { path: '文档/故事.txt' },
    output: ansiCjk,
    retainedOutput: '第一行\n…\n最后一行',
    truncated: true,
    maxPreviewChars: 80,
    fullResult: {
      kind: 'session-file',
      path: 'C:\\safe\\tool-result.txt',
      bytes: Buffer.byteLength(ansiCjk, 'utf8'),
    },
  })
  assert.equal(direct.originalChars, ansiCjk.length)
  assert.equal(direct.originalLines, 3)
  assert.equal(direct.retainedChars, '第一行\n…\n最后一行'.length)
  assert.equal(direct.retainedLines, 3)
  assert.equal(direct.truncated, true)
  assert.equal(direct.overflow, true)
  assert.equal(direct.previewMode, 'head')
  assert.ok(direct.preview)
  assert.ok(direct.preview.length <= 80)
  assert.ok(!direct.preview.includes('\u001b'))
  assert.ok(direct.summary.includes('Read'))
  assert.ok(direct.summary.includes('文档/故事.txt'))
  assert.ok(!/[\r\n\u001b]/u.test(direct.summary))
  assert.equal(isToolPresentation(direct), true)

  const empty = createToolPresentation({
    toolName: 'Generic',
    output: '',
    retainedOutput: '',
    truncated: false,
  })
  assert.equal(empty.originalLines, 0)
  assert.equal(empty.retainedLines, 0)
  assert.equal(empty.preview, undefined)
  assert.equal(empty.overflow, false)
  assert.equal(isToolPresentation(empty), true)

  const longLine = createToolPresentation({
    toolName: 'Bash',
    toolInput: { command: 'node very-long-command.js' },
    output: 'x'.repeat(DEFAULT_TOOL_PREVIEW_MAX_CHARS + 500),
    retainedOutput: 'x'.repeat(DEFAULT_TOOL_PREVIEW_MAX_CHARS + 500),
    truncated: false,
  })
  assert.equal(longLine.previewMode, 'tail')
  assert.ok(longLine.preview)
  assert.ok(longLine.preview.length <= DEFAULT_TOOL_PREVIEW_MAX_CHARS)
  assert.equal(longLine.overflow, true)

  const failed = createToolPresentation({
    toolName: 'Bash',
    toolInput: { command: 'exit 2' },
    output: '\u001b[31mfailed\u001b[0m',
    retainedOutput: '<tool_use_error>failed</tool_use_error>',
    truncated: false,
    ok: false,
    isError: true,
  })
  assert.ok(failed.summary.includes('failed'))
  assert.ok(!failed.preview?.includes('\u001b'))

  assert.equal(
    isToolPresentation({
      ...empty,
      summary: 'bad\nsummary',
    }),
    false,
  )
  assert.equal(
    isToolPresentation({
      ...empty,
      fullResult: { kind: 'session-file', path: '', bytes: -1 },
    }),
    false,
  )

  const tempRoot = path.resolve('.bolo-tmp', 'test-tool-presentation')
  const cwd = path.join(tempRoot, 'workspace')
  const configDir = path.join(tempRoot, 'user')
  await fs.rm(tempRoot, { recursive: true, force: true })
  await fs.mkdir(cwd, { recursive: true })
  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = configDir

  try {
    const fullOutput = `${ansiCjk}\n${'尾部'.repeat(100)}`
    const tool = buildTool({
      name: 'Read',
      description: 'OUT-1 long result fixture.',
      requiresPermission: false,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      inputJSONSchema: { type: 'object', properties: {} },
      async call() {
        return { ok: true, output: fullOutput }
      },
    })

    const run = async (sessionId: string, callId = 'same/call') => {
      const events: ToolExecutionEvent[] = []
      const result = await runToolUse(
        { id: callId, name: tool.name, input: { path: 'large.txt' } },
        {
          sessionId,
          cwd,
          hooks: {},
          permissionMode: 'bypassPermissions',
          askPermission: async () => 'allow',
          tools: [tool],
          maxToolResultChars: 80,
          onEvent: (event) => {
            if (
              event.type === 'tool_start' ||
              event.type === 'tool_progress' ||
              event.type === 'tool_end'
            ) {
              events.push(event)
            }
          },
        },
      )
      const ended = events.find(
        (event): event is Extract<ToolExecutionEvent, { type: 'tool_end' }> =>
          event.type === 'tool_end',
      )
      assert.ok(ended)
      return { result, ended }
    }

    const first = await run('session-a')
    const second = await run('session-b')
    const collision = await run('session-a', 'same_call')
    assert.equal(first.result.presentation, first.ended.presentation)
    assert.equal(first.result.presentation.originalChars, fullOutput.length)
    assert.equal(first.result.presentation.truncated, true)
    assert.equal(first.result.presentation.overflow, true)
    assert.ok(first.result.presentation.preview)
    assert.ok(
      first.result.presentation.preview.length <=
        DEFAULT_TOOL_PREVIEW_MAX_CHARS,
    )
    assert.ok(first.result.presentation.fullResult)
    assert.ok(second.result.presentation.fullResult)
    assert.notEqual(
      first.result.presentation.fullResult.path,
      second.result.presentation.fullResult.path,
    )
    assert.notEqual(
      first.result.presentation.fullResult.path,
      collision.result.presentation.fullResult?.path,
    )

    const spillRoot = path.resolve(
      getWorkspaceSessionsDir(cwd),
      'tool-results',
    )
    for (const current of [first, second, collision]) {
      const ref = current.result.presentation.fullResult!
      const relative = path.relative(spillRoot, ref.path)
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      assert.equal(await fs.readFile(ref.path, 'utf8'), fullOutput)
      assert.equal(ref.bytes, Buffer.byteLength(fullOutput, 'utf8'))
      assert.ok(current.result.toolResultMessage.content.includes(ref.path))
      assert.notEqual(current.result.toolResultMessage.content, fullOutput)
    }

    let view = createCliTuiViewState()
    view = reduceCliTuiViewState(view, {
      type: 'begin_turn',
      prompt: 'read the file',
    })
    view = reduceCliTuiViewState(
      view,
      projectCliTuiSessionEvent(first.ended as CliTuiSessionEvent),
    )
    const toolBlock = view.turns[0]?.blocks.find(
      (block) => block.kind === 'tool',
    )
    assert.ok(toolBlock?.kind === 'tool')
    assert.deepEqual(toolBlock.presentation, first.result.presentation)
    assert.equal(
      toolBlock.presentation?.preview,
      first.result.presentation.preview,
    )
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.BOLO_CONFIG_DIR
    } else {
      process.env.BOLO_CONFIG_DIR = previousConfigDir
    }
    await fs.rm(tempRoot, { recursive: true, force: true })
  }

  console.log('PASS: OUT-1 shared tool presentation')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
