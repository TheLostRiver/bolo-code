import type { ToolResultChunkReader } from '../../../core/src/index.ts'
import {
  DEFAULT_TOOL_RESULT_CHUNK_BYTES,
  readToolResultFileChunk,
} from '../../../core/src/index.ts'
import type { ToolResultReference } from '../../../shared/src/index.ts'
import { resolveTuiContentGutter } from './contentLayout.ts'
import { wrapTerminalText } from './terminalText.ts'
import type {
  LazyTextPagerLoadRequest,
  LazyTextPagerLoadResult,
  LazyTextPagerSource,
} from './textPager.ts'

export type ToolResultFilePagerOptions = {
  cwd: string
  sessionId: string
  reference: ToolResultReference
  chunkBytes?: number
  readChunk?: ToolResultChunkReader
}

type TerminalSanitizerState = {
  mode: 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc'
  skipLf: boolean
}

function normalizeChunkText(
  value: string,
  state: TerminalSanitizerState,
): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (state.mode === 'esc') {
      state.mode =
        code === 91
          ? 'csi'
          : code === 93
            ? 'osc'
            : 'text'
      continue
    }
    if (state.mode === 'csi') {
      if (code >= 64 && code <= 126) state.mode = 'text'
      continue
    }
    if (state.mode === 'osc') {
      if (code === 7) state.mode = 'text'
      else if (code === 27) state.mode = 'osc-esc'
      continue
    }
    if (state.mode === 'osc-esc') {
      if (code === 92) state.mode = 'text'
      else state.mode = code === 27 ? 'osc-esc' : 'osc'
      continue
    }
    if (code === 27) {
      state.mode = 'esc'
      continue
    }
    if (code === 13) {
      output += '\n'
      state.skipLf = true
      continue
    }
    if (code === 10) {
      if (state.skipLf) {
        state.skipLf = false
        continue
      }
      output += '\n'
      continue
    }
    state.skipLf = false
    if (code === 9) {
      output += '  '
      continue
    }
    if (code < 32 || (code >= 127 && code <= 159)) continue
    output += value[index]
  }
  return output
}

async function loadToolResultVisualPage(
  options: ToolResultFilePagerOptions,
  request: LazyTextPagerLoadRequest,
): Promise<LazyTextPagerLoadResult> {
  const page = Number.isFinite(request.page)
    ? Math.max(0, Math.floor(request.page))
    : 0
  const pageSize = Number.isFinite(request.pageSize)
    ? Math.max(1, Math.floor(request.pageSize))
    : 18
  const columns = Number.isFinite(request.columns)
    ? Math.max(1, Math.floor(request.columns))
    : 80
  const contentWidth = Math.max(
    1,
    columns - resolveTuiContentGutter(columns),
  )
  const startLine = page * pageSize
  const endLine = startLine + pageSize
  const readChunk = options.readChunk ?? readToolResultFileChunk
  const chunkBytes = Number.isFinite(options.chunkBytes)
    ? Math.max(4, Math.floor(options.chunkBytes!))
    : DEFAULT_TOOL_RESULT_CHUNK_BYTES

  let offset = 0
  let logicalCarry = ''
  const sanitizer: TerminalSanitizerState = {
    mode: 'text',
    skipLf: false,
  }
  let visualLineIndex = 0
  let eof = false
  let hasNext = false
  let stopped = false
  const lines: string[] = []

  const emit = (line: string): void => {
    if (visualLineIndex >= startLine && visualLineIndex < endLine) {
      lines.push(line)
    } else if (visualLineIndex >= endLine) {
      hasNext = true
      stopped = true
    }
    visualLineIndex += 1
  }

  const processText = (text: string, flush: boolean): void => {
    const parts = `${logicalCarry}${normalizeChunkText(
      text,
      sanitizer,
    )}`.split('\n')
    logicalCarry = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of wrapTerminalText(part, contentWidth)) {
        emit(line)
        if (stopped) return
      }
    }
    if (stopped) return
    const wrappedCarry = wrapTerminalText(logicalCarry, contentWidth)
    if (flush) {
      for (const line of wrappedCarry) {
        emit(line)
        if (stopped) return
      }
      logicalCarry = ''
      return
    }
    if (wrappedCarry.length > 1) {
      for (const line of wrappedCarry.slice(0, -1)) {
        emit(line)
        if (stopped) return
      }
      logicalCarry = wrappedCarry.at(-1) ?? ''
    }
  }

  while (!eof && !stopped) {
    if (request.signal?.aborted) {
      return {
        ok: false,
        reason: 'aborted',
        message: 'tool result page load was aborted',
      }
    }
    const chunk = await readChunk({
      cwd: options.cwd,
      sessionId: options.sessionId,
      reference: options.reference,
      offset,
      maxBytes: chunkBytes,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    if (!chunk.ok) return chunk
    if (!chunk.eof && chunk.nextOffset <= offset) {
      return {
        ok: false,
        reason: 'read-error',
        message: 'tool result reader made no forward progress',
      }
    }
    offset = chunk.nextOffset
    eof = chunk.eof
    processText(chunk.text, eof)
  }

  if (eof && visualLineIndex === 0) emit('')
  const pageCount = eof
    ? Math.max(1, Math.ceil(visualLineIndex / pageSize))
    : undefined
  return {
    ok: true,
    page: pageCount === undefined ? page : Math.min(page, pageCount - 1),
    lines,
    hasNext,
    ...(pageCount !== undefined ? { pageCount } : {}),
  }
}

export function createToolResultFilePagerSource(
  options: ToolResultFilePagerOptions,
): LazyTextPagerSource {
  return {
    loadPage: (request) =>
      loadToolResultVisualPage(options, request),
  }
}
