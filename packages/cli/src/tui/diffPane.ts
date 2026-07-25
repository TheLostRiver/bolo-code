/**
 * U1：终端 Diff 面板 — 对照 HC DiffDialog / Codex patch 列表（无 ink/ratatui 依赖）
 * raw mode 键位与 arrowPicker 同族。
 */

import {
  applyDiffViewKey,
  formatDiffViewScreen,
  type DiffViewModel,
} from '../../../core/src/diffViewModel.ts'

export type DiffPaneResult =
  | { ok: true; reason: 'quit' }
  | { ok: false; reason: 'unsupported' | 'empty'; message: string }

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
  if (s === 'k') return 'up'
  if (s === 'j') return 'down'
  if (s === 'h') return 'h'
  if (s === 'l') return 'l'
  if (s === ' ') return ' '
  if (/^[1-9]$/.test(s)) return s
  return 'none'
}

/**
 * 交互 Diff 面板。stdin 需 TTY（或注入 readKey）。
 */
export async function runDiffPane(opts: {
  model: DiffViewModel
  writeOut?: (s: string) => void
  readKey?: () => Promise<string>
  isTty?: boolean
  rows?: number
  cols?: number
}): Promise<DiffPaneResult> {
  let vm = opts.model
  if (!vm.files.length) {
    return {
      ok: false,
      reason: 'empty',
      message: 'No file changes to show in panel.',
    }
  }

  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const isTty = opts.isTty ?? process.stdin.isTTY === true

  if (!isTty && !opts.readKey) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'diff panel requires TTY',
    }
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

  const paint = () => {
    writeOut('\x1b[2J\x1b[H')
    writeOut(
      formatDiffViewScreen(vm, { rows, cols, toast }) + '\n',
    )
  }

  const readKey =
    opts.readKey ??
    (async () => {
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
    })

  paint()
  for (;;) {
    const key = await readKey()
    if (key === 'none') continue
    const next = applyDiffViewKey(vm, key)
    vm = next.vm
    toast = next.toast
    if (next.done === 'quit') {
      writeOut('\x1b[2J\x1b[H')
      return { ok: true, reason: 'quit' }
    }
    paint()
  }
}