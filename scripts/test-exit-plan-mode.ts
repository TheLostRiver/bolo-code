/**
 * AR-T3a：plan 模式的出口
 *
 * 现状：`/plan` 把 permissionMode 设成 'plan'，除 read 外全 deny，
 * 但**没有任何退出路径**——模型规划完了没法说「计划好了，批准我就执行」，
 * 系统提示却写着 "until the user leaves plan mode"。开口没闭口。
 *
 * 契约（安全优先）：
 * - plan 模式下 `ExitPlanMode` 必须**可 ask**，否则出口本身会被 plan 的 deny 挡住
 * - 但它仍然要走**用户审批**，绝不能变成静默提权
 * - 批准 → 退出到 `default`（仍逐个审批），**不是** acceptEdits / bypass；
 *   用户批准的是「这个计划」，不是「随便写」
 * - 拒绝 → 留在 plan 模式，并告诉模型继续规划
 * - 非 plan 模式下调用它是无意义的，要明确拒绝而不是悄悄改模式
 *
 * 运行：npx tsx scripts/test-exit-plan-mode.ts
 */
import { decidePermission } from '../packages/permissions/src/index.ts'
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  createExitPlanModeTool,
  type PlanModeStoreRef,
} from '../packages/tools/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function gate(toolName: string, mode: 'plan' | 'default', category: string) {
  return decidePermission({
    toolName,
    mode,
    category: category as never,
    rules: undefined,
  } as never)
}

async function main() {
  // ── 1) plan 模式仍然拦住真正的副作用 ──
  assert(
    gate('Write', 'plan', 'edit').behavior === 'deny',
    'plan mode still denies edits',
  )
  assert(
    gate('Bash', 'plan', 'shell').behavior === 'deny',
    'plan mode still denies shell',
  )
  assert(
    gate('Read', 'plan', 'read').behavior === 'allow',
    'plan mode still allows reads',
  )

  // ── 2) 出口必须能被 ask，否则它会被 plan 的 deny 吃掉 ──
  const exitDecision = gate(EXIT_PLAN_MODE_TOOL_NAME, 'plan', 'unknown')
  assert(
    exitDecision.behavior === 'ask',
    `ExitPlanMode must be askable in plan mode, got ${exitDecision.behavior}`,
  )
  assert(
    !/not allowed|planning only/i.test(exitDecision.reason ?? ''),
    `exit must not be reported as blocked by plan mode: ${exitDecision.reason}`,
  )

  // ── 3) 绝不静默放行：出口不能是 allow ──
  assert(
    exitDecision.behavior !== 'allow',
    'leaving plan mode must never bypass user approval',
  )

  // ── 4) 批准 → 退出到 default（逐个审批），不是 acceptEdits / bypass ──
  {
    const store: PlanModeStoreRef = { permissionMode: 'plan' }
    const tool = createExitPlanModeTool()
    const r = await tool.call(
      { plan: '1. read config\n2. patch the parser\n3. run tests' },
      { cwd: process.cwd(), extras: { planModeStore: store } },
    )
    assert(r.ok === true, `approved exit succeeds: ${r.output}`)
    assert(
      store.permissionMode === 'default',
      `exits to default, got ${store.permissionMode}`,
    )
    assert(
      store.permissionMode !== 'acceptEdits' &&
        store.permissionMode !== 'bypassPermissions',
      'approving a plan is not blanket write access',
    )
    assert(
      /plan mode/i.test(r.output),
      `result tells the model the mode changed: ${r.output}`,
    )
  }

  // ── 5) 空计划要拒绝：出口不是「随便调一下就出去」 ──
  {
    const store: PlanModeStoreRef = { permissionMode: 'plan' }
    const tool = createExitPlanModeTool()
    const r = await tool.call(
      { plan: '   ' },
      { cwd: process.cwd(), extras: { planModeStore: store } },
    )
    assert(r.ok === false, 'empty plan rejected')
    assert(store.permissionMode === 'plan', 'rejected call leaves mode alone')
  }

  // ── 6) 不在 plan 模式时调用是无意义的，要明说 ──
  {
    const store: PlanModeStoreRef = { permissionMode: 'default' }
    const tool = createExitPlanModeTool()
    const r = await tool.call(
      { plan: 'do the thing' },
      { cwd: process.cwd(), extras: { planModeStore: store } },
    )
    assert(r.ok === false, 'calling outside plan mode fails')
    assert(
      /not in plan mode/i.test(r.output),
      `explains why: ${r.output}`,
    )
    assert(store.permissionMode === 'default', 'mode untouched')
  }

  // ── 7) 没有 store 时明确失败，不静默改全局状态 ──
  {
    const tool = createExitPlanModeTool()
    const r = await tool.call({ plan: 'x' }, { cwd: process.cwd() })
    assert(r.ok === false, 'no store means explicit failure')
    assert(r.errorCode === 'unavailable', 'unavailable error code')
  }

  // ── 8) 其它模式不受影响（回归） ──
  assert(
    gate('Write', 'default', 'edit').behavior !== 'deny',
    'default mode unchanged by the plan-mode exemption',
  )
  assert(
    gate(EXIT_PLAN_MODE_TOOL_NAME, 'default', 'unknown').behavior !== 'allow',
    'the exemption is scoped to plan mode only',
  )

  console.log('PASS: exit plan mode')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
