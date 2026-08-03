/**
 * HKP-3: plan 模式与权限系统正交化 —
 * 组合矩阵（权限模式 × plan 开关）、ExitPlanMode 恢复原模式、/plan 语义。
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createExitPlanModeTool,
  type BoloTool,
  type PlanModeStoreRef,
} from '../packages/tools/src/index.ts'
import { runToolUse } from '../packages/core/src/toolExecution.ts'
import {
  createSession,
  setPermissionMode,
} from '../packages/core/src/index.ts'

function writeTool(): BoloTool {
  return {
    name: 'Write',
    description: 'mock write',
    inputJSONSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isEnabled: () => true,
    interruptBehavior: () => 'block',
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => ({ ok: true, output: 'written' }),
  }
}

function readTool(): BoloTool {
  return {
    name: 'Read',
    description: 'mock read',
    inputJSONSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isEnabled: () => true,
    interruptBehavior: () => 'block',
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => ({ ok: true, output: 'content' }),
  }
}

async function runWithPlan(
  mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'auto',
  planMode: boolean,
  toolName: string,
  tool: BoloTool,
  store: PlanModeStoreRef,
): Promise<{
  denied: boolean
  blocked: boolean
  decision?: string
  store: PlanModeStoreRef
}> {
  let decision: string | undefined
  const ctx = {
    sessionId: 'hkp3',
    cwd: process.cwd(),
    hooks: {},
    permissionMode: mode,
    planMode,
    askPermission: async () => 'allow' as const,
    tools: [tool, createExitPlanModeTool()],
    classifyPermission: async () => ({ decision: 'allow' as const, reason: 'spy' }),
    autoModeState: undefined,
    planModeStore: store,
    onEvent: (e: { type: string; behavior?: string }) => {
      if (e.type === 'permission_decision') decision = e.behavior
    },
  }
  const result = await runToolUse(
    { id: `t-${toolName}`, name: toolName, input: { path: 'x' } },
    ctx,
  )
  return { denied: result.denied, blocked: result.blocked, decision, store }
}

async function main(): Promise<void> {
  const root = path.resolve('.bolo-tmp', 'test-plan-orthogonal')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })

  // ---- gate 组合矩阵：plan 激活时任何权限模式都强制只读 ----
  const storeTemplate = (planMode: boolean): PlanModeStoreRef => ({
    permissionMode: 'bypassPermissions',
    planMode,
  })
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'auto'] as const) {
    const store = storeTemplate(true)
    const write = await runWithPlan(mode, true, 'Write', writeTool(), store)
    assert.equal(
      write.denied,
      true,
      `plan + ${mode} denies Write (plan is read-only everywhere)`,
    )
    const read = await runWithPlan(mode, true, 'Read', readTool(), store)
    assert.equal(
      read.denied,
      false,
      `plan + ${mode} allows Read`,
    )
  }

  // ---- plan 关闭时原语义不变（含 bypassPermissions 全放行）----
  {
    const store = storeTemplate(false)
    const write = await runWithPlan(
      'bypassPermissions',
      false,
      'Write',
      writeTool(),
      store,
    )
    assert.equal(write.denied, false, 'bypassPermissions without plan allows Write')
    assert.equal(
      write.decision,
      'allow',
      'bypass gate is allow (no plan)',
    )
    const asked = await runWithPlan('default', false, 'Write', writeTool(), store)
    assert.equal(
      asked.decision,
      'ask',
      'default without plan asks for Write (normal gate semantics)',
    )
  }

  // ---- ExitPlanMode 正交路径：批准后恢复原模式 ----
  {
    const store: PlanModeStoreRef = {
      permissionMode: 'bypassPermissions',
      planMode: true,
    }
    const ctx = {
      sessionId: 'hkp3',
      cwd: root,
      hooks: {},
      permissionMode: 'bypassPermissions' as const,
      planMode: true,
      askPermission: async () => 'allow' as const,
      tools: [createExitPlanModeTool()],
      planModeStore: store,
    }
    const result = await runToolUse(
      {
        id: 't-exit',
        name: 'ExitPlanMode',
        input: { plan: '1. read\n2. patch\n3. test' },
      },
      ctx,
    )
    assert.equal(result.denied, false, 'ExitPlanMode is askable in plan mode')
    assert(
      result.toolResultMessage.content.includes('Plan approved'),
      `approval message reaches the model: ${result.toolResultMessage.content}`,
    )
    assert.equal(store.planMode, false, 'plan switch cleared after approval')
    assert.equal(
      store.permissionMode,
      'bypassPermissions',
      'original permission mode restored (not downgraded to default)',
    )
  }

  // ---- /plan slash：激活 plan 且保持权限模式 ----
  {
    const session = await createSession({
      cwd: root,
      systemPrompt: false,
      permissionMode: 'acceptEdits',
      model: 'mock-model',
    })
    assert.equal(session.planMode, undefined, 'new sessions start without plan')
    setPermissionMode(session, 'plan')
    assert.equal(session.planMode, true, '/plan activates the orthogonal switch')
    assert.equal(
      session.permissionMode,
      'acceptEdits',
      '/plan keeps the permission mode untouched',
    )
    setPermissionMode(session, 'default')
    assert.equal(session.planMode, false, 'switching modes clears plan')
    assert.equal(session.permissionMode, 'default', 'mode switch applies')
  }

  // ---- queryLoop 级接线：bypassPermissions + plan → Write 仍被拒绝 ----
  {
    const messages: import('../packages/shared/src/index.ts').ChatMessage[] = [
      { role: 'user', content: 'run plan' },
    ]
    let round = 0
    const callModel: import('../packages/core/src/index.ts').CallModelFn =
      async function* () {
        round += 1
        if (round > 1) {
          yield { type: 'text_delta', text: 'done' }
          yield { type: 'done' }
          return
        }
        yield {
          type: 'tool_call',
          id: 'c1',
          name: 'Write',
          arguments: JSON.stringify({ path: 'x' }),
        }
        yield { type: 'done' }
      }
    const terminal = await (
      await import('../packages/core/src/index.ts')
    ).queryLoop({
      sessionId: 'hkp3-loop',
      cwd: root,
      hooks: {},
      messages,
      deps: {
        callModel,
        prepareMessages: async ({ messages: m }) => ({ messages: m }),
        uuid: () => 'hkp3-loop',
      },
      permissionMode: 'bypassPermissions',
      planMode: true,
      askPermission: async () => 'allow',
      maxTurns: 5,
      maxPtlRetries: 0,
      tools: [writeTool()],
    })
    assert.equal(terminal.reason, 'completed')
    const writeResult = messages.find(
      (m) => m.role === 'tool' && typeof m.content === 'string',
    )
    assert(
      writeResult &&
        typeof writeResult.content === 'string' &&
        writeResult.content.includes('permission denied'),
      `plan + bypassPermissions still denies Write through the real wiring: ${writeResult?.content}`,
    )
  }

  // ---- plan+auto：ExitPlanMode 强制走用户审批（分类器不可零交互批准）----
  {
    const store: PlanModeStoreRef = {
      permissionMode: 'auto',
      planMode: true,
    }
    let classifyCalls = 0
    let askCalls = 0
    const ctx = {
      sessionId: 'hkp3',
      cwd: root,
      hooks: {},
      permissionMode: 'auto' as const,
      planMode: true,
      askPermission: async () => {
        askCalls += 1
        return 'deny' as const
      },
      tools: [createExitPlanModeTool()],
      classifyPermission: async () => {
        classifyCalls += 1
        return { decision: 'allow' as const, reason: 'spy' }
      },
      autoModeState: undefined,
      planModeStore: store,
    }
    const result = await runToolUse(
      {
        id: 't-exit-auto',
        name: 'ExitPlanMode',
        input: { plan: '1. read\n2. patch' },
      },
      ctx,
    )
    assert.equal(
      classifyCalls,
      0,
      'plan+auto never routes ExitPlanMode to the classifier',
    )
    assert.equal(
      askCalls,
      1,
      'plan+auto forces the user approval path',
    )
    assert.equal(result.denied, true, 'user deny keeps plan mode active')
    assert.equal(store.planMode, true, 'plan switch survives a deny')
  }

  // ---- snapshot roundtrip：planMode 随快照保存并恢复 ----
  {
    const snapDir = path.join(root, 'snap')
    await fs.mkdir(snapDir, { recursive: true })
    const session = await createSession({
      cwd: root,
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      planMode: true,
      model: 'mock-model',
    })
    const { saveSession, resumeSession } = await import(
      '../packages/core/src/index.ts'
    )
    const { path: snapPath } = await saveSession(session, {
      sessionsDir: snapDir,
      writeJsonSnapshot: true,
    })
    const resumed = await resumeSession({
      idOrPath: snapPath,
      cwd: root,
      reassembleSystem: false,
      systemPrompt: false,
    })
    assert.equal(
      resumed.session.planMode,
      true,
      'plan mode survives save + resume',
    )
    assert.equal(
      resumed.session.permissionMode,
      'bypassPermissions',
      'original mode restored alongside plan',
    )
  }

  await fs.rm(root, { recursive: true, force: true })
  console.log('PASS: HKP-3 plan mode orthogonal to permissions')
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
