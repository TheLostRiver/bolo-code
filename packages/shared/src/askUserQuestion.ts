/**
 * AR-T3+ · AskUserQuestion 契约
 *
 * 模型遇到歧义时，现在只能猜，或者用自由文本发问再自己解析回答。
 * 这个工具把「问一句」变成结构化的一问一答。
 *
 * 它和其它工具有一处根本不同：**结果不是算出来的，是人给的。**
 * 于是本模块的核心职责不是「生成答案」，而是**挡住不是人给的答案**：
 *
 * - `validateAskUserQuestionInput` 挡住模型问得不成样子的问题
 * - `projectAskUserQuestionAnswers` 挡住对不上号的回答
 *
 * 后者尤其重要。会话里若出现一条「用户选择了 X」而用户根本没选过，
 * 后续每一轮都会把它当既定事实，而且**永远不会报错**——静默失败里
 * 最难查的一种。所以宁可整条拒绝，也不做任何补全或猜测。
 *
 * 与 UI 无关：本模块不知道终端、不知道 Electron，只定义形状与规则。
 */

export const ASK_MAX_QUESTIONS = 4
export const ASK_MIN_OPTIONS = 2
export const ASK_MAX_OPTIONS = 4
/** header 是 UI 里的短标签（chip），过长会撑破窄终端 */
export const ASK_MAX_HEADER_CHARS = 12

export type AskQuestionOption = {
  label: string
  description?: string
}

export type AskQuestion = {
  question: string
  /** 短标签，用于 UI 里标识这一问 */
  header: string
  /** true = 可多选 */
  multiSelect: boolean
  options: AskQuestionOption[]
}

export type AskUserQuestionValidation =
  | { ok: true; questions: AskQuestion[] }
  | { ok: false; code: string; detail: string }

/** UI 交回来的原始选择 */
export type AskUserQuestionSelection = {
  /** 选中的 label；自由文本时是用户自己敲的内容 */
  selected: string[]
  /** true = 用户没选任何预设项，自己写的 */
  custom?: boolean
}

/** 投影后、可以进上下文的一问一答 */
export type AskUserQuestionAnswer = {
  question: string
  header: string
  selected: string[]
  custom: boolean
}

export type AskUserQuestionProjection =
  | { ok: true; answers: AskUserQuestionAnswer[] }
  | { ok: false; code: string; detail: string }

function fail(code: string, detail: string): { ok: false; code: string; detail: string } {
  return { ok: false, code, detail }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function validateAskUserQuestionInput(
  raw: unknown,
): AskUserQuestionValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('invalid_input', 'input must be an object with a questions array')
  }
  const questions = (raw as { questions?: unknown }).questions
  if (!Array.isArray(questions)) {
    return fail('invalid_questions', 'questions must be an array')
  }
  if (questions.length === 0) {
    return fail('no_questions', 'ask at least one question')
  }
  if (questions.length > ASK_MAX_QUESTIONS) {
    return fail(
      'too_many_questions',
      `ask at most ${ASK_MAX_QUESTIONS} questions at a time (got ${questions.length})`,
    )
  }

  const out: AskQuestion[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const where = `questions[${i}]`
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      return fail('invalid_question', `${where} must be an object`)
    }
    const rec = q as Record<string, unknown>

    if (!nonEmptyString(rec.question)) {
      return fail('empty_question', `${where}.question must be a non-empty string`)
    }
    if (!nonEmptyString(rec.header)) {
      return fail('empty_header', `${where}.header must be a non-empty string`)
    }
    if ((rec.header as string).trim().length > ASK_MAX_HEADER_CHARS) {
      return fail(
        'header_too_long',
        `${where}.header must be at most ${ASK_MAX_HEADER_CHARS} characters`,
      )
    }

    const options = rec.options
    if (!Array.isArray(options)) {
      return fail('invalid_options', `${where}.options must be an array`)
    }
    if (options.length < ASK_MIN_OPTIONS) {
      // 一个选项不构成选择题；模型此时该直接做事，而不是走个形式
      return fail(
        'too_few_options',
        `${where} needs at least ${ASK_MIN_OPTIONS} options (got ${options.length})`,
      )
    }
    if (options.length > ASK_MAX_OPTIONS) {
      return fail(
        'too_many_options',
        `${where} allows at most ${ASK_MAX_OPTIONS} options (got ${options.length})`,
      )
    }

    const parsed: AskQuestionOption[] = []
    const seen = new Set<string>()
    for (let j = 0; j < options.length; j++) {
      const o = options[j]
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        return fail('invalid_option', `${where}.options[${j}] must be an object`)
      }
      const orec = o as Record<string, unknown>
      if (!nonEmptyString(orec.label)) {
        return fail(
          'empty_option_label',
          `${where}.options[${j}].label must be a non-empty string`,
        )
      }
      const label = (orec.label as string).trim()
      if (seen.has(label)) {
        // 重复 label 会让「用户选了哪个」变得不可判定
        return fail(
          'duplicate_option_label',
          `${where} has two options labelled "${label}"`,
        )
      }
      seen.add(label)
      parsed.push({
        label,
        ...(nonEmptyString(orec.description)
          ? { description: (orec.description as string).trim() }
          : {}),
      })
    }

    out.push({
      question: (rec.question as string).trim(),
      header: (rec.header as string).trim(),
      multiSelect: rec.multiSelect === true,
      options: parsed,
    })
  }

  return { ok: true, questions: out }
}

/**
 * 把 UI 交回的选择投影成可进上下文的一问一答。
 *
 * **只做校验与配对，绝不补全。** 任何对不上号的输入都整条拒绝：
 * 与其留下一条看似合理、实则没发生过的「用户选择」，不如报错。
 */
export function projectAskUserQuestionAnswers(
  questions: readonly AskQuestion[],
  selections: readonly AskUserQuestionSelection[],
): AskUserQuestionProjection {
  if (!Array.isArray(selections)) {
    return fail('invalid_selections', 'selections must be an array')
  }
  if (selections.length !== questions.length) {
    return fail(
      'answer_count_mismatch',
      `expected ${questions.length} answer(s), got ${selections.length}`,
    )
  }

  const answers: AskUserQuestionAnswer[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    const sel = selections[i]
    if (!sel || typeof sel !== 'object') {
      return fail('invalid_selection', `selections[${i}] must be an object`)
    }
    if (!Array.isArray(sel.selected)) {
      return fail('invalid_selection', `selections[${i}].selected must be an array`)
    }
    const picked = (sel.selected as unknown[])
      .filter((s): s is string => nonEmptyString(s))
      .map((s) => s.trim())
    if (picked.length === 0) {
      // 「没选」不是一种答案。要表达放弃，调用方应当整体取消，而不是交一个空选择。
      return fail('empty_selection', `selections[${i}] selected nothing`)
    }
    if (!q.multiSelect && picked.length > 1) {
      return fail(
        'multiple_answers_to_single_select',
        `questions[${i}] is single-select but got ${picked.length} answers`,
      )
    }

    const custom = sel.custom === true
    if (!custom) {
      const offered = new Set(q.options.map((o) => o.label))
      for (const p of picked) {
        if (!offered.has(p)) {
          return fail(
            'unknown_option',
            `questions[${i}] was never offered "${p}" (offered: ${[...offered].join(', ')})`,
          )
        }
      }
    }

    answers.push({
      question: q.question,
      header: q.header,
      selected: picked,
      custom,
    })
  }

  return { ok: true, answers }
}

/**
 * 渲染给模型看的结果。
 *
 * 两条要求：
 * - **问答必须成对**。只给一串 label，模型无从判断哪个答的是哪问。
 * - **自由文本要标出来**。否则模型会把它当成自己预设的分支之一去处理。
 */
export function formatAskUserQuestionResult(
  answers: readonly AskUserQuestionAnswer[],
): string {
  if (!answers.length) return 'The user did not answer.'
  return answers
    .map((a) => {
      const value = a.selected.join(', ')
      const suffix = a.custom
        ? '  (the user answered in their own words; this was not one of the offered options)'
        : ''
      return `${a.header} — ${a.question}\n  ${value}${suffix}`
    })
    .join('\n')
}
