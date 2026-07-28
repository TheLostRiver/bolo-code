/**
 * OI-14B · CLI live view-state
 *
 * 这组测试只验证 packages/shared 的纯状态契约。terminal、renderer、stdout、
 * width/wrap 都属于后续切片，不能混进本刀。
 *
 * 运行：npx tsx scripts/test-cli-tui-view-state.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  COMPACT_SUMMARY_MARKER,
  createCliTuiViewState,
  createCliTuiViewStateFromMessages,
  projectCliTuiSessionEvent,
  reduceCliTuiViewState,
  selectCliTuiActiveBlock,
  type ChatMessage,
  type CliTuiSessionEvent,
  type CliTuiViewState,
} from '../packages/shared/src/index.ts'
import type { SessionEvent } from '../packages/core/src/index.ts'
import type { QueryLoopEvent } from '../packages/core/src/queryLoop.ts'
import type { ToolExecutionEvent } from '../packages/core/src/toolExecution.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert(a === e, `${msg}\nactual:   ${a}\nexpected: ${e}`)
}

function onEvent(
  state: CliTuiViewState,
  event: Parameters<typeof projectCliTuiSessionEvent>[0],
): CliTuiViewState {
  return reduceCliTuiViewState(state, projectCliTuiSessionEvent(event))
}

// 编译期护栏：shared 窄输入必须能直接消费三条真实事件源。
function acceptsCoreSessionEvent(event: SessionEvent): CliTuiSessionEvent {
  return event
}

function acceptsQueryLoopEvent(event: QueryLoopEvent): CliTuiSessionEvent {
  return event
}

function acceptsToolExecutionEvent(
  event: ToolExecutionEvent,
): CliTuiSessionEvent {
  return event
}

void acceptsCoreSessionEvent
void acceptsQueryLoopEvent
void acceptsToolExecutionEvent

function splitCharacters(text: string): string[] {
  return Array.from(text)
}

function splitFixedRandom(text: string, seed = 0x14b): string[] {
  const chunks: string[] = []
  let offset = 0
  let value = seed >>> 0
  while (offset < text.length) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    const size = 1 + (value % 7)
    chunks.push(text.slice(offset, offset + size))
    offset += size
  }
  return chunks
}

function runChunkedTurn(
  reasoningChunks: readonly string[],
  textChunks: readonly string[],
): CliTuiViewState {
  let state = createCliTuiViewState()
  state = reduceCliTuiViewState(state, {
    type: 'begin_turn',
    turnId: 'chunk-turn',
    prompt: '请分析这个函数',
  })
  for (const text of reasoningChunks) {
    state = onEvent(state, { type: 'reasoning', text })
  }
  state = onEvent(state, { type: 'reasoning_end' })
  for (const text of textChunks) {
    state = onEvent(state, { type: 'text', text })
  }
  state = onEvent(state, {
    type: 'done',
    terminal: { reason: 'completed' },
  })
  return state
}

async function main() {
  // ── 1) 初始态、显式 turn 边界与 reducer 纯度 ──
  {
    const initial = createCliTuiViewState()
    assert(initial.phase === 'idle', 'initial session phase is idle')
    assert(initial.activeTurnId === null, 'initial state has no active turn')
    assert(initial.turns.length === 0, 'initial state has no invented history')
    assert(initial.composer.mode === 'editing', 'composer starts mounted and editable')
    assert(initial.overlay.mode === 'none', 'no overlay is invented')

    const before = JSON.stringify(initial)
    const state = reduceCliTuiViewState(initial, {
      type: 'begin_turn',
      prompt: 'hello\nworld',
    })
    assert(JSON.stringify(initial) === before, 'reducer never mutates the prior state')
    assert(state.activeTurnId === 'turn-0', 'missing runtime id gets a deterministic turn id')
    assert(state.phase === 'running', 'begin_turn enters running phase')
    assert(state.composer.mode === 'running', 'running changes composer mode without removing it')
    const user = state.turns[0]!.blocks[0]!
    assert(user.kind === 'user', 'begin_turn projects the submitted user block')
    assert(user.id === 'turn-0:user', `user block id is stable: ${user.id}`)
    assert(user.text === 'hello\nworld', 'user source is preserved byte-for-byte')
    assert(user.status === 'complete', 'submitted user input is already complete')
  }

  // ── 1.1) activity 结束本段时，visible/silent thinking 共用一个永久 block ──
  {
    let state = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      turnId: 'silent-thinking',
      prompt: 'wait for the model',
    })
    state = reduceCliTuiViewState(state, {
      type: 'finish_thinking_segment',
      elapsedMs: 4_200,
    })
    const silentThought = state.turns[0]!.blocks[1]!
    assert(
      silentThought.kind === 'reasoning' &&
        silentThought.text === '' &&
        silentThought.status === 'complete' &&
        silentThought.elapsedMs === 4_200,
      `silent wait becomes one completed Thought block: ${JSON.stringify(silentThought)}`,
    )
    const unchanged = reduceCliTuiViewState(state, {
      type: 'finish_thinking_segment',
      elapsedMs: 9_900,
    })
    assert(
      unchanged === state,
      'consumed thinking segment cannot append a duplicate Thought block',
    )

    let visible = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      turnId: 'visible-thinking',
      prompt: 'show reasoning',
    })
    visible = onEvent(visible, { type: 'reasoning', text: 'Inspect first.' })
    visible = reduceCliTuiViewState(visible, {
      type: 'finish_thinking_segment',
      elapsedMs: 1_700,
    })
    const visibleThought = visible.turns[0]!.blocks[1]!
    assert(
      visibleThought.kind === 'reasoning' &&
        visibleThought.text === 'Inspect first.' &&
        visibleThought.status === 'complete' &&
        visibleThought.elapsedMs === 1_700,
      'visible reasoning is finalized in place by the same segment action',
    )
  }

  // ── 2) 多段 reasoning/text 与 tool/search 原位更新保持到达顺序 ──
  {
    let state = createCliTuiViewState()
    state = reduceCliTuiViewState(state, {
      type: 'begin_turn',
      turnId: 'runtime-turn-7',
      prompt: 'inspect',
    })
    state = onEvent(state, { type: 'reasoning', text: 'Plan' })
    state = onEvent(state, { type: 'reasoning', text: ' first' })

    const activeReasoning = selectCliTuiActiveBlock(state)
    assert(
      activeReasoning?.kind === 'reasoning',
      'reasoning delta exposes the active segment',
    )
    state = reduceCliTuiViewState(state, {
      type: 'set_block_elapsed',
      blockId: activeReasoning.id,
      elapsedMs: 4200,
    })
    state = onEvent(state, { type: 'reasoning_end' })
    assert(selectCliTuiActiveBlock(state) === undefined, 'reasoning_end closes that segment')

    state = onEvent(state, { type: 'text', text: 'Answer ' })
    state = onEvent(state, {
      type: 'tool_start',
      id: 'call-1',
      name: 'Bash',
      input: { command: 'npm test' },
    })
    const activeTool = selectCliTuiActiveBlock(state)
    assert(activeTool?.kind === 'tool', 'tool_start exposes the active tool block')
    state = reduceCliTuiViewState(state, {
      type: 'set_block_elapsed',
      blockId: activeTool.id,
      elapsedMs: 1700,
    })
    state = onEvent(state, {
      type: 'tool_progress',
      id: 'call-1',
      name: 'Bash',
      message: 'starting',
    })
    state = onEvent(state, {
      type: 'tool_progress',
      id: 'call-1',
      name: 'Bash',
      message: '97/124',
    })
    state = onEvent(state, {
      type: 'tool_end',
      id: 'call-1',
      name: 'Bash',
      output: 'PASS',
      ok: true,
      summaryLine: 'Bash completed',
    })
    state = onEvent(state, { type: 'reasoning', text: 'Verify' })
    state = onEvent(state, { type: 'reasoning_end' })
    state = onEvent(state, { type: 'text', text: 'done.' })
    state = onEvent(state, {
      type: 'web_search',
      phase: 'query',
      query: 'retained terminal renderer',
    })
    state = onEvent(state, {
      type: 'web_search',
      phase: 'results',
      resultCount: 2,
    })
    state = onEvent(state, {
      type: 'web_search',
      phase: 'citation',
      url: 'https://example.test/a',
      title: 'A',
    })
    state = onEvent(state, {
      type: 'web_search',
      phase: 'citation',
      url: 'https://example.test/a',
      title: 'duplicate must not replace A',
    })
    state = onEvent(state, {
      type: 'web_search',
      phase: 'citation',
      url: 'https://example.test/b',
    })

    const blocksBeforeDone = state.turns[0]!.blocks
    assertDeepEqual(
      blocksBeforeDone.map((block) => block.kind),
      ['user', 'reasoning', 'assistant', 'tool', 'reasoning', 'assistant', 'search'],
      'semantic blocks stay in arrival order',
    )
    assertDeepEqual(
      blocksBeforeDone.map((block) => block.id),
      [
        'runtime-turn-7:user',
        'runtime-turn-7:block-1',
        'runtime-turn-7:block-2',
        'runtime-turn-7:tool:call-1',
        'runtime-turn-7:block-4',
        'runtime-turn-7:block-5',
        'runtime-turn-7:block-6',
      ],
      'ids depend on turn/semantic segment or call id, never chunk count',
    )

    const firstReasoning = blocksBeforeDone[1]!
    assert(
      firstReasoning.kind === 'reasoning' &&
        firstReasoning.text === 'Plan first' &&
        firstReasoning.elapsedMs === 4200 &&
        firstReasoning.status === 'complete',
      `first reasoning segment is finalized in place: ${JSON.stringify(firstReasoning)}`,
    )
    const tool = blocksBeforeDone[3]!
    assert(
      tool.kind === 'tool' &&
        tool.id === 'runtime-turn-7:tool:call-1' &&
        tool.progress === '97/124' &&
        tool.output === 'PASS' &&
        tool.ok === true &&
        tool.elapsedMs === 1700 &&
        tool.status === 'complete',
      `tool start/progress/end update one block: ${JSON.stringify(tool)}`,
    )
    assert(
      blocksBeforeDone.filter((block) => block.kind === 'tool').length === 1,
      'tool progress never appends duplicate blocks',
    )
    const search = blocksBeforeDone[6]!
    assert(search.kind === 'search', 'hosted search remains separate from local tools')
    assert(search.query === 'retained terminal renderer', 'search query is retained')
    assert(search.resultCount === 2, 'search result count is updated in place')
    assertDeepEqual(
      search.citations,
      [
        { url: 'https://example.test/a', title: 'A' },
        { url: 'https://example.test/b' },
      ],
      'citations keep first-seen order and dedupe by URL',
    )

    state = onEvent(state, {
      type: 'done',
      terminal: { reason: 'completed' },
    })
    assert(state.activeTurnId === null, 'done clears the active turn')
    assert(state.phase === 'ready', 'completed turn returns the view to ready')
    assert(state.composer.mode === 'editing', 'composer becomes editable again')
    assert(state.turns[0]!.status === 'complete', 'completed terminal closes the turn')
    assert(
      state.turns[0]!.blocks[6]!.status === 'complete',
      'done finalizes the open search block',
    )
  }

  // ── 3) 缺 start 的 progress 可恢复，终态也只占一个 call-id block ──
  {
    let state = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      prompt: 'recover progress',
    })
    state = onEvent(state, {
      type: 'tool_progress',
      id: 'late-call',
      name: 'Read',
      message: 'halfway',
    })
    state = onEvent(state, {
      type: 'tool_end',
      id: 'late-call',
      name: 'Read',
      output: '',
      ok: true,
    })
    const tools = state.turns[0]!.blocks.filter((block) => block.kind === 'tool')
    assert(tools.length === 1, 'out-of-order progress/end still converge on one tool block')
    assert(
      tools[0]!.status === 'complete' &&
        'output' in tools[0]! &&
        tools[0]!.output === '',
      'an explicit empty result remains distinguishable from a missing result',
    )
  }

  // ── 4) abort/error 边界不把 partial 内容伪装成正常完成 ──
  {
    let aborted = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      prompt: 'stop',
    })
    aborted = onEvent(aborted, { type: 'text', text: 'partial' })
    aborted = onEvent(aborted, {
      type: 'done',
      terminal: { reason: 'aborted', detail: 'user cancelled' },
    })
    const turn = aborted.turns[0]!
    const partial = turn.blocks[1]!
    assert(turn.status === 'interrupted', 'aborted terminal interrupts the turn')
    assert(
      partial.kind === 'assistant' && partial.status === 'interrupted',
      'open assistant content is marked interrupted',
    )
    assert(turn.terminal?.detail === 'user cancelled', 'terminal detail is preserved')

    let failed = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      prompt: 'fail',
    })
    failed = onEvent(failed, { type: 'text', text: 'prefix' })
    failed = onEvent(failed, { type: 'error', message: 'provider failed' })
    failed = onEvent(failed, {
      type: 'done',
      terminal: { reason: 'error', detail: 'provider failed' },
    })
    assert(failed.turns[0]!.status === 'error', 'error terminal marks the turn failed')
    const error = failed.turns[0]!.blocks.at(-1)!
    assert(
      error.kind === 'error' &&
        error.message === 'provider failed' &&
        error.status === 'error',
      'error remains a visible block with the real message',
    )
  }

  // ── 5) composer/overlay 是常驻状态，不由 renderer 临时猜测 ──
  {
    let state = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      prompt: 'permission',
    })
    state = onEvent(state, {
      type: 'permission_request',
      id: 'permission-1',
      name: 'Bash',
      input: { command: 'git status' },
      preview: {
        added: 0,
        removed: 0,
        paths: [],
        summaryText: 'Run git status',
      },
    })
    assert(state.overlay.mode === 'permission', 'permission event opens the overlay state')
    assert(
      state.overlay.mode === 'permission' &&
        state.overlay.request.name === 'Bash' &&
        JSON.stringify(state.overlay.request.input).includes('git status'),
      'permission overlay retains operation details needed for an informed choice',
    )
    assert(state.composer.mode === 'running', 'opening an overlay does not unmount composer state')

    state = onEvent(state, {
      type: 'permission_decision',
      mode: 'default',
      behavior: 'allow',
      reason: 'user approved',
    })
    assert(state.overlay.mode === 'none', 'permission decision closes its overlay')

    state = reduceCliTuiViewState(state, {
      type: 'set_overlay',
      overlay: { mode: 'effort' },
    })
    assert(state.overlay.mode === 'effort', 'non-permission overlays share the same host state')
    state = reduceCliTuiViewState(state, {
      type: 'set_composer_mode',
      mode: 'disabled',
    })
    assert(state.composer.mode === 'disabled', 'composer mode can be controlled explicitly')
  }

  // ── 6) 非正文 metadata 不得意外切断同一个 assistant segment ──
  {
    let state = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      prompt: 'metadata',
    })
    state = onEvent(state, { type: 'text', text: 'a' })
    state = onEvent(state, { type: 'phase', phase: 'running' })
    state = onEvent(state, { type: 'todo_reminder' })
    state = onEvent(state, {
      type: 'control',
      kind: 'steer',
      controlId: 'control-1',
      boundary: 'after_model',
      prompt: 'continue',
    })
    state = onEvent(state, { type: 'text', text: 'b' })
    state = onEvent(state, { type: 'done' })
    const assistant = state.turns[0]!.blocks.filter(
      (block) => block.kind === 'assistant',
    )
    assert(
      assistant.length === 1 && assistant[0]!.text === 'ab',
      'phase/control/reminder metadata leaves the streaming text segment intact',
    )
  }

  // ── 7) resume 投影保留事实、顺序和“空结果 vs 缺结果” ──
  {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `${COMPACT_SUMMARY_MARKER}\nsummary`,
      },
      { role: 'assistant', content: 'assistant-first history' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: 'before tool',
        reasoning_content: 'persisted thought',
        tool_calls: [
          { id: 'resume-ok', name: 'Read', arguments: '{"path":"a.ts"}' },
          { id: 'resume-missing', name: 'Bash', arguments: '{"command":"x"}' },
          { id: 'resume-error', name: 'Write', arguments: '{"path":"b.ts"}' },
        ],
      },
      { role: 'tool', tool_call_id: 'resume-ok', name: 'Read', content: '' },
      {
        role: 'tool',
        tool_call_id: 'resume-error',
        name: 'Write',
        content: '<tool_use_error>permission denied</tool_use_error>',
      },
      { role: 'assistant', content: 'after tool' },
    ]
    const before = JSON.stringify(messages)
    const first = createCliTuiViewStateFromMessages(messages)
    const second = createCliTuiViewStateFromMessages(messages)
    assertDeepEqual(first, second, 'the same resume snapshot gets the same ids and state')
    assert(JSON.stringify(messages) === before, 'resume projection never mutates messages')
    assert(first.turns.length === 2, 'summary history and the next user prompt form two turns')
    assertDeepEqual(
      first.turns[0]!.blocks.map((block) => block.kind),
      ['summary', 'assistant'],
      'compact summary is not mislabeled as user input',
    )
    assertDeepEqual(
      first.turns[1]!.blocks.map((block) => block.kind),
      ['user', 'reasoning', 'assistant', 'tool', 'tool', 'tool', 'assistant'],
      'persisted reasoning/text precede the tool calls they led to',
    )
    const restoredTools = first.turns[1]!.blocks.filter(
      (block) => block.kind === 'tool',
    )
    assert(
      restoredTools[0]!.status === 'complete' &&
        'output' in restoredTools[0]! &&
        restoredTools[0]!.output === '',
      'matched empty tool output is explicitly complete',
    )
    assert(
      restoredTools[1]!.status === 'interrupted' &&
      !('output' in restoredTools[1]!),
      'missing tool output is interrupted and stays absent',
    )
    assert(
      restoredTools[2]!.status === 'error' &&
        restoredTools[2]!.ok === false &&
        restoredTools[2]!.output?.includes('permission denied'),
      'persisted tool error markers remain failed after resume',
    )
    assert(
      first.turns[1]!.blocks.filter((block) => block.kind === 'reasoning').length ===
        1,
      'persisted reasoning is restored exactly once',
    )
    assert(first.activeTurnId === null, 'restored history is not treated as a live turn')
    assert(first.composer.mode === 'editing', 'composer is editable after history restore')

    const assistantFirst = createCliTuiViewStateFromMessages([
      { role: 'assistant', content: 'orphan but real' },
    ])
    assert(
      assistantFirst.turns.length === 1 &&
        assistantFirst.turns[0]!.blocks[0]!.kind === 'assistant',
      'assistant-first history is retained instead of dropped',
    )
    assert(
      assistantFirst.turns[0]!.blocks.every(
        (block) => block.kind !== 'reasoning',
      ),
      'resume never invents reasoning that was not persisted',
    )

    let replaced = reduceCliTuiViewState(createCliTuiViewState(), {
      type: 'begin_turn',
      prompt: 'temporary live state',
    })
    replaced = reduceCliTuiViewState(replaced, {
      type: 'restore_messages',
      messages,
    })
    assertDeepEqual(replaced, first, 'restore_messages uses the same projection semantics')
  }

  // ── 8) provider chunk 边界不能改变最终 state ──
  {
    const reasoning = '先确认边界，再验证 CJK/emoji ✅。'
    const answer = '## Result\n\n- stable id\n- exact raw Markdown\n'
    const whole = runChunkedTurn([reasoning], [answer])
    const characters = runChunkedTurn(
      ['', ...splitCharacters(reasoning), ''],
      ['', ...splitCharacters(answer), ''],
    )
    const fixedRandom = runChunkedTurn(
      splitFixedRandom(reasoning),
      splitFixedRandom(answer, 0x5eed),
    )
    assertDeepEqual(characters, whole, 'character chunks converge to whole-chunk state')
    assertDeepEqual(fixedRandom, whole, 'fixed-random chunks converge to whole-chunk state')
  }

  // ── 9) shared reducer 不能偷接 terminal/renderer/I/O ──
  {
    const source = await fs.readFile(
      path.join('packages', 'shared', 'src', 'cliTuiViewState.ts'),
      'utf8',
    )
    assert(
      !/from\s+['"](?:node:|@earendil-works\/pi-tui)/.test(source),
      'view-state imports neither Node I/O nor Pi renderer',
    )
    assert(!/\bprocess\./.test(source), 'view-state never reads process or terminal globals')
    assert(
      !/TerminalSurface|contentPrefixer|terminalMarkdown/.test(source),
      'view-state never depends on legacy surface/formatters',
    )
  }

  console.log('PASS: CLI TUI live view-state')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
