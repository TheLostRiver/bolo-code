/**
 * F-T8-PICKER：会话列表箭头键选择（TTY raw mode）。
 * 非 TTY / 无 raw → 调用方回落编号输入。
 */

import * as readline from 'node:readline'
import { createLocalPanelPainter } from './localPanel.ts'

export type ArrowPickItem = {
  id: string
  label: string
}

export type ArrowPickResult =
  | { ok: true; id: string; index: number }
  | { ok: false; reason: 'cancel' | 'unsupported'; message: string }

/**
 * 纯函数：根据按键更新选中下标。
 * keys: up/down/enter/esc/q
 */
export function applyArrowPickerKey(
  index: number,
  length: number,
  key: string,
): { index: number; done?: 'select' | 'cancel' } {
  if (length <= 0) return { index: 0, done: 'cancel' }
  const k = key.toLowerCase()
  if (k === 'up' || k === 'k') {
    return { index: (index - 1 + length) % length }
  }
  if (k === 'down' || k === 'j') {
    return { index: (index + 1) % length }
  }
  if (k === 'enter' || k === 'return' || k === ' ') {
    return { index, done: 'select' }
  }
  if (k === 'esc' || k === 'q' || k === 'ctrl-c') {
    return { index, done: 'cancel' }
  }
  // 数字 1-9
  if (/^[1-9]$/.test(k)) {
    const n = Number(k) - 1
    if (n >= 0 && n < length) return { index: n, done: 'select' }
  }
  return { index }
}

export function formatArrowPickerScreen(
  items: ArrowPickItem[],
  index: number,
  opts?: { title?: string },
): string {
  const lines = [
    opts?.title ?? 'Select session (↑/↓ · Enter · q cancel)',
    '',
  ]
  items.forEach((it, i) => {
    const mark = i === index ? '›' : ' '
    const lab = it.label.length > 72 ? it.label.slice(0, 71) + '…' : it.label
    lines.push(`${mark} ${i + 1}. ${lab}`)
  })
  return lines.join('\n')
}

export async function runNumberedArrowPicker(opts: {
  items: ArrowPickItem[]
  title: string
  initialIndex?: number
  writeOut?: (text: string) => void
  readLine?: (prompt: string) => Promise<string | null>
  signal?: AbortSignal
}): Promise<ArrowPickResult> {
  if (!opts.items.length) {
    return { ok: false, reason: 'cancel', message: 'empty list' }
  }
  if (opts.signal?.aborted) {
    return { ok: false, reason: 'cancel', message: 'cancelled' }
  }

  const writeOut =
    opts.writeOut ?? ((text: string) => process.stdout.write(text))
  const defaultIndex =
    opts.initialIndex != null && Number.isFinite(opts.initialIndex)
      ? Math.max(
          0,
          Math.min(opts.items.length - 1, Math.floor(opts.initialIndex)),
        )
      : undefined
  const ownReadline = opts.readLine
    ? undefined
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      })
  const readLine =
    opts.readLine ??
    ((prompt: string) =>
      new Promise<string | null>((resolve) => {
        if (!ownReadline || opts.signal?.aborted) {
          resolve(null)
          return
        }
        let settled = false
        const finish = (answer: string | null) => {
          if (settled) return
          settled = true
          opts.signal?.removeEventListener('abort', onAbort)
          resolve(answer)
        }
        const onAbort = () => finish(null)
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        ownReadline.question(prompt, (answer) => finish(answer))
      }))

  writeOut(`${opts.title}\n`)
  opts.items.forEach((item, index) => {
    const active = index === defaultIndex ? ' (current)' : ''
    writeOut(`${index + 1}. ${item.label}${active}\n`)
  })

  try {
    for (;;) {
      if (opts.signal?.aborted) {
        return { ok: false, reason: 'cancel', message: 'cancelled' }
      }
      const answer = await readLine(
        `Select [1-${opts.items.length}] (q cancel): `,
      )
      if (answer == null || opts.signal?.aborted) {
        return { ok: false, reason: 'cancel', message: 'cancelled' }
      }
      const value = answer.trim()
      const lower = value.toLowerCase()
      if (lower === 'q' || lower === 'quit' || lower === 'cancel') {
        return { ok: false, reason: 'cancel', message: 'cancelled' }
      }
      if (!value && defaultIndex != null) {
        return {
          ok: true,
          id: opts.items[defaultIndex]!.id,
          index: defaultIndex,
        }
      }
      const selected = Number(value)
      if (
        Number.isInteger(selected) &&
        selected >= 1 &&
        selected <= opts.items.length
      ) {
        const index = selected - 1
        return { ok: true, id: opts.items[index]!.id, index }
      }
      writeOut(`Choose 1-${opts.items.length} or q to cancel.\n`)
    }
  } finally {
    ownReadline?.close()
  }
}

/**
 * 交互箭头 picker。stdin 需 TTY。
 * 测试可注入 readKey 返回 'up'|'down'|'enter'|'q'
 */
export async function runArrowPicker(opts: {
  items: ArrowPickItem[]
  writeOut?: (s: string) => void
  readKey?: () => Promise<string>
  isTty?: boolean
  /** 标题行；缺省 Select session… */
  title?: string
  /** 初始选中下标（夹到合法范围） */
  initialIndex?: number
}): Promise<ArrowPickResult> {
  const items = opts.items
  if (!items.length) {
    return { ok: false, reason: 'cancel', message: 'empty list' }
  }
  const writeOut = opts.writeOut ?? ((s) => process.stdout.write(s))
  const isTty = opts.isTty ?? process.stdin.isTTY === true

  if (!isTty && !opts.readKey) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'arrow picker requires TTY',
    }
  }

  const max = items.length - 1
  let index =
    opts.initialIndex != null && Number.isFinite(opts.initialIndex)
      ? Math.max(0, Math.min(max, Math.floor(opts.initialIndex)))
      : 0
  const painter = createLocalPanelPainter(writeOut)
  const paint = () => {
    painter.paint(
      formatArrowPickerScreen(items, index, {
        title: opts.title,
      }),
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
          const s = buf.toString('utf8')
          if (s === '\u0003') return resolve('ctrl-c')
          if (s === '\u001b') return resolve('esc')
          if (s === '\r' || s === '\n') return resolve('enter')
          if (s === '\u001b[A') return resolve('up')
          if (s === '\u001b[B') return resolve('down')
          if (s === 'q' || s === 'Q') return resolve('q')
          if (s === 'k') return resolve('up')
          if (s === 'j') return resolve('down')
          if (/^[1-9]$/.test(s)) return resolve(s)
          resolve('none')
        })
      })
    })

  paint()
  try {
    for (;;) {
      const key = await readKey()
      if (key === 'none') continue
      const next = applyArrowPickerKey(index, items.length, key)
      index = next.index
      if (next.done === 'select') {
        return { ok: true, id: items[index]!.id, index }
      }
      if (next.done === 'cancel') {
        return { ok: false, reason: 'cancel', message: 'cancelled' }
      }
      paint()
    }
  } finally {
    painter.clear()
  }
}
