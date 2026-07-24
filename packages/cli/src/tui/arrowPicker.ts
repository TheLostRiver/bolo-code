/**
 * F-T8-PICKER：会话列表箭头键选择（TTY raw mode）。
 * 非 TTY / 无 raw → 调用方回落编号输入。
 */

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

/**
 * 交互箭头 picker。stdin 需 TTY。
 * 测试可注入 readKey 返回 'up'|'down'|'enter'|'q'
 */
export async function runArrowPicker(opts: {
  items: ArrowPickItem[]
  writeOut?: (s: string) => void
  readKey?: () => Promise<string>
  isTty?: boolean
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

  let index = 0
  const paint = () => {
    writeOut('\x1b[2J\x1b[H') // clear
    writeOut(formatArrowPickerScreen(items, index) + '\n')
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
}