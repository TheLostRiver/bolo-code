/**
 * AR1C1：runtime query 纯文本 view。
 *
 * 只消费 shared RuntimeQueryView。终端尺寸、分页、颜色与二次 entity
 * filter 都由调用方显式提供；这里不读取进程状态，也不保存 cursor。
 */

import type {
  RuntimeListItem,
  RuntimeListView,
  RuntimeQueryEntity,
  RuntimeQueryView,
} from '../../shared/src/runtimeQuery.ts'

export type RuntimeTextRenderOptions = {
  /** 可见列数；每一行都会截断到该宽度。 */
  columns?: number
  /** 0-based page；越界时夹到最后一页。 */
  page?: number
  /** 每页正文行数，不含重复 header/footer。 */
  pageSize?: number
  /** ANSI 只由消费层显式开启。 */
  color?: boolean
  /** 仅对 runtime.list 生效的二次过滤。 */
  filter?: RuntimeQueryEntity | 'all'
}

export type RuntimeTextPage = {
  text: string
  page: number
  pageCount: number
  pageSize: number
  totalItems: number
  totalLines: number
  hasNext: boolean
  hasPrevious: boolean
}

type LineRole = 'title' | 'meta' | 'item' | 'empty' | 'footer'

const ANSI = {
  reset: '\u001b[0m',
  title: '\u001b[1;36m',
  meta: '\u001b[2m',
  item: '\u001b[36m',
  empty: '\u001b[2m',
  footer: '\u001b[33m',
} as const

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  )
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0
  if (
    codePoint === 0 ||
    codePoint === 0x200d ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f ||
    isCombiningCodePoint(codePoint)
  ) {
    return 0
  }
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0
  }
  return isWideCodePoint(codePoint) ? 2 : 1
}

function visibleWidth(text: string): number {
  let width = 0
  for (const character of text) width += characterWidth(character)
  return width
}

function truncateVisible(text: string, columns: number): string {
  if (visibleWidth(text) <= columns) return text
  if (columns === 1) return '…'

  const target = columns - 1
  let width = 0
  let result = ''
  for (const character of text) {
    const next = characterWidth(character)
    if (width + next > target) break
    result += character
    width += next
  }
  return `${result}…`
}

function paintLine(
  text: string,
  role: LineRole,
  options: { columns: number; color: boolean },
): string {
  const clipped = truncateVisible(text, options.columns)
  if (!options.color) return clipped
  return `${ANSI[role]}${clipped}${ANSI.reset}`
}

function formatRunner(view: RuntimeListView): string {
  return view.runner.state === 'running'
    ? `runner: running · turn=${view.runner.active.turnId}`
    : 'runner: idle'
}

function formatListItem(item: RuntimeListItem): string {
  const actions = item.availableActions.length
    ? item.availableActions.map((action) => action.action).join(',')
    : 'none'
  if (item.entity === 'turn') {
    return `  turn ${item.entityId} · ${item.record.state} · actions=${actions}`
  }
  if (item.entity === 'control') {
    return `  control ${item.entityId} · ${item.record.kind}/${item.record.state} · actions=${actions}`
  }
  return `  task ${item.entityId} · ${item.record.agentType}/${item.record.state} · actions=${actions}`
}

function listContent(
  view: RuntimeListView,
  filter: RuntimeTextRenderOptions['filter'],
): {
  headers: Array<{ text: string; role: LineRole }>
  body: Array<{ text: string; role: LineRole }>
  totalItems: number
} {
  const effectiveFilter = filter ?? view.entity
  const items =
    effectiveFilter === 'all'
      ? view.items
      : view.items.filter((item) => item.entity === effectiveFilter)
  const entityLabel = effectiveFilter ?? 'all'
  return {
    headers: [
      {
        text: `Runtime protocol v${view.protocolVersion}`,
        role: 'title',
      },
      {
        text: `session: ${view.sessionId} · phase=${view.phase}`,
        role: 'meta',
      },
      { text: formatRunner(view), role: 'meta' },
      {
        text: `${entityLabel} entities (${items.length}):`,
        role: 'meta',
      },
    ],
    body: items.length
      ? items.map((item) => ({
          text: formatListItem(item),
          role: 'item' as const,
        }))
      : [
          {
            text: `  (no ${entityLabel === 'all' ? 'runtime' : entityLabel} entities)`,
            role: 'empty',
          },
        ],
    totalItems: items.length,
  }
}

function inspectContent(
  view: Extract<RuntimeQueryView, { kind: 'runtime.inspect' }>,
): {
  headers: Array<{ text: string; role: LineRole }>
  body: Array<{ text: string; role: LineRole }>
  totalItems: number
} {
  return {
    headers: [
      {
        text: `Runtime protocol v${view.protocolVersion}`,
        role: 'title',
      },
      { text: `session: ${view.sessionId}`, role: 'meta' },
      {
        text: `${view.entity}: ${view.item.entityId}`,
        role: 'meta',
      },
    ],
    body: JSON.stringify(view.item, null, 2)
      .split('\n')
      .map((text) => ({ text, role: 'item' as const })),
    totalItems: 1,
  }
}

export function renderRuntimeText(
  view: RuntimeQueryView,
  options: RuntimeTextRenderOptions = {},
): RuntimeTextPage {
  const columns = normalizePositiveInteger(options.columns, 80)
  const pageSize = normalizePositiveInteger(options.pageSize, 20)
  const color = options.color === true
  const content =
    view.kind === 'runtime.list'
      ? listContent(view, options.filter)
      : inspectContent(view)
  const totalLines = content.body.length
  const pageCount = Math.max(1, Math.ceil(totalLines / pageSize))
  const requestedPage =
    typeof options.page === 'number' && Number.isFinite(options.page)
      ? Math.floor(options.page)
      : 0
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage))
  const body = content.body.slice(
    page * pageSize,
    (page + 1) * pageSize,
  )
  const lines = [
    ...content.headers.map(({ text, role }) =>
      paintLine(text, role, { columns, color }),
    ),
    ...body.map(({ text, role }) =>
      paintLine(text, role, { columns, color }),
    ),
  ]

  if (pageCount > 1) {
    const first = page * pageSize + 1
    const last = Math.min(totalLines, (page + 1) * pageSize)
    lines.push(
      paintLine(
        `[page ${page + 1}/${pageCount} · lines ${first}-${last}/${totalLines} · n next · p previous · q quit]`,
        'footer',
        { columns, color },
      ),
    )
  }

  return {
    text: lines.join('\n'),
    page,
    pageCount,
    pageSize,
    totalItems: content.totalItems,
    totalLines,
    hasNext: page + 1 < pageCount,
    hasPrevious: page > 0,
  }
}
