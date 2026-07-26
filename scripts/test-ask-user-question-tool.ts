/**
 * AR-T3+ · AskUserQuestion 工具壳 + 权限归类
 *
 * 契约层（test-ask-user-question.ts）已经守住「不许编答案」。本文件守住
 * 工具壳与权限系统这两处**接线**，它们各有一个致命失败模式：
 *
 * ① **无人在场时挂死。** 工具在等一个永远不会 resolve 的 Promise，
 *    整个 runner 就停在那里，既不报错也不退出。比编答案还糟——
 *    编答案至少还能往下跑。既有先例是 `askPermission` 未注入时默认 `'deny'`
 *    （core/src/index.ts）与 ExitPlanMode 未绑定时返回 `errorCode:'unavailable'`。
 *
 * ② **plan 模式把它 deny 掉。** 权限 gate 的 plan 分支只放行 `read` 类，
 *    其余一律 deny。而「规划时先问清需求」正是这个工具最主要的用途——
 *    落到 `unknown` 就等于在最该用它的地方用不了。
 *    另外两档也会错：`acceptEdits` / `auto` 会先弹一次权限审批，
 *    也就是「问问题之前先问要不要问问题」。
 *
 * 运行：npx tsx scripts/test-ask-user-question-tool.ts
 */
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
  type AskUserQuestionAskerRef,
} from '../packages/tools/src/askUserQuestion.ts'
import { createBuiltinTools } from '../packages/tools/src/builtins.ts'
import {
  ASK_USER_QUESTION_TOOL_NAME as PERM_ASK_NAME,
  classifyTool,
  decidePermission,
  createEmptyPermissionRules,
} from '../packages/permissions/src/index.ts'
import type { ToolContext } from '../packages/tools/src/types.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const QUESTIONS = {
  questions: [
    {
      question: 'Which database should we use?',
      header: 'Database',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    },
  ],
}

function ctxWith(
  asker: AskUserQuestionAskerRef | undefined,
  signal?: AbortSignal,
): ToolContext {
  return {
    cwd: process.cwd(),
    ...(signal ? { signal } : {}),
    extras: asker ? { askUserQuestion: asker } : {},
  } as ToolContext
}

async function main() {
  const tool = createAskUserQuestionTool()

  // ── 1) 工具元数据 ──
  {
    assert(tool.name === ASK_USER_QUESTION_TOOL_NAME, 'stable tool name')
    assert(
      tool.requiresPermission === false,
      'asking a question is not an action that needs approval — the question IS the prompt',
    )
    assert(tool.isReadOnly({}) === true, 'touches nothing on the machine')
    assert(
      tool.isConcurrencySafe({}) === false,
      'two questions at once would fight over the terminal',
    )
    assert(
      tool.interruptBehavior() === 'cancel',
      'user interrupt should drop a pending question, not block on it',
    )
  }

  // ── 2) 已注册进内置工具表，否则模型根本看不到 ──
  {
    const names = createBuiltinTools().map((t) => t.name)
    assert(
      names.includes(ASK_USER_QUESTION_TOOL_NAME),
      `registered in builtins: ${names.join(', ')}`,
    )
  }

  // ── 3) 没人可问 → unavailable 错误，不挂死、不编答案 ──
  {
    const res = await Promise.race([
      tool.call(QUESTIONS as never, ctxWith(undefined)),
      new Promise((r) => setTimeout(() => r({ timedOut: true }), 3000)),
    ])
    assert(
      !(res as { timedOut?: boolean }).timedOut,
      'must not hang when nobody is there to answer',
    )
    const r = res as { ok: boolean; isError?: boolean; errorCode?: string; output?: string }
    assert(r.ok === false && r.isError === true, 'reports an error')
    assert(r.errorCode === 'unavailable', `errorCode is unavailable, got ${r.errorCode}`)
    assert(
      /no user|nobody|unavailable|non-interactive/i.test(String(r.output)),
      `says why: ${r.output}`,
    )
    // 关键：不能出现任何看起来像「用户选了什么」的内容
    assert(
      !/Postgres|SQLite/.test(String(r.output)),
      `must not name an option — that reads as a real answer: ${r.output}`,
    )
  }

  // ── 4) 输入不合法 → 校验错误，且**不去打扰用户** ──
  {
    let asked = 0
    const asker: AskUserQuestionAskerRef = {
      ask: async () => {
        asked++
        return { kind: 'answered', selections: [{ selected: ['Postgres'] }] }
      },
    }
    const r = await tool.call(
      { questions: [{ question: 'x', header: 'H', options: [{ label: 'only' }] }] } as never,
      ctxWith(asker),
    )
    assert(r.ok === false && r.isError === true, 'rejects a malformed question')
    assert(
      asked === 0,
      'a malformed question must never reach the user — fix it before interrupting them',
    )
  }

  // ── 5) 正常问答 ──
  {
    const seen: unknown[] = []
    const asker: AskUserQuestionAskerRef = {
      ask: async (questions) => {
        seen.push(questions)
        return { kind: 'answered', selections: [{ selected: ['SQLite'] }] }
      },
    }
    const r = await tool.call(QUESTIONS as never, ctxWith(asker))
    assert(r.ok === true, `answered call succeeds: ${JSON.stringify(r)}`)
    assert(String(r.output).includes('SQLite'), `carries the answer: ${r.output}`)
    assert(
      String(r.output).includes('Database') ||
        String(r.output).includes('Which database'),
      `ties answer to question: ${r.output}`,
    )
    assert(
      Array.isArray(seen[0]) && (seen[0] as unknown[]).length === 1,
      'the asker receives the validated questions',
    )
  }

  // ── 6) 用户取消 → 明确的「没答」，不是编一个 ──
  {
    const asker: AskUserQuestionAskerRef = {
      ask: async () => ({ kind: 'cancelled' }),
    }
    const r = await tool.call(QUESTIONS as never, ctxWith(asker))
    assert(r.ok === false, 'cancel is not success')
    assert(
      !/Postgres|SQLite/.test(String(r.output)),
      `cancel must not name an option: ${r.output}`,
    )
    assert(
      /declin|cancel|did not answer/i.test(String(r.output)),
      `says the user declined: ${r.output}`,
    )
  }

  // ── 7) UI 交回对不上号的答案 → 拒绝，绝不放行 ──
  // 这是「不许编」在工具层的最后一道闸：UI 有 bug、或恢复流程串了行，
  // 都不能变成一条看起来合理的历史记录。
  {
    for (const [label, selections] of [
      ['unknown label', [{ selected: ['MySQL'] }]],
      ['too many answers', [{ selected: ['Postgres'] }, { selected: ['SQLite'] }]],
      ['empty selection', [{ selected: [] }]],
    ] as Array<[string, unknown]>) {
      const asker: AskUserQuestionAskerRef = {
        ask: async () => ({ kind: 'answered', selections: selections as never }),
      }
      const r = await tool.call(QUESTIONS as never, ctxWith(asker))
      assert(r.ok === false, `rejects ${label} from the UI`)
      assert(r.isError === true, `flags ${label} as an error`)
    }
  }

  // ── 8) abort 必须能中断等待，不能永远 pending ──
  {
    const ac = new AbortController()
    const asker: AskUserQuestionAskerRef = {
      // 永不 resolve —— 模拟 UI 卡住
      ask: () => new Promise(() => {}),
    }
    const p = tool.call(QUESTIONS as never, ctxWith(asker, ac.signal))
    setTimeout(() => ac.abort(), 100)
    const res = await Promise.race([
      p,
      new Promise((r) => setTimeout(() => r({ timedOut: true }), 3000)),
    ])
    assert(
      !(res as { timedOut?: boolean }).timedOut,
      'abort must break the wait — a pending question cannot own the runner forever',
    )
    const r = res as { ok: boolean; output?: string }
    assert(r.ok === false, 'aborted call is not a success')
    assert(
      !/Postgres|SQLite/.test(String(r.output)),
      `aborted call must not name an option: ${r.output}`,
    )
  }

  // ── 9) 权限归类：五档模式**都**必须能问 ──
  {
    assert(
      PERM_ASK_NAME === ASK_USER_QUESTION_TOOL_NAME,
      `the tool-name constant is duplicated across packages to avoid a cycle; the two copies must not drift: ${PERM_ASK_NAME} vs ${ASK_USER_QUESTION_TOOL_NAME}`,
    )
    assert(
      classifyTool(ASK_USER_QUESTION_TOOL_NAME) === 'read',
      `must not fall into "unknown" — plan mode denies unknown, and planning is exactly when clarifying matters most (got ${classifyTool(ASK_USER_QUESTION_TOOL_NAME)})`,
    )

    for (const mode of [
      'default',
      'plan',
      'acceptEdits',
      'auto',
      'bypassPermissions',
    ] as const) {
      const d = decidePermission({
        mode,
        toolName: ASK_USER_QUESTION_TOOL_NAME,
        toolInput: QUESTIONS,
        cwd: process.cwd(),
        requiresPermission: false,
        rules: createEmptyPermissionRules(),
      })
      assert(
        d.behavior === 'allow',
        `${mode}: asking the user must not need a separate approval (got ${d.behavior} — ${d.reason})`,
      )
    }
  }

  console.log('PASS: ask user question tool')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
