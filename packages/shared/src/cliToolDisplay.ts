import type { CliTuiToolBlock } from './cliTuiViewState.ts'
import {
  DEFAULT_TOOL_PREVIEW_MAX_CHARS,
  classifyToolPresentation,
  type ToolPreviewMode,
} from './toolPresentation.ts'

export const CLI_TOOL_PREVIEW_MAX_CHARS = DEFAULT_TOOL_PREVIEW_MAX_CHARS
export const CLI_TOOL_PREVIEW_MAX_LINES = 20
export const CLI_TOOL_RUNNING_TAIL_MAX_CHARS = 1_200
export const CLI_TOOL_RUNNING_TAIL_MAX_LINES = 8

export type CliToolDisplayMode = 'summary' | 'preview'

export type CliToolDisplayState = {
  mode: CliToolDisplayMode
}

export type CliToolDisplayAction =
  | { type: 'toggle' }
  | { type: 'set_mode'; mode: CliToolDisplayMode }

export type CliToolDisplayProjection = {
  mode: CliToolDisplayMode
  content: string
  overflow: boolean
  canOpenPager: boolean
}

function sanitizeDisplayText(value: string): string {
  const source = value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[@-_]/gu, '')
  let clean = ''
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) index += 1
      clean += '\n'
      continue
    }
    if (code === 10) {
      clean += '\n'
      continue
    }
    if (code === 9) {
      clean += '  '
      continue
    }
    if (code < 32 || (code >= 127 && code <= 159)) continue
    clean += source[index]
  }
  return clean
}

function safeSliceStart(value: string, end: number): string {
  const sliced = value.slice(0, end)
  const last = sliced.charCodeAt(sliced.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

function safeSliceEnd(value: string, start: number): string {
  let actualStart = start
  const first = value.charCodeAt(actualStart)
  if (first >= 0xdc00 && first <= 0xdfff) actualStart += 1
  return value.slice(actualStart)
}

function capCharacters(
  value: string,
  maxChars: number,
  mode: ToolPreviewMode,
): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 1) return '...'.slice(0, maxChars)
  if (mode === 'head') {
    return `${safeSliceStart(value, maxChars - 1)}…`
  }
  if (mode === 'tail') {
    return `…${safeSliceEnd(value, value.length - maxChars + 1)}`
  }
  const available = maxChars - 1
  const headChars = Math.ceil(available / 2)
  const tailChars = available - headChars
  return `${safeSliceStart(value, headChars)}…${safeSliceEnd(
    value,
    value.length - tailChars,
  )}`
}

function capLines(
  value: string,
  maxLines: number,
  mode: ToolPreviewMode,
): string {
  const lines = value.split('\n')
  if (lines.length <= maxLines) return value
  if (mode === 'head') {
    return [...lines.slice(0, maxLines - 1), '…'].join('\n')
  }
  if (mode === 'tail') {
    return ['…', ...lines.slice(-(maxLines - 1))].join('\n')
  }
  const remaining = Math.max(0, maxLines - 1)
  const headLines = Math.ceil(remaining / 2)
  const tailLines = remaining - headLines
  return [
    ...lines.slice(0, headLines),
    '…',
    ...(tailLines > 0 ? lines.slice(-tailLines) : []),
  ].join('\n')
}

function boundedText(
  value: string,
  options: {
    maxChars: number
    maxLines: number
    mode: ToolPreviewMode
  },
): string {
  const clean = sanitizeDisplayText(value).trim()
  if (!clean) return ''
  return capCharacters(
    capLines(clean, options.maxLines, options.mode),
    options.maxChars,
    options.mode,
  )
}

function previewMode(block: CliTuiToolBlock): ToolPreviewMode {
  if (block.presentation?.previewMode) return block.presentation.previewMode
  return classifyToolPresentation(
    block.name,
    block.status === 'error' || block.ok === false,
  ) === 'shell'
    ? 'tail'
    : 'head-tail'
}

function previewSource(block: CliTuiToolBlock): string {
  if (block.cellExpanded?.trim()) return block.cellExpanded
  if (block.presentation?.preview?.trim()) return block.presentation.preview
  if (block.ansiUnified?.trim()) {
    return block.summaryLine?.trim()
      ? `${block.summaryLine}\n${block.ansiUnified}`
      : block.ansiUnified
  }
  if (block.output?.trim()) return block.output
  if (block.summaryLine?.trim()) return block.summaryLine
  return ''
}

function boundedPreview(block: CliTuiToolBlock): string {
  return boundedText(previewSource(block), {
    maxChars: CLI_TOOL_PREVIEW_MAX_CHARS,
    maxLines: CLI_TOOL_PREVIEW_MAX_LINES,
    mode: previewMode(block),
  })
}

function inferredSummary(block: CliTuiToolBlock): string {
  if (block.cellCollapsed?.trim()) {
    return boundedText(block.cellCollapsed, {
      maxChars: 480,
      maxLines: 4,
      mode: 'head',
    })
  }
  if (block.presentation?.summary.trim()) return block.presentation.summary
  if (block.summaryLine?.trim()) {
    return boundedText(block.summaryLine, {
      maxChars: 480,
      maxLines: 4,
      mode: 'head',
    })
  }
  const source = sanitizeDisplayText(block.output ?? '')
  const lineCount = source ? source.split('\n').length : 0
  const result = lineCount > 0
    ? `${block.name} · ${lineCount} line${lineCount === 1 ? '' : 's'}`
    : `${block.name} · empty result`
  return boundedText(result, {
    maxChars: 240,
    maxLines: 1,
    mode: 'head',
  })
}

function inferredOverflow(block: CliTuiToolBlock): boolean {
  if (block.presentation) return block.presentation.overflow
  if (block.cellCollapsed?.trim() && block.cellExpanded?.trim()) return true
  const source = sanitizeDisplayText(previewSource(block))
  return (
    source.length > CLI_TOOL_PREVIEW_MAX_CHARS ||
    source.split('\n').length > CLI_TOOL_PREVIEW_MAX_LINES
  )
}

export function createCliToolDisplayState(
  block: CliTuiToolBlock,
  overrideMode?: CliToolDisplayMode,
): CliToolDisplayState {
  if (overrideMode) return { mode: overrideMode }
  if (block.status === 'running' || block.status === 'error' || block.ok === false) {
    return { mode: 'preview' }
  }
  return { mode: inferredOverflow(block) ? 'summary' : 'preview' }
}

export function reduceCliToolDisplayState(
  state: CliToolDisplayState,
  action: CliToolDisplayAction,
): CliToolDisplayState {
  if (action.type === 'set_mode') {
    return state.mode === action.mode ? state : { mode: action.mode }
  }
  return { mode: state.mode === 'summary' ? 'preview' : 'summary' }
}

export function projectCliToolDisplay(
  block: CliTuiToolBlock,
  state: CliToolDisplayState,
): CliToolDisplayProjection {
  if (block.status === 'running') {
    const content = boundedText(block.progress ?? '', {
      maxChars: CLI_TOOL_RUNNING_TAIL_MAX_CHARS,
      maxLines: CLI_TOOL_RUNNING_TAIL_MAX_LINES,
      mode: 'tail',
    })
    return {
      mode: 'preview',
      content,
      overflow:
        sanitizeDisplayText(block.progress ?? '').trim().length >
          content.length,
      canOpenPager: false,
    }
  }

  const preview = boundedPreview(block)
  const failed = block.status === 'error' || block.ok === false
  const mode = failed ? 'preview' : state.mode
  const content = mode === 'summary' ? inferredSummary(block) : preview
  return {
    mode,
    content,
    overflow: inferredOverflow(block),
    canOpenPager: preview.length > 0,
  }
}
