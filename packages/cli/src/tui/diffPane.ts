/**
 * U1/U2：终端 Diff 面板 — 对照 HC DiffDialog / Codex patch 审批（无 ink/ratatui）
 * browse：/diff · approve：权限 y/a/N + 可滚 preview
 */

import {
  applyDiffViewKey,
  formatDiffViewScreen,
  type DiffViewModel,
} from '../../../core/src/diffViewModel.ts'

export type DiffPaneBrowseResult =
  | { ok: true; reason: 'quit' }
  | { ok: false; reason: 'unsupported' | 'empty'; message: string }

export type DiffPaneApproveResult =
  | { ok: true; decision: 'allow' | 'deny' | 'allow_always' }
  | { ok: false; reason: 'unsupported' | 'empty'; message: string }

/** @deprecated 用 DiffPaneBrowseResult */
export type DiffPaneResult = DiffPaneBrowseResult

function parseRawKey(s: string): string {
  if (s === '\u0003') return 'ctrl-c'
  if (s === '\u001b') return 'esc'
  if (s === '\r' || s === '\n') return 'enter'
  if (s === '\u001b[A') return 'up'
  if (s === '\u001b[B') return 'down'
  if (s === '\u001b[D') return 'left'
  if (s === '\u001b[C') return 'right'
  if (s === '\u007f' || s === '\b') return 'backspace'
  if (s === 'q' || s === 'Q') return 'q'
  if (s === 'y' || s === 'Y') return 'y'
  if (s === 'a' || s === 'A') return 'a'
  if (s === 'n' || s === 'N') return 'n'
  if (s === 'k') return 'up'
  if (s === 'j') return 'down'
  if (s === 'h') return 'h'
  if (s === 'l') return 'l'
  if (s === ' ') return ' '
  if (/^[1-9]$/.test(s)) return s
  return 'none'
}

function defaultReadKeyFactory(): () => Promise<string> {
  return async () => {
    const stdin = process.stdin
    if (!stdin.isTTY) return 'q'
    return await new Promise<string>((resolve) => {
      const wasRaw = stdin.isRaw
      stdin.setRawMode?.(true)
      stdin.resume()
      stdin.once('data', (buf: Buffer) => {
        stdin.setRawMode?.(wasRaw ?? false)
        resolve(parseRawKey(buf.toString('utf8')))
      })
    })
  }
}

async function runDiffPaneLoop(opts: {
  model: DiffViewModel
  mode: 'browse' | 'approve'
  toolName?: string
  writeOut?: (s: string) => void
  readKey?: () => Promise<string>
  isTty?: boolean
  rows?: number
  cols?: number
}): Promise<
  | { kind: 'browse'; result: DiffPaneBrowseResult }
  | { kind: 'approve'; result: DiffPaneApproveResult }
> {
  let vm = opts.model
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const isTty = opts.isTty ?? process.stdin.isTTY === true

  if (!vm.files.length) {
    const empty = {
      ok: false as const,
      reason: 'empty' as const,
      message: 'No file changes to show in panel.',
    }
    return opts.mode === 'approve'
      ? { kind: 'approve', result: empty }
      : { kind: 'browse', result: empty }
  }

  if (!isTty && !opts.readKey) {
    const unsupported = {
      ok: false as const,
      reason: 'unsupported' as const,
      message: 'diff panel requires TTY',
    }
    return opts.mode === 'approve'
      ? { kind: 'approve', result: unsupported }
      : { kind: 'browse', result: unsupported }
  }

  const rows =
    opts.rows ??
    (typeof process.stdout.rows === 'number' ? process.stdout.rows : 24)
  const cols =
    opts.cols ??
    (typeof process.stdout.columns === 'number'
      ? process.stdout.columns
      : 80)

  let toast: string | undefined
  const readKey = opts.readKey ?? defaultReadKeyFactory()

  const paint = () => {
    writeOut('\x1b[2J\x1b[H')
    writeOut(
      formatDiffViewScreen(vm, {
        rows,
        cols,
        toast,
        mode: opts.mode,
        toolName: opts.toolName,
      }) + '\n',
    )
  }

  paint()
  for (;;) {
    const key = await readKey()
    if (key === 'none') continue
    const next = applyDiffViewKey(vm, key, { mode: opts.mode })
    vm = next.vm
    toast = next.toast
    if (opts.mode === 'approve') {
      if (
        next.done === 'allow' ||
        next.done === 'deny' ||
        next.done === 'allow_always'
      ) {
        writeOut('\x1b[2J\x1b[H')
        return {
          kind: 'approve',
          result: { ok: true, decision: next.done },
        }
      }
    } else if (next.done === 'quit') {
      writeOut('\x1b[2J\x1b[H')
      return { kind: 'browse', result: { ok: true, reason: 'quit' } }
    }
    paint()
  }
}

/**
 * 浏览面板（/diff）。
 */
export async function runDiffPane(opts: {
  model: DiffViewModel
  writeOut?: (s: string) => void
  readKey?: () => Promise<string>
  isTty?: boolean
  rows?: number
  cols?: number
}): Promise<DiffPaneBrowseResult> {
  const r = await runDiffPaneLoop({ ...opts, mode: 'browse' })
  return r.kind === 'browse' ? r.result : { ok: true, reason: 'quit' }
}

/**
 * 权限审批面板（U2）：可滚 preview + y/a/N。
 */
export async function runDiffApprovePane(opts: {
  model: DiffViewModel
  toolName: string
  writeOut?: (s: string) => void
  readKey?: () => Promise<string>
  isTty?: boolean
  rows?: number
  cols?: number
}): Promise<DiffPaneApproveResult> {
  const r = await runDiffPaneLoop({
    ...opts,
    mode: 'approve',
    toolName: opts.toolName,
  })
  return r.kind === 'approve'
    ? r.result
    : { ok: false, reason: 'unsupported', message: 'internal' }
}