/**
 * AR3D · composer 意图 → 会话控制请求（纯函数）
 *
 * 规则来自 `docs/DESKTOP_DESIGN.md` §2.4：**queue 与 steer 必须是两个显式动作**，
 * 不靠一个全局默认态让用户猜。这条是从 Codex App 的缺陷学的
 * （issue #10469）：桌面端两者不能在同一会话共存，且 steer 有时表现得像 queue
 * ——turn 跑完才生效。用户以为自己在打断，实际只是排了个队。
 *
 * core 的契约本身是确定的：`SessionControlRequest` 三种 kind、
 * `expectedTurnId` 防打错目标、`controlId` 防重复提交。**会糊掉的是 UI 层**，
 * 所以翻译放在这里，UI 只按结果画按钮。
 *
 * ## 三条守住的语义
 *
 * **① 不提供注定失败的动作。** 没有活跃 turn 时 steer / interrupt 无处可施，
 * 界面若照样给按钮，用户点了只会拿到错误码。可用性由这层算，并附**原因**——
 * 否则 UI 只能灰一个按钮却说不出为什么。
 *
 * **② 同一意图产出同一 controlId。** 手抖点两下、或慢网重发，都不该变成
 * 两条控制记录。core 有 duplicate 语义，但前提是 id 稳定。
 *
 * **③ 一律带 expectedTurnId。** 界面上看到的 turn 可能已经结束；不带它，
 * 打断会打到下一个 turn 头上——那是最糟的一种「成功」。
 */

export type ComposerAction = 'submit' | 'queue' | 'steer' | 'interrupt'

export type ComposerRunnerState = {
  sessionId: string
  /** 有值 = 正在跑某个 turn */
  activeTurnId?: string
}

export type ComposerActionOption = {
  action: ComposerAction
  label: string
  /** 一句话说明这个动作会发生什么，供 UI 直接展示 */
  hint: string
  available: boolean
  /** 不可用时必须给原因；只灰按钮不解释等于让用户自己猜 */
  unavailableReason?: string
}

export type ComposerControlRequest = {
  controlId: string
  kind: 'queue' | 'steer' | 'interrupt'
  sessionId: string
  expectedTurnId: string
  turnId?: string
  prompt?: string
}

export type ComposerIntentResult =
  | { ok: true; control: ComposerControlRequest }
  | {
      ok: false
      code: 'no_active_turn' | 'empty_prompt' | 'not_a_control'
      detail: string
    }

export type ComposerIntentInput = {
  runner: ComposerRunnerState
  text: string
  action: ComposerAction
}

/**
 * 稳定的 controlId：只由 (会话, turn, 动作, 文本) 决定。
 *
 * 刻意**不带时间戳或随机数**——那样每次点击都会变成一条新控制，
 * core 的 duplicate 检测就永远不会命中，双击直接变两条。
 */
function stableControlId(
  sessionId: string,
  turnId: string,
  action: string,
  text: string,
): string {
  const material = `${sessionId} ${turnId} ${action} ${text}`
  // FNV-1a：够用即可，这里只需要稳定与低碰撞，不做密码学用途
  let h = 0x811c9dc5
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `ctl_${action}_${h.toString(36)}`
}

export function buildComposerActions(opts: {
  runner: ComposerRunnerState
  text: string
}): ComposerActionOption[] {
  const busy = Boolean(opts.runner.activeTurnId)
  const hasText = opts.text.trim().length > 0

  return [
    {
      action: 'submit',
      label: 'Send',
      hint: 'start a new turn',
      available: !busy && hasText,
      // 运行中不给普通提交：它到底算排队还是打断，正是要消灭的歧义
      ...(busy
        ? { unavailableReason: 'a turn is already running — choose queue or steer' }
        : hasText
          ? {}
          : { unavailableReason: 'nothing to send' }),
    },
    {
      action: 'queue',
      label: 'Queue',
      hint: 'runs after the current turn finishes',
      available: busy && hasText,
      ...(!busy
        ? { unavailableReason: 'nothing is running to queue behind' }
        : hasText
          ? {}
          : { unavailableReason: 'nothing to queue' }),
    },
    {
      action: 'steer',
      label: 'Steer now',
      hint: 'injected into the running turn at the next safe point',
      available: busy && hasText,
      ...(!busy
        ? { unavailableReason: 'nothing is running to steer' }
        : hasText
          ? {}
          : { unavailableReason: 'nothing to steer with' }),
    },
    {
      action: 'interrupt',
      // 打断不需要说什么，所以它不受文本约束
      label: 'Interrupt',
      hint: 'stops the running turn',
      available: busy,
      ...(busy ? {} : { unavailableReason: 'nothing is running' }),
    },
  ]
}

export function composerIntentToControl(
  input: ComposerIntentInput,
): ComposerIntentResult {
  const { runner, action } = input
  const text = input.text.trim()

  if (action === 'submit') {
    return {
      ok: false,
      code: 'not_a_control',
      detail: 'plain submit starts a turn; it is not a session control',
    }
  }

  const turnId = runner.activeTurnId
  if (!turnId) {
    return {
      ok: false,
      code: 'no_active_turn',
      detail: `${action} needs a running turn to act on`,
    }
  }

  if (action !== 'interrupt' && !text) {
    return {
      ok: false,
      code: 'empty_prompt',
      detail: `${action} needs a message`,
    }
  }

  return {
    ok: true,
    control: {
      controlId: stableControlId(runner.sessionId, turnId, action, text),
      kind: action,
      sessionId: runner.sessionId,
      // 永远带上：界面看到的 turn 可能已经结束，不带它就会打到下一个 turn 头上
      expectedTurnId: turnId,
      ...(action === 'queue' ? { turnId } : {}),
      ...(action === 'interrupt' ? {} : { prompt: text }),
    },
  }
}
