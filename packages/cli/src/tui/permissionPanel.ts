/**
 * Structured permission selector for non-file tools.
 *
 * The panel owns only the rows it paints. It never clears the full terminal,
 * so the conversation timeline remains in scrollback.
 */

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
  return [
    ...(summary ? [{ label: 'Preview', value: summary }] : []),
    { label: 'Input', value: formatGenericInput(request.toolInput) },
    ...(request.cwd?.trim()
      ? [{ label: 'Working directory', value: request.cwd.trim() }]
      : []),
  ]
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

function parseRawKey(text: string): string {
  if (text === '\u0003') return 'ctrl-c'
  if (text === '\u001b') return 'esc'
  if (text === '\r' || text === '\n') return 'enter'
  if (text === '\u001b[A') return 'up'
  if (text === '\u001b[B') return 'down'
  if (text === ' ') return ' '
  if (/^[1-3aynqjk]$/iu.test(text)) return text.toLowerCase()
  return 'none'
}

function defaultReadKey(signal?: AbortSignal): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY || signal?.aborted) return Promise.resolve('ctrl-c')
  return new Promise<string>((resolve) => {
    const wasRaw = stdin.isRaw
    let settled = false
    const finish = (key: string) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      stdin.removeListener('data', onData)
      stdin.setRawMode?.(wasRaw ?? false)
      resolve(key)
    }
    const onAbort = () => finish('ctrl-c')
    const onData = (buffer: Buffer) =>
      finish(parseRawKey(buffer.toString('utf8')))
    signal?.addEventListener('abort', onAbort, { once: true })
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.once('data', onData)
  })
}

function readKeyWithAbort(
  readKey: () => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  if (!signal) return readKey()
  if (signal.aborted) return Promise.resolve('ctrl-c')
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (key: string) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(key)
    }
    const onAbort = () => finish('ctrl-c')
    signal.addEventListener('abort', onAbort, { once: true })
    readKey().then(finish, (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

function createLocalPanelPainter(writeOut: (text: string) => void) {
  let lineCount = 0
  const clear = () => {
    if (lineCount === 0) return
    writeOut('\u001b[?25l')
    writeOut(`\u001b[${lineCount}A\r`)
    for (let index = 0; index < lineCount; index++) {
      writeOut('\u001b[2K')
      if (index < lineCount - 1) writeOut('\u001b[1B\r')
    }
    if (lineCount > 1) writeOut(`\u001b[${lineCount - 1}A\r`)
    writeOut('\u001b[?25h')
    lineCount = 0
  }
  return {
    paint(screen: string) {
      clear()
      lineCount = screen.split('\n').length
      writeOut(`\u001b[?25l${screen}\n\u001b[?25h`)
    },
    clear,
  }
}

function formatDecisionSummary(
  request: AskPermissionRequest,
  decision: AskPermissionDecision,
  color: boolean,
): string {
  const plain =
    decision === 'allow'
      ? `✓ Allowed ${request.toolName} once`
      : decision === 'allow_always'
        ? `✓ Always allowed ${request.toolName} for this session`
        : `✗ Denied ${request.toolName}`
  if (!color) return `${plain}\n`
  const tone =
    decision === 'deny' ? '\u001b[38;5;203m' : '\u001b[38;5;78m'
  return `${tone}${plain}\u001b[0m\n`
}

export async function runPermissionPanel(options: {
  request: AskPermissionRequest
  writeOut?: (text: string) => void
  readKey?: () => Promise<string>
  isTty?: boolean
  columns?: number
  color?: boolean
  signal?: AbortSignal
  onInterrupt?: () => void
  initialIndex?: number
}): Promise<AskPermissionDecision> {
  const isTty = options.isTty ?? process.stdin.isTTY === true
  if (!isTty && !options.readKey) return 'deny'
  if (options.signal?.aborted) return 'deny'

  const writeOut =
    options.writeOut ?? ((text: string) => process.stdout.write(text))
  const color =
    options.color ??
    (process.env.NO_COLOR === undefined &&
      process.env.BOLO_THEME?.trim().toLowerCase() !== 'plain')
  const readKey =
    options.readKey ?? (() => defaultReadKey(options.signal))
  const painter = createLocalPanelPainter(writeOut)
  let index =
    options.initialIndex == null
      ? 2
      : Math.max(0, Math.min(2, Math.floor(options.initialIndex)))
  const paint = () =>
    painter.paint(
      formatPermissionPanelScreen(options.request, index, {
        columns: options.columns ?? process.stdout.columns,
        color,
      }),
    )

  paint()
  try {
    for (;;) {
      const key = await readKeyWithAbort(readKey, options.signal)
      if (key === 'ctrl-c') options.onInterrupt?.()
      const next = applyPermissionPanelKey(index, key)
      index = next.index
      if (next.decision) {
        painter.clear()
        writeOut(formatDecisionSummary(options.request, next.decision, color))
        return next.decision
      }
      if (key !== 'none') paint()
    }
  } catch {
    painter.clear()
    return 'deny'
  }
}
