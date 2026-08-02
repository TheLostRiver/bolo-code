/**
 * OUT-4: SGR (1006) mouse 输入纯契约。
 *
 * 职责边界：
 * - 纯函数解析 xterm SGR mouse escape sequence（`ESC [ < b ; x ; y M|m`），
 *   与 bracketed paste / Kitty 键序列天然区分（它们不匹配本格式）。
 * - 提供启用/禁用终端的 reporting 序列常量；实际 enable/disable 时机由
 *   CLI adapter 决定（与 raw-mode input 生命周期绑定）。
 * - 不持有 terminal、renderer 或 state；不处理 hit region（那是 renderer 的
 *   render 产物）与点击动作（那是 controller 的职责）。
 *
 * 参考：xterm SGR mouse (1006) — buttons 低 5 bit；0x04 shift、0x10 ctrl、
 * 0x20 motion、0x40 wheel up、0x80 wheel down；`M` 为 press、`m` 为 release。
 */
export const SGR_MOUSE_ENABLE = '\x1b[?1000h\x1b[?1006h'
export const SGR_MOUSE_DISABLE = '\x1b[?1000l\x1b[?1006l'

export type SgrMousePressEvent = {
  kind: 'press'
  button: 0 | 1 | 2
  x: number
  y: number
  shift: boolean
  ctrl: boolean
}

export type SgrMouseDragEvent = {
  kind: 'drag'
  button: 0 | 1 | 2
  x: number
  y: number
  shift: boolean
  ctrl: boolean
}

export type SgrMouseReleaseEvent = {
  kind: 'release'
  x: number
  y: number
}

export type SgrMouseWheelEvent = {
  kind: 'wheel'
  direction: 'up' | 'down'
  x: number
  y: number
  shift: boolean
  ctrl: boolean
}

export type SgrMouseEvent =
  | SgrMousePressEvent
  | SgrMouseDragEvent
  | SgrMouseReleaseEvent
  | SgrMouseWheelEvent

const SGR_MOUSE_PATTERN = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/u

/** 仅判定输入是否为完整 SGR mouse 序列；不做语义解析。 */
export function isSgrMouseSequence(data: string): boolean {
  const match = SGR_MOUSE_PATTERN.exec(data)
  if (!match) return false
  const x = Number(match[2])
  const y = Number(match[3])
  return x >= 1 && y >= 1
}

/**
 * 解析完整 SGR mouse 序列。
 * 返回 undefined 当且仅当：不是鼠标序列、坐标越界（<1）、或 press 的按钮
 * 位不是 0/1/2（非标准按钮 fail closed，避免误触发点击）。
 */
export function parseSgrMouseSequence(
  data: string,
): SgrMouseEvent | undefined {
  const match = SGR_MOUSE_PATTERN.exec(data)
  if (!match) return undefined
  const raw = Number(match[1])
  const x = Number(match[2])
  const y = Number(match[3])
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) {
    return undefined
  }
  const release = match[4] === 'm'
  const shift = (raw & 0x04) !== 0
  const ctrl = (raw & 0x10) !== 0
  const motion = (raw & 0x20) !== 0
  // xterm SGR 1006：wheel up = 64 (0x40)、wheel down = 65 (0x41)，
  // 方向由 0x41 的低位区分；wheel left/right（66/67）归为 up/down 忽略。
  const wheel = (raw & 0x40) !== 0
  if (release) {
    return { kind: 'release', x, y }
  }
  if (wheel) {
    return {
      kind: 'wheel',
      direction: (raw & 0x41) === 0x41 ? 'down' : 'up',
      x,
      y,
      shift,
      ctrl,
    }
  }
  const button = (raw & 0x03) as 0 | 1 | 2
  if (button > 2) return undefined
  if (motion) {
    return { kind: 'drag', button, x, y, shift, ctrl }
  }
  return { kind: 'press', button, x, y, shift, ctrl }
}
