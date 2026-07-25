/**
 * DR3A：durable background task/result schema、产品 wiring 与恢复投影。
 * 运行：npx tsx scripts/test-session-task-recovery.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_TOOL_NAME,
  appendTaskEntry,
  createAgentTool,
  createSession,
  identityPrepareMessages,
  loadTranscriptFile,
  projectDurableTaskEvents,
  projectDurableTasks,
  resumeSession,
  submitPrompt,
  type QueryDeps,
} from '../packages/core/src/index.ts'
import { createBuiltinTools } from '../packages/tools/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

async function waitFor(
  check: () => boolean,
  message: string,
): Promise<void> {
  for (let index = 0; index < 80; index++) {
    if (check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`ASSERT: timed out: ${message}`)
}

async function main() {
  const incomplete = projectDurableTaskEvents([
    {
      type: 'state',
      taskId: 'agent_incomplete',
      sessionId: 'task_projection_session',
      parentTurnId: 'turn_parent',
      agentType: 'general',
      state: 'admitted',
      prompt: 'recover this task',
      isolation: 'none',
      timestamp: '2026-07-26T07:00:00.000Z',
    },
    {
      type: 'state',
      taskId: 'agent_incomplete',
      sessionId: 'task_projection_session',
      agentType: 'general',
      state: 'running',
      timestamp: '2026-07-26T07:00:01.000Z',
    },
    {
      type: 'result',
      taskId: 'agent_incomplete',
      sessionId: 'task_projection_session',
      summary: 'result reached disk before terminal',
      isError: false,
      timestamp: '2026-07-26T07:00:02.000Z',
    },
  ])
  assert(
    incomplete[0]?.state === 'interrupted' &&
      incomplete[0].interruptedFrom === 'running' &&
      incomplete[0].result?.summary.includes('before terminal'),
    'running task with durable result recovers interrupted without replay',
  )

  const completed = projectDurableTaskEvents([
    {
      type: 'state',
      taskId: 'agent_completed',
      sessionId: 'task_projection_session',
      agentType: 'explore',
      state: 'admitted',
      prompt: 'completed task',
      timestamp: '2026-07-26T07:01:00.000Z',
    },
    {
      type: 'state',
      taskId: 'agent_completed',
      sessionId: 'task_projection_session',
      agentType: 'explore',
      state: 'running',
      timestamp: '2026-07-26T07:01:01.000Z',
    },
    {
      type: 'result',
      taskId: 'agent_completed',
      sessionId: 'task_projection_session',
      summary: 'durable result',
      isError: false,
      timestamp: '2026-07-26T07:01:02.000Z',
    },
    {
      type: 'state',
      taskId: 'agent_completed',
      sessionId: 'task_projection_session',
      agentType: 'explore',
      state: 'completed',
      timestamp: '2026-07-26T07:01:03.000Z',
    },
  ])
  assert(
    completed[0]?.state === 'completed' &&
      completed[0].result?.summary === 'durable result',
    'result is preserved before completed terminal',
  )

  const terminalWithoutResult = projectDurableTaskEvents([
    {
      type: 'state',
      taskId: 'agent_terminal_without_result',
      sessionId: 'task_projection_session',
      agentType: 'general',
      state: 'admitted',
      timestamp: '2026-07-26T07:02:00.000Z',
    },
    {
      type: 'state',
      taskId: 'agent_terminal_without_result',
      sessionId: 'task_projection_session',
      agentType: 'general',
      state: 'error',
      timestamp: '2026-07-26T07:02:01.000Z',
    },
  ])
  assert(
    terminalWithoutResult[0]?.state === 'interrupted' &&
      terminalWithoutResult[0].interruptedFrom === 'admitted',
    'terminal without task_result is rejected and recovers interrupted',
  )

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bolo-task-recovery-'),
  )
  try {
    const transcript = path.join(root, 'task_runtime_session.jsonl')
    const deps: QueryDeps = {
      prepareMessages: identityPrepareMessages,
      uuid: () => 'task_runtime_uuid',
      callModel: async function* (_input) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        yield { type: 'text_delta', text: 'BACKGROUND_RESULT' }
        yield { type: 'done' }
      },
    }
    const session = await createSession({
      cwd: root,
      sessionId: 'task_runtime_session',
      deps,
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      autoSave: {
        scope: 'project',
        filePath: transcript,
      },
    })
    const parentMessages = session.messages
    const backgroundStore = session.backgroundAgents
    assert(backgroundStore, 'createSession wires background store')
    const tool = createAgentTool()
    const started = await tool.call(
      {
        prompt: 'persist background result',
        description: 'durable task',
        subagent_type: 'general',
        run_in_background: true,
      },
      {
        cwd: root,
        sessionId: session.id,
        extras: {
          writeTranscript: false,
          subagentParent: {
            parentSessionId: session.id,
            parentTurnId: 'turn_parent_runtime',
            cwd: root,
            hooks: {},
            deps,
            permissionMode: 'bypassPermissions' as const,
            askPermission: async () => 'allow' as const,
            allTools: createBuiltinTools(),
            backgroundStore,
            parentMessages,
          },
        },
      },
    )
    assert(started.ok, `background task admitted: ${started.output}`)
    const taskId = Object.keys(backgroundStore.pendingAgents)[0]
    assert(taskId, 'background store exposes admitted task id')

    let loaded = await loadTranscriptFile(transcript)
    const initialStates: string[] = []
    for (const entry of loaded.entries) {
      if (entry.type === 'task' && entry.taskId === taskId) {
        initialStates.push(entry.state)
      }
    }
    assert(
      initialStates.slice(0, 2).join(',') === 'admitted,running',
      'worker starts only after admitted/running entries reach disk',
    )

    await waitFor(
      () =>
        backgroundStore.backgroundAgentResults[taskId]?.status ===
        'done',
      'background task completion',
    )
    loaded = await loadTranscriptFile(transcript)
    const lifecycle = loaded.entries.filter(
      (entry) =>
        (entry.type === 'task' || entry.type === 'task_result') &&
        entry.taskId === taskId,
    )
    assert(
      lifecycle.map((entry) => entry.type).join(',') ===
        'task,task,task_result,task',
      'task result is append-only before terminal state',
    )
    const lastLifecycle = lifecycle.at(-1)
    assert(
      lastLifecycle?.type === 'task' &&
        lastLifecycle.state === 'completed',
      'successful background worker receives completed terminal',
    )
    assert(
      parentMessages.length === 0,
      'background completion never mutates parent messages asynchronously',
    )
    assert(
      projectDurableTasks(loaded.entries).find(
        (task) => task.taskId === taskId,
      )?.result?.summary.includes('BACKGROUND_RESULT'),
      'transcript projection restores durable result',
    )

    await appendTaskEntry(transcript, {
      taskId: 'agent_crashed',
      sessionId: session.id,
      parentTurnId: 'turn_parent_crashed',
      agentType: 'general',
      state: 'admitted',
      prompt: 'crash fixture',
      isolation: 'none',
    })
    await appendTaskEntry(transcript, {
      taskId: 'agent_crashed',
      sessionId: session.id,
      agentType: 'general',
      state: 'running',
    })

    const resumed = await resumeSession({
      idOrPath: transcript,
      cwd: root,
      create: {
        deps,
        systemPrompt: false,
      },
    })
    const resumedBackgroundStore = resumed.session.backgroundAgents
    assert(
      resumedBackgroundStore,
      'resumeSession wires background diagnostic store',
    )
    const recoveredTask = resumed.session.durableTasks.find(
      (task) => task.taskId === 'agent_crashed',
    )
    assert(
      recoveredTask?.state === 'interrupted' &&
        recoveredTask.interruptedFrom === 'running',
      'resume projects unfinished background task as interrupted',
    )
    assert(
      resumedBackgroundStore.pendingAgents.agent_crashed?.status ===
        'interrupted',
      '/bg store restores interrupted diagnostic without restarting worker',
    )
    assert(
      resumedBackgroundStore.backgroundAgentResults[taskId]
        ?.status === 'done',
      '/bg store restores completed durable result',
    )
    assert(
      Object.values(
        resumedBackgroundStore.pendingAgents,
      ).every((entry) => entry.status !== 'running'),
      'resume never restores a running worker',
    )

    // 真实 submitPrompt 主路径必须把 durable turnId 透传到 task parentTurnId。
    const parentWireTranscript = path.join(
      root,
      'task_parent_wire_session.jsonl',
    )
    const parentWireDeps: QueryDeps = {
      prepareMessages: identityPrepareMessages,
      uuid: () => 'task_parent_wire_uuid',
      callModel: async function* ({ messages, tools }) {
        const hasAgent =
          tools?.some((entry) => entry.name === AGENT_TOOL_NAME) === true
        const hasToolResult = messages.some((entry) => entry.role === 'tool')
        if (hasAgent && !hasToolResult) {
          yield {
            type: 'tool_call',
            id: 'task_parent_wire_call',
            name: AGENT_TOOL_NAME,
            arguments: JSON.stringify({
              prompt: 'return durable parent wire result',
              subagent_type: 'general',
              run_in_background: true,
            }),
          }
          yield { type: 'done' }
          return
        }
        if (hasAgent) {
          yield { type: 'text_delta', text: 'parent wire complete' }
          yield { type: 'done' }
          return
        }
        yield { type: 'text_delta', text: 'child wire complete' }
        yield { type: 'done' }
      },
    }
    const parentWireSession = await createSession({
      cwd: root,
      sessionId: 'task_parent_wire_session',
      deps: parentWireDeps,
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      autoSave: {
        scope: 'project',
        filePath: parentWireTranscript,
      },
    })
    const parentWireTerminal = await submitPrompt(
      parentWireSession,
      'spawn a background child',
      { turnId: 'turn_task_parent_wire' },
    )
    assert(
      parentWireTerminal.reason === 'completed',
      'parent wire turn completes',
    )
    const parentWireStore = parentWireSession.backgroundAgents
    assert(parentWireStore, 'parent wire session has background store')
    const parentWireTaskId =
      Object.keys(parentWireStore.pendingAgents)[0] ?? ''
    assert(parentWireTaskId, 'parent wire background task admitted')
    await waitFor(
      () =>
        parentWireStore.backgroundAgentResults[parentWireTaskId]?.status ===
        'done',
      'parent wire background task completion',
    )
    const parentWireLoaded = await loadTranscriptFile(parentWireTranscript)
    const parentWireAdmission = parentWireLoaded.entries.find(
      (entry) =>
        entry.type === 'task' &&
        entry.taskId === parentWireTaskId &&
        entry.state === 'admitted',
    )
    assert(
      parentWireAdmission?.type === 'task' &&
        parentWireAdmission.parentTurnId === 'turn_task_parent_wire',
      'submitPrompt durable turnId reaches background task parentTurnId',
    )

    // result write failure 不得伪造 completed/error terminal；磁盘保持 running。
    const failingTranscript = path.join(
      root,
      'task_result_failure_session.jsonl',
    )
    const failingSession = await createSession({
      cwd: root,
      sessionId: 'task_result_failure_session',
      deps,
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      autoSave: {
        scope: 'project',
        filePath: failingTranscript,
      },
    })
    const failingStore = failingSession.backgroundAgents
    assert(failingStore, 'failure fixture has background store')
    const originalAppendFile = fs.appendFile.bind(fs)
    const writableFs = fs as typeof fs & {
      appendFile: typeof fs.appendFile
    }
    let resultFailureInjected = false
    writableFs.appendFile = (async (
      file: Parameters<typeof fs.appendFile>[0],
      data: Parameters<typeof fs.appendFile>[1],
      options?: Parameters<typeof fs.appendFile>[2],
    ) => {
      if (
        !resultFailureInjected &&
        String(file) === failingTranscript &&
        String(data).includes('"type":"task_result"')
      ) {
        resultFailureInjected = true
        throw Object.assign(new Error('injected task result failure'), {
          code: 'EIO',
        })
      }
      return await originalAppendFile(file, data, options)
    }) as typeof fs.appendFile

    let failingTaskId = ''
    try {
      const failedStart = await tool.call(
        {
          prompt: 'persist result failure',
          description: 'result failure fixture',
          subagent_type: 'general',
          run_in_background: true,
        },
        {
          cwd: root,
          sessionId: failingSession.id,
          extras: {
            writeTranscript: false,
            subagentParent: {
              parentSessionId: failingSession.id,
              parentTurnId: 'turn_parent_result_failure',
              cwd: root,
              hooks: {},
              deps,
              permissionMode: 'bypassPermissions' as const,
              askPermission: async () => 'allow' as const,
              allTools: createBuiltinTools(),
              backgroundStore: failingStore,
              parentMessages: failingSession.messages,
            },
          },
        },
      )
      assert(
        failedStart.ok,
        `result failure worker admitted: ${failedStart.output}`,
      )
      failingTaskId = Object.keys(failingStore.pendingAgents)[0] ?? ''
      assert(failingTaskId, 'result failure fixture exposes task id')
      await waitFor(
        () =>
          failingStore.backgroundAgentResults[failingTaskId]?.status ===
          'error',
        'result persistence failure becomes in-memory error',
      )
    } finally {
      writableFs.appendFile = originalAppendFile
    }

    assert(resultFailureInjected, 'task_result append failure was injected')
    const failedLoaded = await loadTranscriptFile(failingTranscript)
    const failedLifecycle = failedLoaded.entries.filter(
      (entry) =>
        (entry.type === 'task' || entry.type === 'task_result') &&
        entry.taskId === failingTaskId,
    )
    assert(
      failedLifecycle.length === 2 &&
        failedLifecycle.every(
          (entry) =>
            entry.type === 'task' &&
            (entry.state === 'admitted' || entry.state === 'running'),
        ),
      'result failure leaves only admitted/running on disk',
    )
    const failedResume = await resumeSession({
      idOrPath: failingTranscript,
      cwd: root,
      create: {
        deps,
        systemPrompt: false,
      },
    })
    assert(
      failedResume.session.durableTasks.find(
        (task) => task.taskId === failingTaskId,
      )?.state === 'interrupted',
      'result failure resumes as interrupted without replay',
    )

    // compact rewrite 必须保留 task lifecycle 与 result。
    session.messages.push(
      { role: 'user', content: 'rewrite task transcript' },
      { role: 'assistant', content: 'keep task records' },
    )
    const { rewriteTranscriptFromMessages } = await import(
      '../packages/core/src/index.ts'
    )
    await rewriteTranscriptFromMessages(transcript, session, {
      compactBoundarySummary: 'DR3A rewrite fixture',
    })
    const rewritten = await loadTranscriptFile(transcript)
    assert(
      projectDurableTasks(rewritten.entries).find(
        (task) => task.taskId === taskId,
      )?.state === 'completed' &&
        projectDurableTasks(rewritten.entries).find(
          (task) => task.taskId === 'agent_crashed',
        )?.state === 'interrupted',
      'rewrite preserves completed and interrupted task diagnostics',
    )

    console.log('PASS: test-session-task-recovery')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
