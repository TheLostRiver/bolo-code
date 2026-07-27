/**
 * AR3D · composer 意图 → 会话控制请求（纯函数）
 *
 * 设计文档 §2.4 定的规则：**queue 与 steer 必须是两个显式动作**，
 * 不靠一个全局默认态让用户猜。这条直接来自 Codex App 的缺陷
 * （[#10469](https://github.com/openai/codex/issues/10469)）：桌面端两者
 * 不能在同一会话共存，且 steer 有时表现得像 queue——turn 跑完才生效。
 * 结果是用户以为自己在打断，实际只是排了个队。
 *
 * core 侧的契约本来就是确定的（`SessionControlRequest` 有 queue/steer/interrupt
 * 三种 kind、`expectedTurnId` 防打错目标、`controlId` 防重复提交）。
 * 会糊掉的是 UI 层——所以翻译放在 packages，UI 只按结果画按钮。
 *
 * ## 三条守住的语义
 *
 * **① 不提供注定失败的动作。** 没有活跃 turn 时 steer / interrupt 无处可施；
 * 界面若照样给按钮，用户点了只会拿到一个错误码。可用性必须由这层算出来，
 * 附带**不可用的原因**——否则 UI 只能显示一个灰按钮而说不出为什么。
 *
 * **② 同一意图必须产出同一 controlId。** 手抖点两下、或网络慢重发一次，
 * 都不该变成两条控制记录。core 有 `duplicate` 语义，但前提是 id 稳定。
 *
 * **③ 一律带 expectedTurnId。** 界面上看到的 turn 可能已经结束了；
 * 不带这个字段，打断就会打到下一个 turn 头上——那是最糟的一种「成功」。
 *
 * 运行：npx tsx scripts/test-composer-intent.ts
 */
import {
  buildComposerActions,
  composerIntentToControl,
} from '../packages/shared/src/composerIntent.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const IDLE = { sessionId: 's1', activeTurnId: undefined }
const BUSY = { sessionId: 's1', activeTurnId: 't7' }

function main() {
  // ── 1) 空闲时：只有普通提交，其余明确不可用且给出原因 ──
  {
    const actions = buildComposerActions({ runner: IDLE, text: 'hello' })
    const submit = actions.find((a) => a.action === 'submit')!
    assert(submit.available === true, 'plain submit works when nothing is running')

    for (const kind of ['queue', 'steer', 'interrupt'] as const) {
      const a = actions.find((x) => x.action === kind)!
      assert(
        a.available === false,
        `${kind} is not offered with no active turn — a button that can only fail is worse than no button`,
      )
      assert(
        typeof a.unavailableReason === 'string' && a.unavailableReason.length > 0,
        `${kind} says why it is unavailable, so the UI can explain rather than grey out silently`,
      )
    }
  }

  // ── 2) 运行中：queue / steer / interrupt 同时可用，且**各自独立** ──
  // 这是对 #10469 的直接回应：不能只给一个「发送」再靠某个默认态决定语义。
  {
    const actions = buildComposerActions({ runner: BUSY, text: 'stop that' })
    const queue = actions.find((a) => a.action === 'queue')!
    const steer = actions.find((a) => a.action === 'steer')!
    const interrupt = actions.find((a) => a.action === 'interrupt')!
    assert(queue.available && steer.available && interrupt.available,
      'all three are separately available while a turn is running')
    assert(
      queue.label !== steer.label,
      'queue and steer are labelled differently — the whole point is that the user chooses',
    )
  }

  // ── 3) 运行中普通提交不可用：它会静默变成排队还是打断，正是要消灭的歧义 ──
  {
    const submit = buildComposerActions({ runner: BUSY, text: 'x' }).find(
      (a) => a.action === 'submit',
    )!
    assert(
      submit.available === false,
      'plain submit is not offered mid-turn — that ambiguity is exactly the bug being avoided',
    )
  }

  // ── 4) 空文本：queue / steer 不可用，interrupt 仍可用 ──
  // 打断不需要说什么。
  {
    const actions = buildComposerActions({ runner: BUSY, text: '   ' })
    assert(
      actions.find((a) => a.action === 'queue')!.available === false,
      'queueing nothing is meaningless',
    )
    assert(
      actions.find((a) => a.action === 'steer')!.available === false,
      'steering with no message is meaningless',
    )
    assert(
      actions.find((a) => a.action === 'interrupt')!.available === true,
      'interrupt needs no text',
    )
  }

  // ── 5) 翻译出的请求一律带 expectedTurnId ──
  // 不带的话，打断会打到下一个 turn 头上——最糟的一种「成功」。
  {
    for (const action of ['queue', 'steer', 'interrupt'] as const) {
      const r = composerIntentToControl({
        runner: BUSY,
        text: 'do it',
        action,
      })
      assert(r.ok, `${action} translates: ${JSON.stringify(r)}`)
      assert(
        r.ok && r.control.expectedTurnId === 't7',
        `${action} carries expectedTurnId so a finished turn cannot be hit by mistake`,
      )
      assert(
        r.ok && r.control.kind === action,
        `${action} maps to the matching control kind`,
      )
    }
  }

  // ── 6) queue 分配稳定的新 turnId，不能复用正在运行的 turn ──
  {
    const first = composerIntentToControl({
      runner: BUSY,
      text: 'run later',
      action: 'queue',
    })
    const repeated = composerIntentToControl({
      runner: BUSY,
      text: 'run later',
      action: 'queue',
    })
    assert(first.ok && repeated.ok, 'queue intent translates')
    assert(
      first.ok &&
        first.control.kind === 'queue' &&
        first.control.turnId !== first.control.expectedTurnId,
      'queue turnId identifies the new queued turn, not the active turn it follows',
    )
    assert(
      first.ok &&
        first.control.kind === 'queue' &&
        repeated.ok &&
        repeated.control.kind === 'queue' &&
        first.control.turnId === repeated.control.turnId,
      'retrying the same queue intent keeps the same queued turnId',
    )
  }

  // ── 7) 同一意图 → 同一 controlId（防重复提交）──
  {
    const a = composerIntentToControl({ runner: BUSY, text: 'go', action: 'steer' })
    const b = composerIntentToControl({ runner: BUSY, text: 'go', action: 'steer' })
    assert(a.ok && b.ok, 'both translate')
    assert(
      a.ok && b.ok && a.control.controlId === b.control.controlId,
      'the same intent yields the same controlId — a double click must not become two controls',
    )

    const other = composerIntentToControl({
      runner: BUSY,
      text: 'go',
      action: 'queue',
    })
    assert(
      other.ok && a.ok && other.control.controlId !== a.control.controlId,
      'a different action is a different control, even with identical text',
    )

    const laterTurn = composerIntentToControl({
      runner: { sessionId: 's1', activeTurnId: 't8' },
      text: 'go',
      action: 'steer',
    })
    assert(
      laterTurn.ok && a.ok && laterTurn.control.controlId !== a.control.controlId,
      'the same text aimed at a different turn is a different control',
    )
  }

  // ── 8) 不可用的动作翻译时必须被拒，且给结构化原因 ──
  {
    const r = composerIntentToControl({ runner: IDLE, text: 'x', action: 'steer' })
    assert(!r.ok, 'translating an unavailable action fails instead of producing a doomed request')
    assert(
      !r.ok && r.code === 'no_active_turn',
      `with a code the caller can branch on: ${JSON.stringify(r)}`,
    )
  }

  // ── 9) queue 需要 active turn；缺了要拒而不是编一个 ──
  {
    const r = composerIntentToControl({
      runner: { sessionId: 's1', activeTurnId: undefined },
      text: 'later',
      action: 'queue',
    })
    assert(!r.ok, 'queueing with no turn to queue behind is refused')
  }

  // ── 10) IPC 等不可信调用方不能靠 TypeScript 类型兜底 ──
  {
    const badAction = composerIntentToControl({
      runner: BUSY,
      text: 'x',
      action: 'destroy' as never,
    })
    assert(
      !badAction.ok && badAction.code === 'invalid_action',
      'unknown action is rejected instead of falling through as interrupt',
    )

    const badText = composerIntentToControl({
      runner: BUSY,
      text: 42 as never,
      action: 'queue',
    })
    assert(
      !badText.ok && badText.code === 'invalid_text',
      'non-string text is rejected instead of throwing at trim()',
    )
  }

  // ── 11) 纯函数 ──
  {
    const runner = { sessionId: 's1', activeTurnId: 't1' }
    const before = JSON.stringify(runner)
    buildComposerActions({ runner, text: 'a' })
    composerIntentToControl({ runner, text: 'a', action: 'steer' })
    assert(JSON.stringify(runner) === before, 'never mutates its input')
  }

  console.log('PASS: composer intent')
}

main()
