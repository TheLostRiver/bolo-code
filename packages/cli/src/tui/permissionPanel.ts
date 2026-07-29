/** Shared permission reducer and screen formatter for retained overlays. */

import { resolveTuiDockWidth } from './frame.ts'
import {
  clipTerminalText,
  measureTerminalText,
  padTerminalText,
  wrapTerminalText,
} from './terminalText.ts'
import type {
  AskPermissionDecision,
  AskPermissionRequest,
} from './askPermissionTty.ts'

export type PermissionPanelKeyResult = {
  index: number
  decision?: AskPermissionDecision
}

type PermissionChoice = {
  decision: AskPermissionDecision
  label: string
  description: (toolName: string) => string
}

const PERMISSION_CHOICES: readonly PermissionChoice[] = [
  {
    decision: 'allow',
    label: 'Allow once',
    description: () => 'Run only this operation',
  },
  {
    decision: 'allow_always',
    label: 'Always allow',
    description: (toolName) =>
      `Allow every ${toolName} request for this session`,
  },
  {
    decision: 'deny',
    label: 'Deny',
    description: () => 'Do not run this operation',
  },
]

export function applyPermissionPanelKey(
  index: number,
  key: string,
): PermissionPanelKeyResult {
  const count = PERMISSION_CHOICES.length
  const current = Math.max(0, Math.min(count - 1, Math.floor(index)))
  const normalized = key.toLowerCase()
  if (normalized === 'up' || normalized === 'k') {
    return { index: (current - 1 + count) % count }
  }
  if (normalized === 'down' || normalized === 'j') {
    return { index: (current + 1) % count }
  }
  if (
    normalized === 'esc' ||
    normalized === 'q' ||
    normalized === 'ctrl-c' ||
    normalized === 'n'
  ) {
    return { index: 2, decision: 'deny' }
  }
  if (normalized === 'y') return { index: 0, decision: 'allow' }
  if (normalized === 'a') {
    return { index: 1, decision: 'allow_always' }
  }
  if (/^[1-3]$/u.test(normalized)) {
    const selected = Number(normalized) - 1
    return {
      index: selected,
      decision: PERMISSION_CHOICES[selected]!.decision,
    }
  }
  if (
    normalized === 'enter' ||
    normalized === 'return' ||
    normalized === ' '
  ) {
    return {
      index: current,
      decision: PERMISSION_CHOICES[current]!.decision,
    }
  }
  return { index: current }
}

type PanelTone =
  | 'border'
  | 'title'
  | 'label'
  | 'selected'
  | 'warning'
  | 'dim'

type PanelLine = {
  text: string
  tone?: PanelTone
}

function borderLine(
  left: string,
  right: string,
  width: number,
  label = '',
): string {
  const inner = Math.max(0, width - 2)
  const raw = label ? `─ ${label} ` : ''
  const text = clipTerminalText(raw, inner)
  return `${left}${text}${'─'.repeat(
    Math.max(0, inner - measureTerminalText(text)),
  )}${right}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function formatTimeout(input: Record<string, unknown>): string {
  if (input.run_in_background === true) {
    return 'No timeout (background process)'
  }
  const raw = Number(input.timeout)
  const timeoutMs = Number.isFinite(raw)
    ? Math.min(600_000, Math.max(1, Math.floor(raw)))
    : 30_000
  const suffix = Number.isFinite(raw) ? '' : ' (default)'
  if (timeoutMs % 1_000 === 0) {
    return `${timeoutMs / 1_000}s${suffix}`
  }
  return `${timeoutMs}ms${suffix}`
}

function formatGenericInput(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2)
    if (!serialized) return String(value ?? '(none)')
    if (serialized.length <= 2_000) return serialized
    return `${serialized.slice(0, 1_999)}…\n[display truncated]`
  } catch {
    return String(value ?? '(unavailable)')
  }
}

function permissionFields(request: AskPermissionRequest): Array<{
  label: string
  value: string
}> {
  const input = asRecord(request.toolInput)
  if (request.toolName.toLowerCase() === 'bash') {
    const command =
      typeof input.command === 'string' && input.command.length > 0
        ? input.command
        : '(missing command)'
    const fields = [
      { label: 'Command', value: command },
      {
        label: 'Working directory',
        value: request.cwd?.trim() || '(not provided)',
      },
      {
        label: 'Execution',
        value:
          input.run_in_background === true ? 'Background' : 'Foreground',
      },
      { label: 'Timeout', value: formatTimeout(input) },
    ]
    if (typeof input.description === 'string' && input.description.trim()) {
      fields.push({ label: 'Description', value: input.description.trim() })
    }
    return fields
  }

  const summary = request.preview?.summaryText?.trim()
  const changedPaths =
    request.preview?.files
      ?.map((file) => file.path.trim())
      .filter(Boolean) ?? []
  return [
    ...(summary ? [{ label: 'Preview', value: summary }] : []),
    ...(changedPaths.length
      ? [{ label: 'Files', value: changedPaths.join('\n') }]
      : []),
    { label: 'Input', value: formatGenericInput(request.toolInput) },
    ...(request.cwd?.trim()
      ? [{ label: 'Working directory', value: request.cwd.trim() }]
      : []),
  ]
}

export function formatPermissionRequestDetails(
  request: AskPermissionRequest,
): string {
  const lines = [`${request.toolName} requests permission`]
  for (const field of permissionFields(request)) {
    const [first = '', ...rest] = field.value.split('\n')
    lines.push(`${field.label}: ${first}`)
    rest.forEach((line) => lines.push(`  ${line}`))
  }
  return lines.join('\n')
}

function stylePanelLine(line: PanelLine, color: boolean): string {
  if (!color || !line.tone) return line.text
  const start =
    line.tone === 'border'
      ? '\u001b[38;5;244m'
      : line.tone === 'title'
        ? '\u001b[1m\u001b[38;5;81m'
        : line.tone === 'label'
          ? '\u001b[1m'
          : line.tone === 'selected'
            ? '\u001b[7m'
            : line.tone === 'warning'
              ? '\u001b[38;5;214m'
              : '\u001b[2m'
  return `${start}${line.text}\u001b[0m`
}

export function formatPermissionPanelScreen(
  request: AskPermissionRequest,
  selectedIndex = 2,
  options?: { columns?: number; color?: boolean },
): string {
  const frameWidth = resolveTuiDockWidth(options?.columns ?? 80)
  const contentWidth = Math.max(1, frameWidth - 4)
  const selected = Math.max(
    0,
    Math.min(PERMISSION_CHOICES.length - 1, Math.floor(selectedIndex)),
  )
  const lines: PanelLine[] = []
  const body = (text = '', tone?: PanelTone) => {
    lines.push({
      text: `│ ${padTerminalText(text, contentWidth)} │`,
      ...(tone ? { tone } : {}),
    })
  }
  const wrappedBody = (
    text: string,
    options?: { indent?: string; tone?: PanelTone; maxRows?: number },
  ) => {
    const indent = options?.indent ?? ''
    const width = Math.max(
      1,
      contentWidth - measureTerminalText(indent),
    )
    const wrapped = wrapTerminalText(text, width)
    const maxRows = Math.max(1, options?.maxRows ?? 12)
    const visible = wrapped.slice(0, maxRows)
    visible.forEach((line) =>
      body(`${indent}${line}`, options?.tone),
    )
    if (wrapped.length > visible.length) {
      body(
        `${indent}… ${wrapped.length - visible.length} more row(s)`,
        'warning',
      )
    }
  }

  lines.push({
    text: borderLine('╭', '╮', frameWidth, 'Permission required'),
    tone: 'title',
  })
  body(`${request.toolName} requests permission`, 'title')
  lines.push({
    text: borderLine('├', '┤', frameWidth, 'Operation'),
    tone: 'border',
  })
  for (const field of permissionFields(request)) {
    body(field.label, 'label')
    wrappedBody(field.value, {
      indent: '  ',
      maxRows: field.label === 'Command' ? 12 : 6,
    })
  }

  lines.push({
    text: borderLine('├', '┤', frameWidth, 'Decision'),
    tone: 'border',
  })
  PERMISSION_CHOICES.forEach((choice, index) => {
    const marker = index === selected ? '❯' : ' '
    wrappedBody(`${marker} ${index + 1}. ${choice.label}`, {
      tone: index === selected ? 'selected' : undefined,
      maxRows: 2,
    })
    wrappedBody(choice.description(request.toolName), {
      indent: '    ',
      tone: choice.decision === 'allow_always' ? 'warning' : 'dim',
      maxRows: 3,
    })
  })
  lines.push({
    text: borderLine(
      '╰',
      '╯',
      frameWidth,
      '↑↓ move · Enter select · y/a/n direct · Esc deny',
    ),
    tone: 'border',
  })

  const color = options?.color !== false
  return lines.map((line) => stylePanelLine(line, color)).join('\n')
}
