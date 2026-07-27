/**
 * AR3 · Desktop 侧 AskUserQuestion 桥
 *
 * ROADMAP §14.5 记的缺口：core 只持提问句柄，CLI 注入了一个，**Desktop 没有**。
 * 于是桌面端里这个工具永远返回 `unavailable`——不是坏了，是根本没接。
 *
 * 桥本身逻辑很少，但它有一处**必须守住**：
 *
 * > **没答就是没答，绝不能变成「答了」。**
 *
 * 理由在 `packages/shared/src/askUserQuestion.ts` 的模块头里写着：会话里一旦
 * 出现一条「用户选择了 X」而用户根本没选过，后续每一轮都会把它当既定事实，
 * 而且**永远不会报错**。超时、窗口没了、渲染进程发来垃圾——这三种都不是答案。
 *
 * 渲染进程是**独立进程**，它的回包按不可信输入对待。真正的形状校验在
 * `projectAskUserQuestionAnswers`（已有且已被工具层调用），所以桥不重复校验，
 * 但它**不得把非答案伪装成答案**去绕过那道关。
 *
 * 运行：npx tsx scripts/test-desktop-ask-user-question.ts
 */
import { createDesktopAskUserQuestion } from '../apps/desktop/src/main/askUserQuestionBridge.ts'
import {
  projectAskUserQuestionAnswers,
  type AskQuestion,
} from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const QUESTIONS: AskQuestion[] = [
  {
    question: 'Which database should we use?',
    header: 'Database',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  },
]

/**
 * 等一个应当**已经**尘埃落定的 Promise。
 *
 * 这个包装不是装饰。桥挂住不返回时，`await` 的那条链永远不 resolve，
 * 于是 node 的事件循环空掉、进程以 **exit 0** 退出——**挂死会静默通过**。
 * 拆掉「没有窗口就立刻收口」那段来验红时正是这样：测试没变红，
 * 因为它压根没跑到断言。
 *
 * 所以每一个 await 都必须带截止时间：**没按时返回本身就是失败**。
 */
async function settled<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} never settled — a bridge that hangs looks like a passing test, ` +
              `because an unresolved promise lets node exit 0`,
          ),
        ),
      2000,
    )
  })
  try {
    return await Promise.race([p, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 可控时钟：不真的等 120 秒 */
function fakeTimers() {
  let pending: Array<{ fn: () => void; at: number }> = []
  let now = 0
  return {
    setTimer: (fn: () => void, ms: number) => {
      const h = { fn, at: now + ms }
      pending.push(h)
      return h as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (h: unknown) => {
      pending = pending.filter((p) => p !== h)
    },
    advance(ms: number) {
      now += ms
      const due = pending.filter((p) => p.at <= now)
      pending = pending.filter((p) => p.at > now)
      for (const d of due) d.fn()
    },
    get pendingCount() {
      return pending.length
    },
  }
}

async function main() {
  // ── 1) 没有窗口 → unavailable，且**立刻**返回 ──
  // 挂在那儿等一个不存在的窗口，表现是 agent 整轮卡死，比报错更难查。
  {
    const timers = fakeTimers()
    const bridge = createDesktopAskUserQuestion({
      send: () => false, // 没有 window
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const outcome = await settled(bridge.asker.ask(QUESTIONS), 'ask() with no window')
    assert(
      outcome.kind === 'unavailable',
      `no renderer window means unavailable, got ${outcome.kind}`,
    )
    assert(
      timers.pendingCount === 0,
      'and it does not leave a timer running for an answer that can never arrive',
    )
  }

  // ── 2) 正常作答 → answered，且选择原样传下去 ──
  {
    const timers = fakeTimers()
    const sent: Array<{ channel: string; payload: unknown }> = []
    const bridge = createDesktopAskUserQuestion({
      send: (channel, payload) => {
        sent.push({ channel, payload })
        return true
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const p = bridge.asker.ask(QUESTIONS)

    assert(sent.length === 1, 'the question was pushed to the renderer exactly once')
    const payload = sent[0]!.payload as { id: string; questions: AskQuestion[] }
    assert(typeof payload.id === 'string' && payload.id.length > 0, 'it carries an id')
    assert(
      JSON.stringify(payload.questions) === JSON.stringify(QUESTIONS),
      'and the questions verbatim — the renderer must not have to reconstruct them',
    )

    const accepted = bridge.resolve(payload.id, {
      selections: [{ selected: ['Postgres'] }],
    })
    assert(accepted, 'the response was accepted')

    const outcome = await settled(p, 'ask()')
    assert(outcome.kind === 'answered', `got ${outcome.kind}`)
    assert(
      outcome.kind === 'answered' &&
        JSON.stringify(outcome.selections) ===
          JSON.stringify([{ selected: ['Postgres'] }]),
      'the selections pass through unchanged',
    )
    // 且它确实能通过下游的投影关（否则「答了」也没用）
    const proj = projectAskUserQuestionAnswers(
      QUESTIONS,
      outcome.kind === 'answered' ? outcome.selections : [],
    )
    assert(proj.ok, `the answer survives projection: ${proj.ok ? '' : proj.detail}`)
    assert(timers.pendingCount === 0, 'the timeout timer was cleared')
  }

  // ── 3) 用户主动放弃 → cancelled ──
  {
    const timers = fakeTimers()
    let id = ''
    const bridge = createDesktopAskUserQuestion({
      send: (_c, payload) => {
        id = (payload as { id: string }).id
        return true
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const p = bridge.asker.ask(QUESTIONS)
    bridge.resolve(id, { cancelled: true })
    const outcome = await settled(p, 'ask()')
    assert(outcome.kind === 'cancelled', `got ${outcome.kind}`)
  }

  // ── 4) 超时 → cancelled，**绝不是** answered ──
  // 这是本文件的核心断言。一条编出来的答案会作为既定事实留在会话里，
  // 之后每一轮都当真，且永远不报错。
  {
    const timers = fakeTimers()
    const bridge = createDesktopAskUserQuestion({
      send: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      timeoutMs: 1000,
    })
    const p = bridge.asker.ask(QUESTIONS)
    assert(timers.pendingCount === 1, 'setup: a timeout really is armed')
    timers.advance(1001)
    const outcome = await settled(p, 'ask()')
    assert(
      outcome.kind !== 'answered',
      'a timeout must never be reported as an answer — nobody answered',
    )
    assert(outcome.kind === 'cancelled', `got ${outcome.kind}`)
  }

  // ── 5) 取消信号 → cancelled，且不再占着 pending ──
  {
    const timers = fakeTimers()
    let id = ''
    const bridge = createDesktopAskUserQuestion({
      send: (_c, payload) => {
        id = (payload as { id: string }).id
        return true
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const ac = new AbortController()
    const p = bridge.asker.ask(QUESTIONS, { signal: ac.signal })
    ac.abort()
    const outcome = await settled(p, 'ask()')
    assert(outcome.kind === 'cancelled', `an aborted turn cancels the question, got ${outcome.kind}`)
    assert(
      bridge.resolve(id, { selections: [{ selected: ['Postgres'] }] }) === false,
      'and a late answer for that question is dropped rather than resolving nothing',
    )
  }

  // ── 5b) 信号在提问之前就已取消 → 连对话框都不该弹 ──
  // 上一条测的是「问出去之后再取消」（走 listener）。这一条测的是
  // 「这一轮早就没了才轮到提问」——那时候在用户屏幕上弹一个属于已死轮次的
  // 对话框，是纯粹的打扰：他答了也没人接。
  {
    const timers = fakeTimers()
    let pushes = 0
    const bridge = createDesktopAskUserQuestion({
      send: () => {
        pushes++
        return true
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const ac = new AbortController()
    ac.abort()
    const outcome = await settled(
      bridge.asker.ask(QUESTIONS, { signal: ac.signal }),
      'ask() with an already-aborted signal',
    )
    assert(outcome.kind === 'cancelled', `already-aborted asks cancel, got ${outcome.kind}`)
    assert(
      pushes === 0,
      'and no dialog is pushed to the renderer for a turn that is already over',
    )
    assert(timers.pendingCount === 0, 'nor is a timer left behind')
  }

  // ── 6) 渲染进程的回包是不可信输入 ──
  {
    const timers = fakeTimers()
    let id = ''
    const bridge = createDesktopAskUserQuestion({
      send: (_c, payload) => {
        id = (payload as { id: string }).id
        return true
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    // 未知 id 不得炸、也不得误伤别的等待者
    assert(
      bridge.resolve('no_such_id', { selections: [] }) === false,
      'an unknown id is rejected rather than throwing',
    )

    const p = bridge.asker.ask(QUESTIONS)
    // 垃圾回包**原样**交给下游投影去拒——转成 cancelled 等于替用户说
    // 「我放弃了」，那同样是编的。
    bridge.resolve(id, { selections: 'not-an-array' })
    const outcome = await settled(p, 'ask()')
    assert(outcome.kind === 'answered', 'a claimed answer is not silently reinterpreted')
    const proj = projectAskUserQuestionAnswers(
      QUESTIONS,
      (outcome.kind === 'answered' ? outcome.selections : []) as never,
    )
    assert(
      !proj.ok,
      'and the existing projection guard is what rejects it, with a precise reason',
    )
  }

  // ── 7) 重复回包只算第一次 ──
  // 渲染进程重放（双击、重连、恶意）不得覆盖已经交出去的答案。
  {
    const timers = fakeTimers()
    let id = ''
    const bridge = createDesktopAskUserQuestion({
      send: (_c, payload) => {
        id = (payload as { id: string }).id
        return true
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const p = bridge.asker.ask(QUESTIONS)
    assert(bridge.resolve(id, { selections: [{ selected: ['Postgres'] }] }), 'first wins')
    assert(
      bridge.resolve(id, { selections: [{ selected: ['SQLite'] }] }) === false,
      'a replay is dropped instead of overwriting the answer already handed over',
    )
    const outcome = await settled(p, 'ask()')
    assert(
      outcome.kind === 'answered' && outcome.selections[0]!.selected[0] === 'Postgres',
      'the first answer is the one that stands',
    )
  }

  // ── 8) 并发两问互不串台 ──
  {
    const timers = fakeTimers()
    const ids: string[] = []
    const bridge = createDesktopAskUserQuestion({
      send: (_c, payload) => {
        ids.push((payload as { id: string }).id)
        return true
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const a = bridge.asker.ask(QUESTIONS)
    const b = bridge.asker.ask(QUESTIONS)
    assert(ids.length === 2 && ids[0] !== ids[1], 'each question gets its own id')
    bridge.resolve(ids[1]!, { selections: [{ selected: ['SQLite'] }] })
    bridge.resolve(ids[0]!, { selections: [{ selected: ['Postgres'] }] })
    const [ra, rb] = await settled(Promise.all([a, b]), 'two concurrent asks')
    assert(
      ra.kind === 'answered' && ra.selections[0]!.selected[0] === 'Postgres',
      'the first asker got its own answer',
    )
    assert(
      rb.kind === 'answered' && rb.selections[0]!.selected[0] === 'SQLite',
      'and the second got its own',
    )
  }

  console.log('PASS: desktop AskUserQuestion bridge')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
