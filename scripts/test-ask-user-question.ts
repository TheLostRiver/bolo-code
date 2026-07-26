/**
 * AR-T3+ · AskUserQuestion 契约
 *
 * 这个工具存在的理由：模型遇到歧义时，现在只能**猜**，或者用自由文本发问
 * 然后自己解析回答。猜错是陌生人说「不好用」的头号原因。
 *
 * 它和别的工具有一处根本不同：**结果不是算出来的，是人给的。**
 * 由此产生本文件里最重要的一条断言——
 *
 *   没有人在场时，绝不允许编一个答案。
 *
 * 这条不是洁癖。会话里若出现一条「用户选择了 X」而用户根本没选过，
 * 后续每一轮都会把它当成既定事实，而且**永远不会报错**。
 * 先例就在手边：headless 下 `askPermission` 默认 `'deny'`（fail-closed），
 * 不是默认放行。同样的形状照抄即可。
 *
 * 断言挂在导出常量上而不是魔数：上下限日后要对齐参考实现时，改常量即可。
 *
 * 运行：npx tsx scripts/test-ask-user-question.ts
 */
import {
  ASK_MAX_QUESTIONS,
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  formatAskUserQuestionResult,
  projectAskUserQuestionAnswers,
  validateAskUserQuestionInput,
} from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function q(over: Record<string, unknown> = {}) {
  return {
    question: 'Which database should we use?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'relational' },
      { label: 'SQLite', description: 'embedded' },
    ],
    ...over,
  }
}

function main() {
  // ── 1) 正常输入通过，且把校验后的结构原样交出 ──
  {
    const r = validateAskUserQuestionInput({ questions: [q()] })
    assert(r.ok, `valid input passes: ${JSON.stringify(r)}`)
    assert(r.ok && r.questions.length === 1, 'one question survives')
    assert(
      r.ok && r.questions[0]!.options.length === 2,
      'options survive',
    )
  }

  // ── 2) 结构性拒绝 ──
  {
    const bad: Array<[string, unknown]> = [
      ['no questions', { questions: [] }],
      ['questions not an array', { questions: 'nope' }],
      ['missing questions', {}],
      ['question text empty', { questions: [q({ question: '   ' })] }],
      ['header empty', { questions: [q({ header: '' })] }],
      [
        'too few options',
        { questions: [q({ options: [{ label: 'only one' }] })] },
      ],
      ['no options', { questions: [q({ options: [] })] }],
      [
        'blank option label',
        {
          questions: [
            q({ options: [{ label: 'ok' }, { label: '  ' }] }),
          ],
        },
      ],
      [
        'duplicate option labels',
        {
          questions: [
            q({ options: [{ label: 'Same' }, { label: 'Same' }] }),
          ],
        },
      ],
    ]
    for (const [label, input] of bad) {
      const r = validateAskUserQuestionInput(input)
      assert(!r.ok, `rejects ${label}`)
      assert(
        !r.ok && typeof r.detail === 'string' && r.detail.length > 0,
        `says why for ${label}`,
      )
      assert(!r.ok && !!r.code, `carries an errorCode for ${label}`)
    }
  }

  // ── 3) 上下限（挂常量，不写魔数）──
  {
    const tooMany = Array.from({ length: ASK_MAX_QUESTIONS + 1 }, (_, i) =>
      q({ question: `q${i}?`, header: `H${i}` }),
    )
    assert(
      !validateAskUserQuestionInput({ questions: tooMany }).ok,
      `rejects more than ${ASK_MAX_QUESTIONS} questions`,
    )
    const okCount = Array.from({ length: ASK_MAX_QUESTIONS }, (_, i) =>
      q({ question: `q${i}?`, header: `H${i}` }),
    )
    assert(
      validateAskUserQuestionInput({ questions: okCount }).ok,
      `accepts exactly ${ASK_MAX_QUESTIONS} questions`,
    )

    const manyOpts = Array.from({ length: ASK_MAX_OPTIONS + 1 }, (_, i) => ({
      label: `opt${i}`,
    }))
    assert(
      !validateAskUserQuestionInput({ questions: [q({ options: manyOpts })] })
        .ok,
      `rejects more than ${ASK_MAX_OPTIONS} options`,
    )
    assert(
      ASK_MIN_OPTIONS >= 2,
      'a single-option question is not a question — min is at least 2',
    )
  }

  // ── 4) 答案投影：绝不接受对不上号的回答 ──
  // 这是「不许编」在契约层的落点。UI 层写错、或恢复流程串了行，
  // 都必须在这里被挡下，而不是变成一条看起来合理的历史记录。
  {
    const asked = validateAskUserQuestionInput({ questions: [q()] })
    assert(asked.ok, 'setup')
    const questions = asked.ok ? asked.questions : []

    const good = projectAskUserQuestionAnswers(questions, [
      { selected: ['Postgres'] },
    ])
    assert(good.ok, `a real selection projects: ${JSON.stringify(good)}`)
    assert(
      good.ok && good.answers[0]!.selected[0] === 'Postgres',
      'answer carries what was chosen',
    )
    assert(
      good.ok && good.answers[0]!.question === questions[0]!.question,
      'answer is tied to the question it answers',
    )

    const bad: Array<[string, unknown[]]> = [
      ['answer count mismatch', []],
      ['too many answers', [{ selected: ['Postgres'] }, { selected: ['SQLite'] }]],
      ['label that was never offered', [{ selected: ['MySQL'] }]],
      ['empty selection', [{ selected: [] }]],
      ['selection not an array', [{ selected: 'Postgres' }]],
    ]
    for (const [label, answers] of bad) {
      const r = projectAskUserQuestionAnswers(questions, answers as never)
      assert(!r.ok, `rejects ${label} — a fabricated answer must never survive`)
    }
  }

  // ── 5) 单选就是单选 ──
  {
    const asked = validateAskUserQuestionInput({ questions: [q()] })
    const questions = asked.ok ? asked.questions : []
    const r = projectAskUserQuestionAnswers(questions, [
      { selected: ['Postgres', 'SQLite'] },
    ])
    assert(
      !r.ok,
      'a single-select question must not accept two answers',
    )
  }

  // ── 6) 多选可多，但仍须都是被提供过的选项 ──
  {
    const asked = validateAskUserQuestionInput({
      questions: [
        q({
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        }),
      ],
    })
    const questions = asked.ok ? asked.questions : []
    const ok = projectAskUserQuestionAnswers(questions, [
      { selected: ['A', 'C'] },
    ])
    assert(ok.ok, `multi-select takes several: ${JSON.stringify(ok)}`)
    const bad = projectAskUserQuestionAnswers(questions, [
      { selected: ['A', 'Z'] },
    ])
    assert(!bad.ok, 'one bogus label poisons the whole answer')
  }

  // ── 7) 自由文本（"Other"）必须被标记出来 ──
  // 模型需要知道这不是它给的选项之一，否则会当成自己预设的分支去处理。
  {
    const asked = validateAskUserQuestionInput({ questions: [q()] })
    const questions = asked.ok ? asked.questions : []
    const r = projectAskUserQuestionAnswers(questions, [
      { selected: ['MongoDB'], custom: true },
    ])
    assert(r.ok, `free-text answer is allowed when marked custom: ${JSON.stringify(r)}`)
    assert(r.ok && r.answers[0]!.custom === true, 'custom flag survives')
    const text = formatAskUserQuestionResult(r.ok ? r.answers : [])
    assert(
      /own words|custom|not one of the offered/i.test(text),
      `the rendered result tells the model this was free text: ${text}`,
    )
  }

  // ── 8) 给模型看的文本必须问答对应，不能只有答案 ──
  {
    const asked = validateAskUserQuestionInput({
      questions: [
        q(),
        q({
          question: 'Which runtime?',
          header: 'Runtime',
          options: [{ label: 'Node' }, { label: 'Bun' }],
        }),
      ],
    })
    const questions = asked.ok ? asked.questions : []
    const r = projectAskUserQuestionAnswers(questions, [
      { selected: ['SQLite'] },
      { selected: ['Bun'] },
    ])
    assert(r.ok, 'two answers project')
    const text = formatAskUserQuestionResult(r.ok ? r.answers : [])
    assert(text.includes('SQLite') && text.includes('Bun'), `carries both answers: ${text}`)
    assert(
      text.includes('Database') || text.includes('Which database'),
      `ties each answer to its question — a bare list of labels is ambiguous: ${text}`,
    )
  }

  console.log('PASS: ask user question contract')
}

main()
