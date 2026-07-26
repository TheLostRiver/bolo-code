/**
 * AR-T3+ · AskUserQuestion 的 CLI 选择控件
 *
 * 现有 `arrowPicker` 只能单选，且空格键已被占作「确认」，改造不了；
 * 多选与多问题分组只能新写。分层照 arrowPicker：
 * **纯键位 reducer + 纯渲染 + 可注入 readKey 的循环**，
 * 绝大部分逻辑不需要真终端就能测。
 *
 * 三条硬规则，都是「不许替用户答」在 UI 层的落点：
 *
 * ① **空选择不能提交。** 多选一个没勾就按回车，是拒绝并说明，
 *    不是替他挑一个。UI 是最容易图省事塞默认值的地方。
 * ② **中途取消就整体取消。** 交半份答案比不交更糟——模型会把
 *    没答的那题当成已经问过。
 * ③ **非 TTY 如实说做不到。** 没有终端就没有用户，同 askPermission
 *    非 TTY 直接 deny。
 *
 * 每题末尾恒有一行 Other：用户永远可以用自己的话回答。这一行由 UI 提供，
 * 不占模型给的选项额度，也不该由模型自己写进 options。
 */

import type { AskQuestion, AskUserQuestionSelection } from '../../../shared/src/index.ts'

export type QuestionPickerState = {
  questions: readonly AskQuestion[]
  /** 当前第几题（0-based） */
  qIndex: number
  total: number
  cursor: number
  /** 含末尾 Other 行 */
  rowCount: number
  /** 多选勾中的选项下标 */
  checked: Set<number>
  /** 已完成的题 */
  answers: AskUserQuestionSelection[]
  /** 给用户的一行提示（如「至少选一项」） */
  notice?: string
}

export type QuestionPickerDone =
  | { kind: 'answered'; selection: AskUserQuestionSelection }
  | { kind: 'custom' }
  | { kind: 'cancelled' }

export type QuestionPickerOutcome =
  | { kind: 'answered'; selections: AskUserQuestionSelection[] }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; reason?: string }

const OTHER_LABEL = 'Other — answer in your own words'

export function createQuestionPickerState(
  questions: readonly AskQuestion[],
  qIndex = 0,
): QuestionPickerState {
  const q = questions[qIndex]
  const optionCount = q?.options.length ?? 0
  return {
    questions,
    qIndex,
    total: questions.length,
    cursor: 0,
    // +1 = Other 行
    rowCount: optionCount + 1,
    checked: new Set(),
    answers: [],
  }
}

function isOtherRow(s: QuestionPickerState, row: number): boolean {
  return row === s.rowCount - 1
}

/**
 * 纯函数：按键 → 新状态（+ 可选的完成信号）。
 * 键：up/k · down/j · space · enter · esc/q/ctrl-c · 1-9
 */
export function applyQuestionPickerKey(
  state: QuestionPickerState,
  key: string,
): { state: QuestionPickerState; done?: QuestionPickerDone } {
  const q = state.questions[state.qIndex]
  if (!q) return { state, done: { kind: 'cancelled' } }
  const k = key.toLowerCase()
  // 每次按键先清掉上一次的提示，否则会一直挂在屏幕上
  const s = { ...state, checked: new Set(state.checked), notice: undefined }

  if (k === 'up' || k === 'k') {
    s.cursor = (s.cursor - 1 + s.rowCount) % s.rowCount
    return { state: s }
  }
  if (k === 'down' || k === 'j') {
    s.cursor = (s.cursor + 1) % s.rowCount
    return { state: s }
  }
  if (k === 'esc' || k === 'q' || k === 'ctrl-c') {
    return { state: s, done: { kind: 'cancelled' } }
  }

  if (/^[1-9]$/.test(k)) {
    const n = Number(k) - 1
    if (n < 0 || n >= s.rowCount) return { state: s }
    s.cursor = n
    if (q.multiSelect && !isOtherRow(s, n)) {
      toggle(s, n)
      return { state: s }
    }
    return finishRow(s, q)
  }

  if (k === ' ' || k === 'space') {
    if (q.multiSelect && !isOtherRow(s, s.cursor)) {
      toggle(s, s.cursor)
      return { state: s }
    }
    // 单选里空格等同确认——不留「勾了但没提交」的中间态
    return finishRow(s, q)
  }

  if (k === 'enter' || k === 'return') {
    return finishRow(s, q)
  }

  return { state: s }
}

function toggle(s: QuestionPickerState, row: number): void {
  if (s.checked.has(row)) s.checked.delete(row)
  else s.checked.add(row)
}

function finishRow(
  s: QuestionPickerState,
  q: AskQuestion,
): { state: QuestionPickerState; done?: QuestionPickerDone } {
  if (isOtherRow(s, s.cursor)) {
    return { state: s, done: { kind: 'custom' } }
  }
  if (q.multiSelect) {
    if (s.checked.size === 0) {
      // 不替用户选：说明为什么没反应，而不是默默吞掉这次回车
      return {
        state: { ...s, notice: 'select at least one option with space, then press enter' },
      }
    }
    // 按**选项顺序**输出，而不是勾选顺序——顺序不该泄露操作过程
    const selected = [...s.checked]
      .sort((a, b) => a - b)
      .map((i) => q.options[i]!.label)
    return { state: s, done: { kind: 'answered', selection: { selected } } }
  }
  const label = q.options[s.cursor]?.label
  if (!label) return { state: s }
  return { state: s, done: { kind: 'answered', selection: { selected: [label] } } }
}

export function formatQuestionPickerScreen(s: QuestionPickerState): string {
  const q = s.questions[s.qIndex]
  if (!q) return ''
  const lines: string[] = []
  lines.push(`[${q.header}]  ${s.qIndex + 1}/${s.total}`)
  lines.push(q.question)
  lines.push('')
  q.options.forEach((o, i) => {
    const cur = i === s.cursor ? '›' : ' '
    const box = q.multiSelect ? (s.checked.has(i) ? '[x] ' : '[ ] ') : ''
    lines.push(`${cur} ${i + 1}. ${box}${o.label}`)
    if (o.description) lines.push(`      ${o.description}`)
  })
  const otherRow = s.rowCount - 1
  lines.push(
    `${otherRow === s.cursor ? '›' : ' '} ${otherRow + 1}. ${OTHER_LABEL}`,
  )
  lines.push('')
  // 键位必须写在屏幕上：看不见的键位等于没有
  lines.push(
    q.multiSelect
      ? '↑/↓ move · space toggle · enter submit · esc cancel'
      : '↑/↓ move · enter select · esc cancel',
  )
  if (s.notice) lines.push(`! ${s.notice}`)
  return lines.join('\n')
}

export async function runQuestionPicker(opts: {
  questions: readonly AskQuestion[]
  writeOut?: (s: string) => void
  readKey?: () => Promise<string>
  /** 自由文本输入；缺省时 Other 行不可用 */
  readLine?: (prompt: string) => Promise<string>
  isTty?: boolean
  signal?: AbortSignal
}): Promise<QuestionPickerOutcome> {
  if (!opts.questions.length) return { kind: 'cancelled' }
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s))
  const isTty = opts.isTty ?? process.stdin.isTTY === true

  if (!isTty && !opts.readKey) {
    // 没有终端就没有用户。绝不在这里挑一个「合理的默认」。
    return {
      kind: 'unavailable',
      reason: 'no interactive terminal',
    }
  }

  const readKey = opts.readKey ?? defaultReadKey
  const selections: AskUserQuestionSelection[] = []

  for (let qi = 0; qi < opts.questions.length; qi++) {
    let s = createQuestionPickerState(opts.questions, qi)
    const paint = () => {
      writeOut('\x1b[2J\x1b[H')
      writeOut(formatQuestionPickerScreen(s) + '\n')
    }
    paint()

    for (;;) {
      if (opts.signal?.aborted) return { kind: 'cancelled' }
      const key = await readKey()
      const r = applyQuestionPickerKey(s, key)
      s = r.state
      if (!r.done) {
        paint()
        continue
      }
      if (r.done.kind === 'cancelled') {
        // 半份答案比没有更糟：模型会把没答的题当成已经问过
        return { kind: 'cancelled' }
      }
      if (r.done.kind === 'custom') {
        if (!opts.readLine) {
          s = { ...s, notice: 'typing a custom answer is not available here' }
          paint()
          continue
        }
        const text = (await opts.readLine('your answer: ')).trim()
        if (!text) {
          // 敲了个空的不算答案，回到列表继续选
          s = { ...s, notice: 'nothing typed — pick an option or type an answer' }
          paint()
          continue
        }
        selections.push({ selected: [text], custom: true })
        break
      }
      selections.push(r.done.selection)
      break
    }
  }

  return { kind: 'answered', selections }
}

async function defaultReadKey(): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return 'esc'
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
      if (s === ' ') return resolve(' ')
      if (s === 'q' || s === 'Q') return resolve('q')
      if (s === 'k') return resolve('up')
      if (s === 'j') return resolve('down')
      if (/^[1-9]$/.test(s)) return resolve(s)
      resolve('none')
    })
  })
}
