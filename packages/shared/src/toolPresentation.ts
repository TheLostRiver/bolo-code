export const DEFAULT_TOOL_PREVIEW_MAX_CHARS = 4_000
const DEFAULT_TOOL_SUMMARY_MAX_CHARS = 240

const DEFAULT_TOOL_PREVIEW_MAX_LINES = 20

const TOOL_PRESENTATION_KINDS = [
  'read',
  'shell',
  'search',
  'write',
  'todo',
  'mcp',
  'generic',
  'error',
] as const

export type ToolPresentationKind = (typeof TOOL_PRESENTATION_KINDS)[number]
export type ToolPreviewMode = 'head' | 'tail' | 'head-tail'

export type ToolResultReference = {
  kind: 'session-file'
  path: string
  bytes: number
}

export type ToolPresentation = {
  summary: string
  preview?: string
  previewMode?: ToolPreviewMode
  originalChars: number
  originalLines: number
  retainedChars: number
  retainedLines: number
  truncated: boolean
  overflow: boolean
  fullResult?: ToolResultReference
}

export type CreateToolPresentationInput = {
  toolName: string
  toolInput?: unknown
  output: string
  retainedOutput: string
  truncated: boolean
  ok?: boolean
  isError?: boolean
  maxPreviewChars?: number
  fullResult?: ToolResultReference
}

const PREVIEW_MODES = new Set<ToolPreviewMode>([
  'head',
  'tail',
  'head-tail',
])
function stripTerminalSequences(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[@-_]/gu, '')
}

function sanitizeDisplayText(value: string): string {
  const source = stripTerminalSequences(value)
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

function logicalLineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split(/\r\n|\r|\n/u).length
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
  if (maxChars <= 1) return '…'.slice(0, maxChars)
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
  if (mode === 'head') return [...lines.slice(0, maxLines - 1), '…'].join('\n')
  if (mode === 'tail') return ['…', ...lines.slice(-(maxLines - 1))].join('\n')
  const remaining = Math.max(0, maxLines - 1)
  const headLines = Math.ceil(remaining / 2)
  const tailLines = remaining - headLines
  return [
    ...lines.slice(0, headLines),
    '…',
    ...(tailLines > 0 ? lines.slice(-tailLines) : []),
  ].join('\n')
}

function previewPolicy(kind: ToolPresentationKind): {
  mode: ToolPreviewMode
  maxLines: number
} {
  if (kind === 'shell') return { mode: 'tail', maxLines: 10 }
  if (kind === 'search') return { mode: 'head', maxLines: 5 }
  if (kind === 'mcp' || kind === 'generic') {
    return { mode: 'head-tail', maxLines: 3 }
  }
  if (kind === 'error') return { mode: 'head-tail', maxLines: 20 }
  return { mode: 'head', maxLines: DEFAULT_TOOL_PREVIEW_MAX_LINES }
}

function recordString(input: unknown, keys: readonly string[]): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }
  const record = input as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function oneLine(value: string, maxChars: number): string {
  const clean = sanitizeDisplayText(value).replace(/\s+/gu, ' ').trim()
  return capCharacters(clean, maxChars, 'head')
}

function errorDetail(output: string): string | undefined {
  const withoutTags = output.replace(/<\/?tool_use_error>/giu, '')
  const detail = oneLine(withoutTags, 120)
  return detail || undefined
}

export function classifyToolPresentation(
  toolName: string,
  isError: boolean,
): ToolPresentationKind {
  if (isError) return 'error'
  const name = toolName.trim().toLowerCase()
  if (name.startsWith('mcp__')) return 'mcp'
  if (
    name === 'read' ||
    name === 'readfile' ||
    name === 'read_file'
  ) {
    return 'read'
  }
  if (name === 'bash' || name === 'shell' || name.includes('shell')) {
    return 'shell'
  }
  if (
    name === 'grep' ||
    name === 'glob' ||
    name.includes('search') ||
    name.includes('find')
  ) {
    return 'search'
  }
  if (
    name === 'write' ||
    name === 'edit' ||
    name === 'apply_patch' ||
    name.includes('patch')
  ) {
    return 'write'
  }
  if (name === 'todowrite' || name.includes('todo')) return 'todo'
  return 'generic'
}

function summarizeTool(input: {
  toolName: string
  toolInput?: unknown
  kind: ToolPresentationKind
  output: string
  originalLines: number
  truncated: boolean
}): string {
  const toolName = oneLine(input.toolName, 64) || 'Tool'
  const detail =
    input.kind === 'read' || input.kind === 'write'
      ? recordString(input.toolInput, [
          'path',
          'file_path',
          'filePath',
          'target',
        ])
      : input.kind === 'shell'
        ? recordString(input.toolInput, ['command', 'cmd'])
        : input.kind === 'search'
          ? recordString(input.toolInput, [
              'query',
              'pattern',
              'path',
              'glob',
            ])
          : input.kind === 'mcp'
            ? recordString(input.toolInput, ['server', 'resource', 'uri'])
            : undefined
  const parts = [toolName]
  if (detail) parts.push(oneLine(detail, 120))
  if (input.kind === 'error') {
    const failure = errorDetail(input.output)
    parts.push(failure ? `failed: ${failure}` : 'failed')
  } else if (input.originalLines > 0) {
    parts.push(
      `${input.originalLines} line${input.originalLines === 1 ? '' : 's'}`,
    )
  } else {
    parts.push('empty result')
  }
  if (input.truncated) parts.push('truncated')
  return oneLine(parts.join(' · '), DEFAULT_TOOL_SUMMARY_MAX_CHARS) || 'Tool'
}

export function createToolPresentation(
  input: CreateToolPresentationInput,
): ToolPresentation {
  const originalChars = input.output.length
  const originalLines = logicalLineCount(input.output)
  const retainedChars = input.retainedOutput.length
  const retainedLines = logicalLineCount(input.retainedOutput)
  const kind = classifyToolPresentation(
    input.toolName,
    input.isError === true || input.ok === false,
  )
  const policy = previewPolicy(kind)
  const requestedMax = Number.isFinite(input.maxPreviewChars)
    ? Math.floor(input.maxPreviewChars!)
    : DEFAULT_TOOL_PREVIEW_MAX_CHARS
  const maxPreviewChars = Math.max(
    0,
    Math.min(DEFAULT_TOOL_PREVIEW_MAX_CHARS, requestedMax),
  )
  const cleanOutput = sanitizeDisplayText(input.output)
  const previewOverflow =
    cleanOutput.length > maxPreviewChars ||
    logicalLineCount(cleanOutput) > policy.maxLines
  const bounded =
    cleanOutput && maxPreviewChars > 0
      ? capCharacters(
          capLines(cleanOutput, policy.maxLines, policy.mode),
          maxPreviewChars,
          policy.mode,
        )
      : ''
  const presentation: ToolPresentation = {
    summary: summarizeTool({
      toolName: input.toolName,
      toolInput: input.toolInput,
      kind,
      output: input.output,
      originalLines,
      truncated: input.truncated,
    }),
    originalChars,
    originalLines,
    retainedChars,
    retainedLines,
    truncated: input.truncated,
    overflow: input.truncated || previewOverflow,
  }
  if (bounded) {
    presentation.preview = bounded
    presentation.previewMode = policy.mode
  }
  if (input.fullResult) presentation.fullResult = { ...input.fullResult }
  return presentation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function hasUnsafeSingleLineControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || (code >= 127 && code <= 159)) return true
  }
  return false
}

function hasUnsafePreviewControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 10) continue
    if (code < 32 || (code >= 127 && code <= 159)) return true
  }
  return false
}

function isAbsoluteFilePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\\\') ||
    /^[a-zA-Z]:[\\/]/u.test(value)
  )
}

export function isToolPresentation(value: unknown): value is ToolPresentation {
  if (!isRecord(value)) return false
  if (
    typeof value.summary !== 'string' ||
    value.summary.length === 0 ||
    value.summary.length > DEFAULT_TOOL_SUMMARY_MAX_CHARS ||
    hasUnsafeSingleLineControl(value.summary)
  ) {
    return false
  }
  if (
    !isNonNegativeInteger(value.originalChars) ||
    !isNonNegativeInteger(value.originalLines) ||
    !isNonNegativeInteger(value.retainedChars) ||
    !isNonNegativeInteger(value.retainedLines) ||
    typeof value.truncated !== 'boolean' ||
    typeof value.overflow !== 'boolean'
  ) {
    return false
  }
  if (value.preview === undefined) {
    if (value.previewMode !== undefined) return false
  } else {
    if (
      typeof value.preview !== 'string' ||
      value.preview.length === 0 ||
      value.preview.length > DEFAULT_TOOL_PREVIEW_MAX_CHARS ||
      hasUnsafePreviewControl(value.preview) ||
      typeof value.previewMode !== 'string' ||
      !PREVIEW_MODES.has(value.previewMode as ToolPreviewMode)
    ) {
      return false
    }
  }
  if (value.fullResult !== undefined) {
    if (!isRecord(value.fullResult)) return false
    if (
      value.fullResult.kind !== 'session-file' ||
      typeof value.fullResult.path !== 'string' ||
      value.fullResult.path.trim().length === 0 ||
      !isAbsoluteFilePath(value.fullResult.path) ||
      hasUnsafeSingleLineControl(value.fullResult.path) ||
      !isNonNegativeInteger(value.fullResult.bytes)
    ) {
      return false
    }
  }
  return true
}
