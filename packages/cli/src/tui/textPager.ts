import {
  clipTerminalText,
  measureTerminalText,
  wrapTerminalText,
} from './terminalText.ts'
import { resolveTuiContentGutter } from './contentLayout.ts'

export type TextPagerContent = {
  key: string
  title: string
  content: string
}

export type LazyTextPagerLoadRequest = {
  page: number
  columns: number
  pageSize: number
  signal?: AbortSignal
}

export type LazyTextPagerLoadResult =
  | {
      ok: true
      page: number
      lines: string[]
      hasNext: boolean
      pageCount?: number
    }
  | {
      ok: false
      reason: string
      message: string
    }

export type LazyTextPagerSource = {
  loadPage(
    request: LazyTextPagerLoadRequest,
  ): Promise<LazyTextPagerLoadResult>
}

export type FormatTextPagerScreenOptions = {
  title: string
  content: string
  columns?: number
  page?: number
  pageSize?: number
  color?: boolean
}

export type RenderedTextPagerScreen = {
  text: string
  lines: string[]
  page: number
  pageCount: number
  pageSize: number
}

export type FormatLazyTextPagerScreenOptions = {
  title: string
  lines?: readonly string[]
  page: number
  pageCount?: number
  columns?: number
  color?: boolean
  loading?: boolean
  error?: string
  fallbackContent?: string
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.floor(value!))
    : fallback
}

export function resolveEmbeddedTextPagerPageSize(rows: number): number {
  return Math.min(18, Math.max(1, Math.floor(rows) - 6))
}

export function formatTextPagerScreen(
  options: FormatTextPagerScreenOptions,
): RenderedTextPagerScreen {
  const columns = normalizePositive(options.columns, 80)
  const pageSize = normalizePositive(options.pageSize, 18)
  const gutter = Math.min(
    Math.max(0, columns - 1),
    resolveTuiContentGutter(columns),
  )
  const indent = ' '.repeat(gutter)
  const contentWidth = Math.max(1, columns - gutter)
  const contentLines = wrapTerminalText(options.content, contentWidth)
  const pageCount = Math.max(1, Math.ceil(contentLines.length / pageSize))
  const requestedPage = Number.isFinite(options.page)
    ? Math.floor(options.page!)
    : 0
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage))
  const body = contentLines.slice(
    page * pageSize,
    (page + 1) * pageSize,
  )

  const color = options.color !== false
  const accent = color ? '\u001b[38;5;81m' : ''
  const dim = color ? '\u001b[38;5;244m' : ''
  const reset = color ? '\u001b[0m' : ''
  const title = clipTerminalText(options.title.trim() || 'Details', contentWidth)
  const divider = '─'.repeat(
    Math.max(1, Math.min(contentWidth, measureTerminalText(title) + 8)),
  )
  const footer = clipTerminalText(
    `${page + 1}/${pageCount} · ↑/↓ page · q/Esc close`,
    contentWidth,
  )
  const lines = [
    `${indent}${accent}${title}${reset}`,
    `${indent}${dim}${divider}${reset}`,
    ...body.map((line) => `${indent}${line}`),
    `${indent}${dim}${footer}${reset}`,
  ]
  return {
    text: lines.join('\n'),
    lines,
    page,
    pageCount,
    pageSize,
  }
}

export function formatLazyTextPagerScreen(
  options: FormatLazyTextPagerScreenOptions,
): string[] {
  const columns = normalizePositive(options.columns, 80)
  const gutter = Math.min(
    Math.max(0, columns - 1),
    resolveTuiContentGutter(columns),
  )
  const indent = ' '.repeat(gutter)
  const contentWidth = Math.max(1, columns - gutter)
  const color = options.color !== false
  const accent = color ? '\u001b[38;5;81m' : ''
  const error = color ? '\u001b[38;5;203m' : ''
  const dim = color ? '\u001b[38;5;244m' : ''
  const reset = color ? '\u001b[0m' : ''
  const title = clipTerminalText(
    options.title.trim() || 'Details',
    contentWidth,
  )
  const divider = '─'.repeat(
    Math.max(1, Math.min(contentWidth, measureTerminalText(title) + 8)),
  )
  let body: string[]
  if (options.loading) {
    body = [`${dim}Loading page ${options.page + 1}...${reset}`]
  } else if (options.error) {
    body = [
      `${error}${clipTerminalText(options.error, contentWidth)}${reset}`,
    ]
    if (options.fallbackContent) {
      body.push(
        ...wrapTerminalText(
          options.fallbackContent,
          contentWidth,
        ).slice(0, 8),
      )
    }
  } else {
    body = [...(options.lines ?? [])]
  }
  const total =
    options.pageCount === undefined ? '?' : String(options.pageCount)
  const footer = clipTerminalText(
    `${options.page + 1}/${total} · ↑/↓ page · q/Esc close`,
    contentWidth,
  )
  return [
    `${indent}${accent}${title}${reset}`,
    `${indent}${dim}${divider}${reset}`,
    ...body.map((line) => `${indent}${line}`),
    `${indent}${dim}${footer}${reset}`,
  ]
}
