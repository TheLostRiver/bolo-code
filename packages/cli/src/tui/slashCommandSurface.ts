import type {
  SlashDisplayPolicy,
  SlashDisplayTone,
  SlashOverlayViewModel,
} from '../../../core/src/index.ts'
import type {
  CliCommandPanelInput,
  CliCommandToastInput,
} from '../../../shared/src/index.ts'
import { doesCliCommandPanelOverflow } from './retainedCommandSurface.ts'
import type { TextPagerContent } from './textPager.ts'

export type RetainedSlashDisplayProjection =
  | {
      kind: 'history'
      history: {
        content: string
        tone: SlashDisplayTone
      }
    }
  | {
      kind: 'toast'
      toast: CliCommandToastInput
    }
  | {
      kind: 'panel'
      panel: CliCommandPanelInput
    }
  | {
      kind: 'pager'
      pager: TextPagerContent
    }
  | {
      kind: 'catalog'
      catalog: {
        key: string
        title: string
        items: SlashOverlayViewModel['items']
        emptyMessage?: string
      }
    }

const DISPLAY_ACRONYMS = new Map([
  ['mcp', 'MCP'],
  ['api', 'API'],
])

function titleSegment(segment: string): string {
  const normalized = segment.trim().toLowerCase()
  const acronym = DISPLAY_ACRONYMS.get(normalized)
  if (acronym) return acronym
  return normalized
    ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`
    : ''
}

export function titleForSlashDisplayKey(key: string): string {
  const segments = key
    .replace(/^slash:/u, '')
    .split(':')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
  if (!segments.length) return 'Command'
  return segments
    .map((segment, index) => {
      const acronym = DISPLAY_ACRONYMS.get(segment)
      if (acronym) return acronym
      return index === 0 ? titleSegment(segment) : segment
    })
    .join(' ')
}

export function projectRetainedSlashDisplay(options: {
  display: SlashDisplayPolicy
  content: string
  overlayView?: SlashOverlayViewModel
  columns?: number
  rows?: number
}): RetainedSlashDisplayProjection | undefined {
  const { display, content } = options
  if (display.surface === 'history') {
    return {
      kind: 'history',
      history: {
        content,
        tone: display.tone,
      },
    }
  }
  if (display.surface === 'toast') {
    return {
      kind: 'toast',
      toast: {
        key: display.key,
        content,
        tone: display.tone,
        ttlMs: display.ttlMs,
      },
    }
  }
  if (display.surface === 'panel') {
    const title = titleForSlashDisplayKey(display.key)
    const panel: CliCommandPanelInput = {
      key: display.key,
      title,
      content,
      dismissOnInput: display.dismissOnInput,
      dismissOnEscape: display.dismissOnEscape,
      ...(display.ttlMs ? { ttlMs: display.ttlMs } : {}),
      overflow: display.overflow,
    }
    if (
      display.overflow === 'pager' &&
      doesCliCommandPanelOverflow(content, {
        columns: options.columns,
        rows: options.rows,
      })
    ) {
      return {
        kind: 'pager',
        pager: { key: display.key, title, content },
      }
    }
    return { kind: 'panel', panel }
  }
  if (display.surface === 'overlay' && display.view === 'pager') {
    return {
      kind: 'pager',
      pager: {
        key: display.key,
        title: titleForSlashDisplayKey(display.key),
        content,
      },
    }
  }
  if (
    display.surface === 'overlay' &&
    display.view === 'picker' &&
    options.overlayView?.kind === 'picker'
  ) {
    return {
      kind: 'catalog',
      catalog: {
        key: display.key,
        title: options.overlayView.title,
        items: options.overlayView.items,
        ...(options.overlayView.emptyMessage
          ? { emptyMessage: options.overlayView.emptyMessage }
          : {}),
      },
    }
  }
  return undefined
}
