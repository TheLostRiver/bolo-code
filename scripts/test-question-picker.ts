/**
 * AR-T3+ · AskUserQuestion 的 CLI 选择控件
 *
 * 现有 `arrowPicker` 只能单选，而且空格键已经被占作「确认」，改造不了；
 * 多选与多问题分组都得新写。照 arrowPicker 的分层来：
 * **纯键位 reducer + 纯渲染 + 可注入 readKey 的循环**——这样绝大部分逻辑
 * 不需要真终端就能测。
 *
 * 三个必须守住的点：
 *
 * ① **不许替用户选。** 空选择不能提交，取消就是取消。这是契约层
 *    「不许编答案」在 UI 层的延续——UI 是最容易图省事塞个默认值的地方。
 *
 * ② **非 TTY 要如实说做不到**，而不是随便挑一个。没有终端就没有用户，
 *    这与 `askPermission` 非 TTY 直接 deny 同理。
 *
 * ③ **自由文本要标出来。** 用户自己敲的内容不能混进「他选了你给的选项」，
 *    否则模型会当成自己预设的分支去处理。
 *
 * 运行：npx tsx scripts/test-question-picker.ts
 */
import {
  applyQuestionPickerKey,
  createQuestionPickerState,
  formatQuestionPickerScreen,
  runQuestionPicker,
  type QuestionPickerState,
} from '../packages/cli/src/tui/questionPicker.ts'
import type { AskQuestion } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const SINGLE: AskQuestion = {
  question: 'Which database?',
  header: 'Database',
  multiSelect: false,
  options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'MySQL' }],
}

const MULTI: AskQuestion = {
  question: 'Which features?',
  header: 'Features',
  multiSelect: true,
  options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
}

function press(state: QuestionPickerState, keys: string[]): QuestionPickerState {
  let s = state
  for (const k of keys) s = applyQuestionPickerKey(s, k).state
  return s
}

function lastDone(state: QuestionPickerState, keys: string[]) {
  let s = state
  let done: unknown
  for (const k of keys) {
    const r = applyQuestionPickerKey(s, k)
    s = r.state
    done = r.done
  }
  return { state: s, done }
}

async function main() {
  // ── 1) 光标移动环绕 ──
  {
    const s0 = createQuestionPickerState([SINGLE])
    // 3 个选项 + 1 个 Other 行 = 4 行
    assert(s0.rowCount === 4, `options plus an Other row, got ${s0.rowCount}`)
    assert(press(s0, ['down']).cursor === 1, 'down moves')
    assert(press(s0, ['up']).cursor === 3, 'up wraps to the last row')
    assert(press(s0, ['down', 'down', 'down', 'down']).cursor === 0, 'wraps around')
  }

  // ── 2) 单选：enter 直接给出答案 ──
  {
    const s0 = createQuestionPickerState([SINGLE])
    const { done } = lastDone(s0, ['down', 'enter'])
    assert(done, 'enter finishes a single-select question')
    const d = done as { kind: string; selection?: { selected: string[] } }
    assert(d.kind === 'answered', `answered, got ${d.kind}`)
    assert(
      JSON.stringify(d.selection?.selected) === JSON.stringify(['SQLite']),
      `picks the row under the cursor: ${JSON.stringify(d.selection)}`,
    )
  }

  // ── 3) 多选：空格勾选，enter 提交 ──
  {
    const s0 = createQuestionPickerState([MULTI])
    const s1 = press(s0, [' ', 'down', 'down', ' '])
    assert(s1.checked.size === 2, `two rows checked, got ${s1.checked.size}`)
    const { done } = lastDone(s1, ['enter'])
    const d = done as { kind: string; selection?: { selected: string[] } }
    assert(d.kind === 'answered', 'multi submits')
    assert(
      JSON.stringify(d.selection?.selected) === JSON.stringify(['Auth', 'Search']),
      `keeps option order, not click order: ${JSON.stringify(d.selection)}`,
    )
  }

  // ── 4) 多选空提交必须被挡住 —— 不许替用户选 ──
  {
    const s0 = createQuestionPickerState([MULTI])
    const r = applyQuestionPickerKey(s0, 'enter')
    assert(!r.done, 'empty multi-select submit is refused, not defaulted')
    assert(
      typeof r.state.notice === 'string' && r.state.notice.length > 0,
      'tells the user why nothing happened instead of silently ignoring the key',
    )
  }

  // ── 5) 空格在单选里不该造成「勾了但没提交」的中间态 ──
  {
    const s0 = createQuestionPickerState([SINGLE])
    const r = applyQuestionPickerKey(s0, ' ')
    assert(
      r.done !== undefined,
      'space in a single-select question selects rather than toggling into limbo',
    )
  }

  // ── 6) 取消就是取消 ──
  {
    for (const k of ['esc', 'ctrl-c', 'q']) {
      const s0 = createQuestionPickerState([SINGLE])
      const r = applyQuestionPickerKey(s0, k)
      assert(r.done, `${k} finishes`)
      assert(
        (r.done as { kind: string }).kind === 'cancelled',
        `${k} cancels rather than picking something`,
      )
    }
  }

  // ── 7) Other 行 → 要求自由文本，而不是当成一个选项 ──
  {
    const s0 = createQuestionPickerState([SINGLE])
    // 光标移到最后一行（Other）
    const { done } = lastDone(s0, ['up', 'enter'])
    const d = done as { kind: string }
    assert(
      d.kind === 'custom',
      `choosing Other asks for free text, got ${d.kind}`,
    )
  }

  // ── 8) 渲染：问题、选项、当前光标、勾选状态都要看得见 ──
  {
    const s = press(createQuestionPickerState([MULTI]), [' ', 'down'])
    const screen = formatQuestionPickerScreen(s)
    assert(screen.includes('Which features?'), `shows the question: ${screen}`)
    assert(screen.includes('Auth') && screen.includes('Search'), 'shows options')
    assert(/\[x\]|\[✓\]|●/.test(screen), `shows what is checked: ${screen}`)
    assert(
      /other/i.test(screen),
      `shows that answering in your own words is possible: ${screen}`,
    )
    assert(
      /space|enter/i.test(screen),
      `shows the keys — an invisible keymap is an unusable one: ${screen}`,
    )
  }

  // ── 9) 多问题：逐题推进，全部答完才结束 ──
  {
    const s0 = createQuestionPickerState([SINGLE, MULTI])
    assert(s0.total === 2, 'two questions')
    const screen = formatQuestionPickerScreen(s0)
    assert(/1\s*\/\s*2|1 of 2/i.test(screen), `shows progress: ${screen}`)
  }

  // ── 10) runQuestionPicker：注入按键，走完两题 ──
  {
    const keys = ['down', 'enter', ' ', 'enter']
    let i = 0
    const out: string[] = []
    const r = await runQuestionPicker({
      questions: [SINGLE, MULTI],
      isTty: true,
      readKey: async () => keys[i++] ?? 'esc',
      writeOut: (s) => out.push(s),
    })
    assert(r.kind === 'answered', `both questions answered: ${JSON.stringify(r)}`)
    const sel = (r as { selections: Array<{ selected: string[] }> }).selections
    assert(sel.length === 2, `one selection per question, got ${sel.length}`)
    assert(sel[0]!.selected[0] === 'SQLite', `q1: ${JSON.stringify(sel[0])}`)
    assert(sel[1]!.selected[0] === 'Auth', `q2: ${JSON.stringify(sel[1])}`)
  }

  // ── 11) 中途取消 → 整体取消，不交半份答案 ──
  {
    const keys = ['down', 'enter', 'esc']
    let i = 0
    const r = await runQuestionPicker({
      questions: [SINGLE, MULTI],
      isTty: true,
      readKey: async () => keys[i++] ?? 'esc',
      writeOut: () => {},
    })
    assert(
      r.kind === 'cancelled',
      `cancelling question 2 cancels the whole thing — a half-filled answer set is worse than none: ${JSON.stringify(r)}`,
    )
  }

  // ── 12) 非 TTY → 如实说做不到 ──
  {
    const r = await runQuestionPicker({
      questions: [SINGLE],
      isTty: false,
      writeOut: () => {},
    })
    assert(
      r.kind === 'unavailable',
      `no terminal means no user; must not pick something: ${JSON.stringify(r)}`,
    )
  }

  // ── 13) 自由文本走完整条链 ──
  {
    const keys = ['up', 'enter']
    let i = 0
    const r = await runQuestionPicker({
      questions: [SINGLE],
      isTty: true,
      readKey: async () => keys[i++] ?? 'esc',
      readLine: async () => 'DuckDB',
      writeOut: () => {},
    })
    assert(r.kind === 'answered', `free text answers: ${JSON.stringify(r)}`)
    const sel = (r as { selections: Array<{ selected: string[]; custom?: boolean }> })
      .selections
    assert(sel[0]!.selected[0] === 'DuckDB', 'carries the typed text')
    assert(
      sel[0]!.custom === true,
      'marks it custom — the model must not treat it as one of its own options',
    )
  }

  // ── 14) 自由文本敲了空的 → 不算答案，回到选择 ──
  {
    const keys = ['up', 'enter', 'down', 'enter']
    let i = 0
    const r = await runQuestionPicker({
      questions: [SINGLE],
      isTty: true,
      readKey: async () => keys[i++] ?? 'esc',
      readLine: async () => '   ',
      writeOut: () => {},
    })
    assert(
      r.kind === 'answered',
      `empty free text falls back to the list rather than submitting nothing: ${JSON.stringify(r)}`,
    )
    const sel = (r as { selections: Array<{ selected: string[]; custom?: boolean }> })
      .selections
    assert(sel[0]!.custom !== true, 'blank input is not a custom answer')
  }

  console.log('PASS: question picker')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
