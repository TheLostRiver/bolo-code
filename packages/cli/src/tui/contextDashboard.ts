import type { ContextUsageViewModel } from '../../../core/src/index.ts'
import {
  resolveTuiDockWidth,
  resolveTuiFrameWidth,
} from './frame.ts'
import {
  clipTerminalText,
  measureTerminalText,
  padTerminalText,
} from './terminalText.ts'

export type RenderedContextDashboard = {
  text: string
  lines: string[]
}

function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.floor(value))
  if (normalized >= 1_000_000) {
    const scaled = normalized / 1_000_000
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)}m`
  }
  if (normalized >= 1_000) {
    const scaled = normalized / 1_000
    return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}k`
  }
  return String(normalized)
}

function borderLine(
  left: string,
  right: string,
  width: number,
  label = '',
): string {
  const innerWidth = Math.max(0, width - 2)
  const title = label
    ? clipTerminalText(`─ ${label} `, innerWidth)
    : ''
  return `${left}${title}${'─'.repeat(
    Math.max(0, innerWidth - measureTerminalText(title)),
  )}${right}`
}

function usageBar(percent: number, bodyWidth: number): string {
  const cells = Math.max(4, Math.min(32, bodyWidth - 7))
  const bounded = Math.max(0, Math.min(100, percent))
  const filled =
    bounded > 0 ? Math.max(1, Math.round((bounded / 100) * cells)) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, cells - filled))} ${Math.max(
    0,
    percent,
  )}%`
}

export function renderContextDashboard(options: {
  view: ContextUsageViewModel
  columns?: number
  color?: boolean
  frame?: boolean
  variant?: 'full' | 'panel'
}): RenderedContextDashboard {
  const view = options.view
  const columns = options.columns ?? 80
  const frame = options.frame !== false
  const width = frame
    ? resolveTuiFrameWidth(columns)
    : Math.max(1, resolveTuiDockWidth(columns) - 4)
  const bodyWidth = frame ? Math.max(4, width - 4) : width
  const color = options.color !== false
  const border = color ? '\u001b[38;5;244m' : ''
  const accent = color ? '\u001b[38;5;81m' : ''
  const dim = color ? '\u001b[2m' : ''
  const warning =
    color && (view.usage.level === 'critical' || view.usage.level === 'over')
      ? '\u001b[38;5;203m'
      : color && view.usage.level === 'warn'
        ? '\u001b[38;5;221m'
        : color
          ? '\u001b[38;5;114m'
          : ''
  const reset = color ? '\u001b[0m' : ''
  const lines: string[] = []

  const row = (content: string, tone = '') => {
    const clipped = clipTerminalText(content, bodyWidth)
    if (!frame) {
      lines.push(`${tone}${clipped}${reset}`)
      return
    }
    const padded = padTerminalText(clipped, bodyWidth)
    lines.push(
      `${border}│${reset} ${tone}${padded}${reset} ${border}│${reset}`,
    )
  }

  if (frame) {
    lines.push(
      `${border}${borderLine('╭', '╮', width, 'Context usage')}${reset}`,
    )
  }
  const autoCompact = view.autoCompact.enabled
    ? view.autoCompact.envDisabled
      ? 'on · env-disabled'
      : view.autoCompact.aboveThreshold
        ? 'on · threshold reached'
        : 'on'
    : 'off'

  if (options.variant === 'panel') {
    row(
      `${formatTokens(view.usage.tokenCount)} / ${formatTokens(
        view.usage.windowTokens,
      )} tokens · ${view.usage.source}`,
      accent,
    )
    row(usageBar(view.usage.percentOfWindow, bodyWidth), warning)
    row(
      `${view.usage.level} · threshold ${formatTokens(
        view.usage.autoThresholdTokens,
      )} (${view.usage.percentOfThreshold}%)`,
      warning,
    )
    row(
      `Messages ~${formatTokens(
        view.estimate.messagesTokens,
      )} · System ~${formatTokens(
        view.estimate.systemTokens,
      )} · Free ~${formatTokens(view.usage.freeTokens)}`,
    )
    row(
      `Model ${view.session.model ?? '(unset)'} · effort ${view.session.effort}`,
    )
    row(
      `Auto compact ${autoCompact} · ${view.session.messageCount} messages`,
    )
    row('/context details  full diagnostics', dim)
    if (frame) {
      lines.push(`${border}${borderLine('╰', '╯', width)}${reset}`)
    }
    return { text: lines.join('\n'), lines }
  }

  if (bodyWidth < 28) {
    row(
      `${formatTokens(view.usage.tokenCount)} / ${formatTokens(
        view.usage.windowTokens,
      )} tokens`,
      accent,
    )
    row(`Source ${view.usage.source}`, accent)
    row(usageBar(view.usage.percentOfWindow, bodyWidth), warning)
    row(
      `Pressure ${view.usage.level} · ${view.usage.percentOfWindow}%`,
      warning,
    )
    row(`Threshold ${formatTokens(view.usage.autoThresholdTokens)}`, warning)
  } else {
    row(
      `${formatTokens(view.usage.tokenCount)} / ${formatTokens(
        view.usage.windowTokens,
      )} tokens · ${view.usage.source}`,
      accent,
    )
    row(usageBar(view.usage.percentOfWindow, bodyWidth), warning)
    row(
      `${view.usage.level} · threshold ${formatTokens(
        view.usage.autoThresholdTokens,
      )} (${view.usage.percentOfThreshold}%)`,
      warning,
    )
  }

  if (bodyWidth >= 52) {
    row(
      `Messages ~${formatTokens(
        view.estimate.messagesTokens,
      )}  ·  System ~${formatTokens(
        view.estimate.systemTokens,
      )}  ·  Free ~${formatTokens(view.usage.freeTokens)}`,
    )
  } else {
    row(`Messages ~${formatTokens(view.estimate.messagesTokens)}`)
    row(`System   ~${formatTokens(view.estimate.systemTokens)}`)
    row(`Free     ~${formatTokens(view.usage.freeTokens)}`)
  }

  row(
    `Model ${view.session.model ?? '(unset)'} · effort ${view.session.effort}`,
  )
  row(
    `${view.session.messageCount} messages · ${view.sections.length} sections · ${view.skills.totalSkills} skills`,
  )
  row(`Auto compact ${autoCompact}`)
  row(
    bodyWidth < 28
      ? 'Breakdown: estimated'
      : 'Breakdown values are local estimates.',
    dim,
  )
  row(
    bodyWidth < 28
      ? '/context details'
      : '/context details  full diagnostics',
    dim,
  )
  if (frame) {
    lines.push(`${border}${borderLine('╰', '╯', width)}${reset}`)
  }

  return { text: lines.join('\n'), lines }
}
