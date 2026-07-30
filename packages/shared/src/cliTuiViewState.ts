/**
 * OI-14B · CLI live view-state
 *
 * 这里只保存 TUI 的业务事实和稳定身份。terminal width、wrap、cursor、timer 与
 * renderer 都是调用方职责，不能进入 shared reducer。
 */

import type { ChatMessage, SessionPhase } from './index.ts'
import type { ToolPresentation } from './toolPresentation.ts'
import { COMPACT_SUMMARY_MARKER } from './turnTimeline.ts'
import {
  createCliCommandSurfaceState,
  reduceCliCommandSurfaceState,
  type CliCommandSurfaceAction,
  type CliCommandSurfaceState,
} from './cliCommandSurface.ts'

export const CLI_TUI_BLOCK_STATUSES = [
  'streaming',
  'running',
  'complete',
  'error',
  'interrupted',
] as const

export type CliTuiBlockStatus = (typeof CLI_TUI_BLOCK_STATUSES)[number]

export const CLI_TUI_BLOCK_KINDS = [
  'user',
  'assistant',
  'reasoning',
  'tool',
  'search',
  'error',
  'warning',
  'summary',
] as const

export type CliTuiBlockKind = (typeof CLI_TUI_BLOCK_KINDS)[number]

export type CliTuiBlockBase = {
  id: string
  turnId: string
  kind: CliTuiBlockKind
  status: CliTuiBlockStatus
  /** activity controller 写入的当前 segment 独立耗时 */
  elapsedMs?: number
}

export type CliTuiUserBlock = CliTuiBlockBase & {
  kind: 'user'
  text: string
}

export type CliTuiAssistantBlock = CliTuiBlockBase & {
  kind: 'assistant'
  /** raw Markdown/source；不能保存按 terminal width 折好的行 */
  text: string
}

export type CliTuiReasoningBlock = CliTuiBlockBase & {
  kind: 'reasoning'
  text: string
}

export type CliTuiToolBlock = CliTuiBlockBase & {
  kind: 'tool'
  callId: string
  name: string
  input?: unknown
  argumentsJson?: string
  progress?: string
  /** 缺省表示没有结果；空字符串表示工具明确返回空结果 */
  output?: string
  ok?: boolean
  path?: string
  added?: number
  removed?: number
  summaryLine?: string
  ansiUnified?: string
  files?: Array<{
    path: string
    op?: string
    added?: number
    removed?: number
  }>
  cellCollapsed?: string
  cellExpanded?: string
  presentation?: ToolPresentation
}

export type CliTuiSearchCitation = {
  url: string
  title?: string
}

export type CliTuiSearchBlock = CliTuiBlockBase & {
  kind: 'search'
  query?: string
  resultCount?: number
  citations: CliTuiSearchCitation[]
}

export type CliTuiErrorBlock = CliTuiBlockBase & {
  kind: 'error'
  message: string
}

export type CliTuiWarningBlock = CliTuiBlockBase & {
  kind: 'warning'
  message: string
  source: 'warning' | 'model_retry' | 'ptl_retry'
}

export type CliTuiSummaryBlock = CliTuiBlockBase & {
  kind: 'summary'
  text: string
}

export type CliTuiBlock =
  | CliTuiUserBlock
  | CliTuiAssistantBlock
  | CliTuiReasoningBlock
  | CliTuiToolBlock
  | CliTuiSearchBlock
  | CliTuiErrorBlock
  | CliTuiWarningBlock
  | CliTuiSummaryBlock

export type CliTuiTerminal = {
  reason: string
  detail?: string
}

export type CliTuiTurnStatus =
  | 'running'
  | 'complete'
  | 'error'
  | 'interrupted'

export type CliTuiTurnState = {
  id: string
  status: CliTuiTurnStatus
  blocks: CliTuiBlock[]
  terminal?: CliTuiTerminal
}

export const CLI_TUI_COMPOSER_MODES = [
  'editing',
  'running',
  'disabled',
] as const

export type CliTuiComposerMode = (typeof CLI_TUI_COMPOSER_MODES)[number]

export type CliTuiComposerState = {
  mode: CliTuiComposerMode
}

export const CLI_TUI_OVERLAY_MODES = [
  'none',
  'permission',
  'question',
  'picker',
  'provider',
  'effort',
  'diff',
  'pager',
] as const

export type CliTuiOverlayMode = (typeof CLI_TUI_OVERLAY_MODES)[number]

export type CliTuiPermissionPreview = {
  added: number
  removed: number
  paths: string[]
  summaryText: string
  unifiedPreview?: string
}

export type CliTuiPermissionRequest = {
  id: string
  name: string
  input: unknown
  preview?: CliTuiPermissionPreview
}

export type CliTuiOverlayState =
  | { mode: 'none' }
  | { mode: 'permission'; request: CliTuiPermissionRequest }
  | { mode: 'question' }
  | { mode: 'picker' }
  | { mode: 'provider' }
  | { mode: 'effort' }
  | { mode: 'diff' }
  | { mode: 'pager' }

export type CliTuiViewState = {
  turns: CliTuiTurnState[]
  phase: SessionPhase | string
  activeTurnId: string | null
  /** 只按语义 turn 增长，不随 provider chunk 增长 */
  nextTurnSequence: number
  composer: CliTuiComposerState
  overlay: CliTuiOverlayState
  commandSurface: CliCommandSurfaceState
}

/**
 * 与 core SessionEvent / QueryLoopEvent 结构兼容的共享窄输入。
 * shared 不反向 import core；hosted web_search 也在这里显式建模。
 */
export type CliTuiSessionEvent =
  | { type: 'phase'; phase: SessionPhase | string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'reasoning_end' }
  | { type: 'summary'; text: string }
  | {
      type: 'tool_start'
      id: string
      name: string
      input: unknown
      argumentsJson?: string
    }
  | {
      type: 'tool_progress'
      id: string
      name: string
      message: string
    }
  | {
      type: 'tool_end'
      id: string
      name: string
      output?: string
      ok: boolean
      path?: string
      added?: number
      removed?: number
      summaryLine?: string
      ansiUnified?: string
      files?: Array<{
        path: string
        op?: string
        added?: number
        removed?: number
      }>
      cellCollapsed?: string
      cellExpanded?: string
      presentation?: ToolPresentation
    }
  | {
      type: 'web_search'
      phase: 'query' | 'results' | 'citation'
      query?: string
      resultCount?: number
      url?: string
      title?: string
    }
  | {
      type: 'permission_request'
      id: string
      name: string
      input: unknown
      preview?: CliTuiPermissionPreview
    }
  | {
      type: 'permission_decision'
      mode: string
      behavior: string
      reason: string
    }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | {
      type: 'ptl_retry'
      attempt: number
      maxRetries: number
      droppedMessageCount: number
    }
  | {
      type: 'model_retry'
      attempt: number
      maxRetries: number
      delayMs: number
      message: string
      reason: string
      status?: number
    }
  | { type: 'hook'; event: string; exitCode: number; blocked?: boolean }
  | {
      type: 'mcp_list_changed'
      server: string
      kind: 'tools' | 'resources' | 'prompts'
      toolCount: number
      resourceCount: number
      promptCount: number
    }
  | {
      type: 'control'
      kind: 'steer'
      controlId: string
      boundary: string
      prompt: string
    }
  | {
      type: 'background_result'
      taskId: string
      status: string
      boundary: string
    }
  | { type: 'mid_turn_compact'; ok: boolean }
  | { type: 'todo_reminder' }
  | { type: 'done'; terminal?: CliTuiTerminal }

export type CliTuiViewAction =
  | {
      type: 'begin_turn'
      turnId?: string
      prompt?: string
      echoUser?: boolean
    }
  | { type: 'session_event'; event: CliTuiSessionEvent }
  | { type: 'end_turn'; terminal?: CliTuiTerminal }
  | { type: 'restore_messages'; messages: readonly ChatMessage[] }
  | { type: 'set_composer_mode'; mode: CliTuiComposerMode }
  | { type: 'set_overlay'; overlay: CliTuiOverlayState }
  | { type: 'command_surface'; action: CliCommandSurfaceAction }
  | { type: 'set_block_elapsed'; blockId: string; elapsedMs: number }
  | { type: 'finish_thinking_segment'; elapsedMs: number }

export function createCliTuiViewState(): CliTuiViewState {
  return {
    turns: [],
    phase: 'idle',
    activeTurnId: null,
    nextTurnSequence: 0,
    composer: { mode: 'editing' },
    overlay: { mode: 'none' },
    commandSurface: createCliCommandSurfaceState(),
  }
}

export function projectCliTuiSessionEvent(
  event: CliTuiSessionEvent,
): CliTuiViewAction {
  return { type: 'session_event', event }
}

function replaceBlock(
  turn: CliTuiTurnState,
  index: number,
  block: CliTuiBlock,
): CliTuiTurnState {
  const blocks = turn.blocks.slice()
  blocks[index] = block
  return { ...turn, blocks }
}

function mapActiveTurn(
  state: CliTuiViewState,
  update: (turn: CliTuiTurnState) => CliTuiTurnState,
): CliTuiViewState {
  if (state.activeTurnId === null) return state
  const index = state.turns.findIndex((turn) => turn.id === state.activeTurnId)
  if (index < 0) return state
  const current = state.turns[index]!
  const next = update(current)
  if (next === current) return state
  const turns = state.turns.slice()
  turns[index] = next
  return { ...state, turns }
}

function closeStreamingBlocks(turn: CliTuiTurnState): CliTuiTurnState {
  let changed = false
  const blocks = turn.blocks.map((block): CliTuiBlock => {
    const shouldClose =
      ((block.kind === 'assistant' || block.kind === 'reasoning') &&
        block.status === 'streaming') ||
      (block.kind === 'search' && block.status === 'running')
    if (!shouldClose) return block
    changed = true
    return { ...block, status: 'complete' }
  })
  return changed ? { ...turn, blocks } : turn
}

function closeReasoningSegment(turn: CliTuiTurnState): CliTuiTurnState {
  let changed = false
  const blocks = turn.blocks.map((block): CliTuiBlock => {
    if (block.kind !== 'reasoning' || block.status !== 'streaming') {
      return block
    }
    changed = true
    return { ...block, status: 'complete' }
  })
  return changed ? { ...turn, blocks } : turn
}

function nextSequentialBlockId(turn: CliTuiTurnState): string {
  return `${turn.id}:block-${turn.blocks.length}`
}

function appendTextSegment(
  turn: CliTuiTurnState,
  kind: 'assistant' | 'reasoning',
  text: string,
): CliTuiTurnState {
  if (!text) return turn
  const lastIndex = turn.blocks.length - 1
  const last = turn.blocks[lastIndex]
  if (last?.kind === kind && last.status === 'streaming') {
    return replaceBlock(turn, lastIndex, {
      ...last,
      text: last.text + text,
    })
  }

  const closed = closeStreamingBlocks(turn)
  const block: CliTuiAssistantBlock | CliTuiReasoningBlock = {
    id: nextSequentialBlockId(closed),
    turnId: closed.id,
    kind,
    status: 'streaming',
    text,
  }
  return { ...closed, blocks: [...closed.blocks, block] }
}

function appendSummary(
  turn: CliTuiTurnState,
  text: string,
): CliTuiTurnState {
  const closed = closeStreamingBlocks(turn)
  const block: CliTuiSummaryBlock = {
    id: nextSequentialBlockId(closed),
    turnId: closed.id,
    kind: 'summary',
    status: 'complete',
    text,
  }
  return { ...closed, blocks: [...closed.blocks, block] }
}

type CliTuiToolEvent = Extract<
  CliTuiSessionEvent,
  { type: 'tool_start' | 'tool_progress' | 'tool_end' }
>

function updateToolBlock(
  turn: CliTuiTurnState,
  event: CliTuiToolEvent,
): CliTuiTurnState {
  const closed = closeStreamingBlocks(turn)
  const index = closed.blocks.findIndex(
    (block) => block.kind === 'tool' && block.callId === event.id,
  )
  const current =
    index >= 0 && closed.blocks[index]!.kind === 'tool'
      ? (closed.blocks[index] as CliTuiToolBlock)
      : undefined

  if (
    current &&
    event.type !== 'tool_end' &&
    (current.status === 'complete' ||
      current.status === 'error' ||
      current.status === 'interrupted')
  ) {
    return closed
  }

  let block: CliTuiToolBlock
  if (event.type === 'tool_start') {
    block = {
      ...(current ?? {
        id: `${closed.id}:tool:${event.id}`,
        turnId: closed.id,
        kind: 'tool' as const,
        callId: event.id,
      }),
      status: 'running',
      name: event.name,
      input: event.input,
      ...(event.argumentsJson !== undefined
        ? { argumentsJson: event.argumentsJson }
        : {}),
    }
  } else if (event.type === 'tool_progress') {
    block = {
      ...(current ?? {
        id: `${closed.id}:tool:${event.id}`,
        turnId: closed.id,
        kind: 'tool' as const,
        callId: event.id,
      }),
      status: 'running',
      name: event.name,
      progress: event.message,
    }
  } else {
    block = {
      ...(current ?? {
        id: `${closed.id}:tool:${event.id}`,
        turnId: closed.id,
        kind: 'tool' as const,
        callId: event.id,
      }),
      status: event.ok ? 'complete' : 'error',
      name: event.name,
      ok: event.ok,
      ...('output' in event ? { output: event.output } : {}),
      ...(event.path !== undefined ? { path: event.path } : {}),
      ...(event.added !== undefined ? { added: event.added } : {}),
      ...(event.removed !== undefined ? { removed: event.removed } : {}),
      ...(event.summaryLine !== undefined
        ? { summaryLine: event.summaryLine }
        : {}),
      ...(event.ansiUnified !== undefined
        ? { ansiUnified: event.ansiUnified }
        : {}),
      ...(event.files !== undefined ? { files: event.files } : {}),
      ...(event.cellCollapsed !== undefined
        ? { cellCollapsed: event.cellCollapsed }
        : {}),
      ...(event.cellExpanded !== undefined
        ? { cellExpanded: event.cellExpanded }
        : {}),
      ...(event.presentation !== undefined
        ? { presentation: event.presentation }
        : {}),
    }
  }

  if (index >= 0) return replaceBlock(closed, index, block)
  return { ...closed, blocks: [...closed.blocks, block] }
}

type CliTuiSearchEvent = Extract<
  CliTuiSessionEvent,
  { type: 'web_search' }
>

function updateSearchBlock(
  turn: CliTuiTurnState,
  event: CliTuiSearchEvent,
): CliTuiTurnState {
  if (event.phase === 'query') {
    const closed = closeStreamingBlocks(turn)
    const block: CliTuiSearchBlock = {
      id: nextSequentialBlockId(closed),
      turnId: closed.id,
      kind: 'search',
      status: 'running',
      ...(event.query !== undefined ? { query: event.query } : {}),
      citations: [],
    }
    return { ...closed, blocks: [...closed.blocks, block] }
  }

  let index = -1
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    if (turn.blocks[i]!.kind === 'search') {
      index = i
      break
    }
  }

  if (index < 0) {
    const closed = closeStreamingBlocks(turn)
    const block: CliTuiSearchBlock = {
      id: nextSequentialBlockId(closed),
      turnId: closed.id,
      kind: 'search',
      status: 'running',
      ...(event.phase === 'results' && event.resultCount !== undefined
        ? { resultCount: event.resultCount }
        : {}),
      ...(event.phase === 'citation' && event.url
        ? {
            citations: [
              {
                url: event.url,
                ...(event.title !== undefined ? { title: event.title } : {}),
              },
            ],
          }
        : { citations: [] }),
    }
    return { ...closed, blocks: [...closed.blocks, block] }
  }

  const current = turn.blocks[index] as CliTuiSearchBlock
  if (event.phase === 'results') {
    if (
      event.resultCount === undefined ||
      current.resultCount === event.resultCount
    ) {
      return turn
    }
    return replaceBlock(turn, index, {
      ...current,
      resultCount: event.resultCount,
    })
  }

  if (!event.url || current.citations.some((item) => item.url === event.url)) {
    return turn
  }
  return replaceBlock(turn, index, {
    ...current,
    citations: [
      ...current.citations,
      {
        url: event.url,
        ...(event.title !== undefined ? { title: event.title } : {}),
      },
    ],
  })
}

function appendErrorBlock(
  turn: CliTuiTurnState,
  message: string,
): CliTuiTurnState {
  const closed = closeStreamingBlocks(turn)
  const block: CliTuiErrorBlock = {
    id: nextSequentialBlockId(closed),
    turnId: closed.id,
    kind: 'error',
    status: 'error',
    message,
  }
  return { ...closed, blocks: [...closed.blocks, block] }
}

function appendWarningBlock(
  turn: CliTuiTurnState,
  message: string,
  source: CliTuiWarningBlock['source'],
): CliTuiTurnState {
  const closed = closeStreamingBlocks(turn)
  const block: CliTuiWarningBlock = {
    id: nextSequentialBlockId(closed),
    turnId: closed.id,
    kind: 'warning',
    status: 'complete',
    message,
    source,
  }
  return { ...closed, blocks: [...closed.blocks, block] }
}

function normalizedTerminal(
  terminal: CliTuiTerminal | undefined,
): CliTuiTerminal {
  return terminal ?? { reason: 'completed' }
}

function turnStatusForTerminal(
  terminal: CliTuiTerminal,
): CliTuiTurnStatus {
  if (terminal.reason === 'completed') return 'complete'
  if (
    terminal.reason === 'error' ||
    terminal.reason === 'user_prompt_blocked'
  ) {
    return 'error'
  }
  return 'interrupted'
}

function finishTurn(
  turn: CliTuiTurnState,
  terminalInput: CliTuiTerminal | undefined,
): CliTuiTurnState {
  const terminal = normalizedTerminal(terminalInput)
  let hasMissingTool = false
  const blocks = turn.blocks.map((block): CliTuiBlock => {
    if (block.status !== 'streaming' && block.status !== 'running') {
      return block
    }

    if (terminal.reason === 'completed') {
      if (block.kind === 'tool') {
        hasMissingTool = true
        return { ...block, status: 'interrupted' }
      }
      return { ...block, status: 'complete' }
    }

    if (
      terminal.reason === 'error' ||
      terminal.reason === 'user_prompt_blocked'
    ) {
      return { ...block, status: 'error' }
    }
    return { ...block, status: 'interrupted' }
  })

  const terminalStatus = turnStatusForTerminal(terminal)
  return {
    ...turn,
    blocks,
    status:
      terminalStatus === 'complete' && hasMissingTool
        ? 'interrupted'
        : terminalStatus,
    terminal,
  }
}

function finishActiveTurn(
  state: CliTuiViewState,
  terminal?: CliTuiTerminal,
): CliTuiViewState {
  const finished = mapActiveTurn(state, (turn) => finishTurn(turn, terminal))
  return {
    ...finished,
    activeTurnId: null,
    phase: 'ready',
    composer: { mode: 'editing' },
    overlay: { mode: 'none' },
  }
}

function allocateTurnId(
  state: CliTuiViewState,
  requested: string | undefined,
): { id: string; nextTurnSequence: number } {
  if (
    requested &&
    !state.turns.some((existing) => existing.id === requested)
  ) {
    return {
      id: requested,
      nextTurnSequence: state.nextTurnSequence + 1,
    }
  }

  let sequence = state.nextTurnSequence
  let id = `turn-${sequence}`
  while (state.turns.some((existing) => existing.id === id)) {
    sequence++
    id = `turn-${sequence}`
  }
  return { id, nextTurnSequence: sequence + 1 }
}

function beginTurn(
  state: CliTuiViewState,
  action: Extract<CliTuiViewAction, { type: 'begin_turn' }>,
): CliTuiViewState {
  const base =
    state.activeTurnId === null
      ? state
      : finishActiveTurn(state, { reason: 'interrupted' })
  const allocated = allocateTurnId(base, action.turnId)
  const blocks: CliTuiBlock[] = []
  if (action.echoUser !== false && action.prompt !== undefined) {
    blocks.push({
      id: `${allocated.id}:user`,
      turnId: allocated.id,
      kind: 'user',
      status: 'complete',
      text: action.prompt,
    })
  }
  const turn: CliTuiTurnState = {
    id: allocated.id,
    status: 'running',
    blocks,
  }
  return {
    ...base,
    turns: [...base.turns, turn],
    activeTurnId: allocated.id,
    nextTurnSequence: allocated.nextTurnSequence,
    phase: 'running',
    composer: { mode: 'running' },
    overlay: { mode: 'none' },
  }
}

function reduceSessionEvent(
  state: CliTuiViewState,
  event: CliTuiSessionEvent,
): CliTuiViewState {
  switch (event.type) {
    case 'phase': {
      const composer =
        event.phase === 'ended'
          ? ({ mode: 'disabled' } as const)
          : state.activeTurnId === null &&
              (event.phase === 'idle' || event.phase === 'ready')
            ? ({ mode: 'editing' } as const)
            : state.composer
      return { ...state, phase: event.phase, composer }
    }
    case 'text':
      return mapActiveTurn(state, (turn) =>
        appendTextSegment(turn, 'assistant', event.text),
      )
    case 'reasoning':
      return mapActiveTurn(state, (turn) =>
        appendTextSegment(turn, 'reasoning', event.text),
      )
    case 'reasoning_end':
      return mapActiveTurn(state, closeReasoningSegment)
    case 'summary':
      return mapActiveTurn(state, (turn) => appendSummary(turn, event.text))
    case 'tool_start':
    case 'tool_progress':
    case 'tool_end':
      return mapActiveTurn(state, (turn) => updateToolBlock(turn, event))
    case 'web_search':
      return mapActiveTurn(state, (turn) => updateSearchBlock(turn, event))
    case 'error':
      return mapActiveTurn(state, (turn) =>
        appendErrorBlock(turn, event.message),
      )
    case 'warning':
      return mapActiveTurn(state, (turn) =>
        appendWarningBlock(turn, event.message, 'warning'),
      )
    case 'ptl_retry':
      return mapActiveTurn(state, (turn) =>
        appendWarningBlock(
          turn,
          `Prompt retry ${event.attempt}/${event.maxRetries}; dropped ${event.droppedMessageCount} message(s)`,
          'ptl_retry',
        ),
      )
    case 'model_retry':
      return mapActiveTurn(state, (turn) =>
        appendWarningBlock(
          turn,
          `Model retry ${event.attempt}/${event.maxRetries}: ${event.message}`,
          'model_retry',
        ),
      )
    case 'permission_request': {
      const closed = mapActiveTurn(state, closeStreamingBlocks)
      return {
        ...closed,
        phase: 'awaiting_permission',
        composer: { mode: 'running' },
        overlay: {
          mode: 'permission',
          request: {
            id: event.id,
            name: event.name,
            input: event.input,
            ...(event.preview !== undefined ? { preview: event.preview } : {}),
          },
        },
      }
    }
    case 'permission_decision':
      return {
        ...state,
        phase: state.activeTurnId === null ? state.phase : 'running',
        overlay: { mode: 'none' },
      }
    case 'done':
      return finishActiveTurn(state, event.terminal)
    case 'hook':
    case 'mcp_list_changed':
    case 'control':
    case 'background_result':
    case 'mid_turn_compact':
    case 'todo_reminder':
      return state
  }
}

function updateBlockElapsed(
  state: CliTuiViewState,
  blockId: string,
  elapsedMs: number,
): CliTuiViewState {
  if (!Number.isFinite(elapsedMs)) return state
  const normalized = Math.max(0, Math.round(elapsedMs))
  for (let turnIndex = 0; turnIndex < state.turns.length; turnIndex++) {
    const turn = state.turns[turnIndex]!
    const blockIndex = turn.blocks.findIndex((block) => block.id === blockId)
    if (blockIndex < 0) continue
    const block = turn.blocks[blockIndex]!
    if (block.elapsedMs === normalized) return state
    const nextTurn = replaceBlock(turn, blockIndex, {
      ...block,
      elapsedMs: normalized,
    })
    const turns = state.turns.slice()
    turns[turnIndex] = nextTurn
    return { ...state, turns }
  }
  return state
}

function finishThinkingSegment(
  state: CliTuiViewState,
  elapsedMs: number,
): CliTuiViewState {
  if (!Number.isFinite(elapsedMs)) return state
  const normalized = Math.max(0, Math.round(elapsedMs))
  return mapActiveTurn(state, (turn) => {
    const lastIndex = turn.blocks.length - 1
    const last = turn.blocks[lastIndex]
    if (last?.kind === 'reasoning') {
      if (last.elapsedMs !== undefined && last.status === 'complete') {
        return turn
      }
      return replaceBlock(turn, lastIndex, {
        ...last,
        status: 'complete',
        elapsedMs: normalized,
      })
    }

    const closed = closeStreamingBlocks(turn)
    const block: CliTuiReasoningBlock = {
      id: nextSequentialBlockId(closed),
      turnId: closed.id,
      kind: 'reasoning',
      status: 'complete',
      text: '',
      elapsedMs: normalized,
    }
    return { ...closed, blocks: [...closed.blocks, block] }
  })
}

export function reduceCliTuiViewState(
  state: CliTuiViewState,
  action: CliTuiViewAction,
): CliTuiViewState {
  switch (action.type) {
    case 'begin_turn':
      return beginTurn(state, action)
    case 'session_event':
      return reduceSessionEvent(state, action.event)
    case 'end_turn':
      return finishActiveTurn(state, action.terminal)
    case 'restore_messages': {
      const restored = createCliTuiViewStateFromMessages(action.messages)
      return {
        ...restored,
        commandSurface: reduceCliCommandSurfaceState(
          state.commandSurface,
          { type: 'reset' },
        ),
      }
    }
    case 'set_composer_mode':
      return state.composer.mode === action.mode
        ? state
        : { ...state, composer: { mode: action.mode } }
    case 'set_overlay':
      return { ...state, overlay: action.overlay }
    case 'command_surface': {
      const commandSurface = reduceCliCommandSurfaceState(
        state.commandSurface,
        action.action,
      )
      return commandSurface === state.commandSurface
        ? state
        : { ...state, commandSurface }
    }
    case 'set_block_elapsed':
      return updateBlockElapsed(state, action.blockId, action.elapsedMs)
    case 'finish_thinking_segment':
      return finishThinkingSegment(state, action.elapsedMs)
  }
}

export function selectCliTuiActiveBlock(
  state: CliTuiViewState,
): CliTuiBlock | undefined {
  if (state.activeTurnId === null) return undefined
  const turn = state.turns.find((item) => item.id === state.activeTurnId)
  if (!turn) return undefined
  for (let index = turn.blocks.length - 1; index >= 0; index--) {
    const block = turn.blocks[index]!
    if (block.status === 'streaming' || block.status === 'running') {
      return block
    }
  }
  return undefined
}

function isCompactSummary(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    message.content.startsWith(COMPACT_SUMMARY_MARKER)
  )
}

function parseToolInput(argumentsJson: string): unknown {
  if (!argumentsJson) return {}
  try {
    return JSON.parse(argumentsJson)
  } catch {
    return { raw: argumentsJson }
  }
}

function isPersistedToolError(output: string): boolean {
  return output.includes('<tool_use_error>')
}

function replayEvent(
  state: CliTuiViewState,
  event: CliTuiSessionEvent,
): CliTuiViewState {
  return reduceCliTuiViewState(state, projectCliTuiSessionEvent(event))
}

/**
 * 把持久化 ChatMessage[] 投影为已完成历史。
 * reasoning_content 缺失时不猜测；缺 result 的 tool 由 end_turn 标为 interrupted。
 */
export function createCliTuiViewStateFromMessages(
  messages: readonly ChatMessage[],
): CliTuiViewState {
  const resultByCallId = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      resultByCallId.set(message.tool_call_id, message.content)
    }
  }

  let state = createCliTuiViewState()
  const ensureTurn = (): void => {
    if (state.activeTurnId !== null) return
    state = reduceCliTuiViewState(state, {
      type: 'begin_turn',
      echoUser: false,
    })
  }
  const closeTurn = (): void => {
    if (state.activeTurnId === null) return
    state = reduceCliTuiViewState(state, { type: 'end_turn' })
  }

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue

    if (isCompactSummary(message)) {
      ensureTurn()
      state = replayEvent(state, { type: 'summary', text: message.content })
      continue
    }

    if (message.role === 'user') {
      closeTurn()
      state = reduceCliTuiViewState(state, {
        type: 'begin_turn',
        prompt: message.content,
      })
      continue
    }

    ensureTurn()
    if (message.reasoning_content?.length) {
      state = replayEvent(state, {
        type: 'reasoning',
        text: message.reasoning_content,
      })
      state = replayEvent(state, { type: 'reasoning_end' })
    }
    if (message.content?.length) {
      state = replayEvent(state, { type: 'text', text: message.content })
    }
    for (const call of message.tool_calls ?? []) {
      state = replayEvent(state, {
        type: 'tool_start',
        id: call.id,
        name: call.name,
        input: parseToolInput(call.arguments),
        argumentsJson: call.arguments,
      })
      if (resultByCallId.has(call.id)) {
        const output = resultByCallId.get(call.id)!
        state = replayEvent(state, {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          output,
          ok: !isPersistedToolError(output),
        })
      }
    }
  }

  closeTurn()
  return state
}
