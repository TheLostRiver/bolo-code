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
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  applyQuestionPickerKey,
  createQuestionPickerState,
  formatQuestionPickerScreen,
  runTextQuestionPicker,
  type QuestionPickerState,
} from '../packages/cli/src/tui/questionPicker.ts'
import { createTtyAskUserQuestion } from '../packages/cli/src/tui/askUserQuestionTty.ts'
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

  // ── 10) plain text：编号单选 + 逗号多选，不替用户补答案 ──
  {
    const answers = ['invalid', '2', '1,3']
    const writes: string[] = []
    const result = await runTextQuestionPicker({
      questions: [SINGLE, MULTI],
      readLine: async (prompt) => {
        writes.push(prompt)
        return answers.shift() ?? 'q'
      },
      writeOut: (text) => writes.push(text),
    })
    assert(result.kind === 'answered', `plain answers: ${JSON.stringify(result)}`)
    if (result.kind !== 'answered') throw new Error('plain picker did not answer')
    assert(
      JSON.stringify(result.selections[0]?.selected) === JSON.stringify(['SQLite']) &&
        JSON.stringify(result.selections[1]?.selected) ===
          JSON.stringify(['Auth', 'Search']),
      `plain picker preserves model option order: ${JSON.stringify(result.selections)}`,
    )
    assert(
      writes.join('').includes('Choose one number') &&
        writes.join('').includes('comma-separated'),
      'plain picker gives actionable retry and multi-select guidance',
    )
  }

  // ── 11) plain text Other：自由文本明确标记 custom ──
  {
    const answers = ['other', 'DuckDB']
    const result = await runTextQuestionPicker({
      questions: [SINGLE],
      readLine: async () => answers.shift() ?? 'q',
      writeOut: () => {},
    })
    assert(result.kind === 'answered', 'plain custom answer completes')
    if (result.kind !== 'answered') throw new Error('custom answer missing')
    assert(
      result.selections[0]?.custom === true &&
        result.selections[0]?.selected[0] === 'DuckDB',
      'plain custom answer is not disguised as a model option',
    )
  }

  // ── 12) plain production adapter 复用注入的 readline ──
  {
    const answers = ['2']
    const asker = createTtyAskUserQuestion({
      isTty: true,
      readLine: async () => answers.shift() ?? 'q',
      writeOut: () => {},
    })
    const result = await asker.ask([SINGLE])
    assert(
      result.kind === 'answered' &&
        result.selections[0]?.selected[0] === 'SQLite',
      'plain production adapter returns the explicit numbered answer',
    )
  }

  // ── 13) retained adapter 不创建第二个 stdin owner ──
  {
    let overlayCalls = 0
    const asker = createTtyAskUserQuestion({
      isTty: true,
      runQuestionOverlay: async ({ questions }) => {
        overlayCalls += 1
        assert(questions[0] === SINGLE, 'overlay receives the original question')
        return {
          kind: 'answered',
          selections: [{ selected: ['SQLite'] }],
        }
      },
    })
    const result = await asker.ask([SINGLE])
    assert(
      result.kind === 'answered' &&
        result.selections[0]?.selected[0] === 'SQLite',
      'retained adapter returns the OverlayHost result',
    )
    assert(
      overlayCalls === 1,
      'retained question stays inside the existing OverlayHost',
    )
  }

  const askerSource = await readFile(
    path.resolve('packages/cli/src/tui/askUserQuestionTty.ts'),
    'utf8',
  )
  const resumeSource = await readFile(
    path.resolve('packages/cli/src/resumeCli.ts'),
    'utf8',
  )
  assert(
    !askerSource.includes('runQuestionPicker'),
    'production AskUserQuestion adapter has no legacy raw picker fallback',
  )
  assert(
    resumeSource.includes(
      'session.askUserQuestion = createTtyAskUserQuestion({',
    ) &&
      resumeSource.includes('question(prompt, turnController.signal)'),
    'plain REPL injects its existing readline into each turn question adapter',
  )

  console.log('PASS: question picker')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
