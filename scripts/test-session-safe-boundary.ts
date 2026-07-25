/**
 * DR2B2：control intents 接入 queryLoop safe boundaries。
 * 运行：npx tsx scripts/test-session-safe-boundary.ts
 */
import {
  SessionCoordinator,
  createSession,
  submitPrompt,
  type SessionEvent,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'
import { buildTool } from '../packages/tools/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`TIMEOUT: ${message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function userTexts(messages: readonly ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
}

async function main() {
  // Final assistant 后、Stop 前收到 steer：同一 durable turn 继续下一次 provider。
  const stopCoordinator = new SessionCoordinator()
  const firstProviderGate = deferred()
  let stopProviderCalls = 0
  const stopProviderInputs: ChatMessage[][] = []
  const stopEvents: SessionEvent[] = []
  const stopProvider: LlmProvider = {
    id: 'safe-boundary-stop',
    async *completeStream(messages) {
      stopProviderCalls += 1
      stopProviderInputs.push(messages.map((message) => ({ ...message })))
      if (stopProviderCalls === 1) {
        await firstProviderGate.promise
        yield { type: 'text_delta', text: 'first answer' }
      } else {
        yield { type: 'text_delta', text: 'steered answer' }
      }
      yield { type: 'done' }
    },
  }
  const stopSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'safe_boundary_stop',
    coordinator: stopCoordinator,
    provider: stopProvider,
    systemPrompt: false,
    onEvent: (event) => stopEvents.push(event),
  })
  const stopPending = submitPrompt(stopSession, 'initial prompt', {
    turnId: 'turn_safe_stop',
  })
  await waitUntil(() => stopProviderCalls === 1, 'first provider starts')
  const stopSteer = stopCoordinator.requestControl({
    controlId: 'ctrl_safe_stop',
    kind: 'steer',
    sessionId: stopSession.id,
    expectedTurnId: 'turn_safe_stop',
    prompt: 'steer before stop',
  })
  assert(stopSteer.ok, 'steer during provider is accepted')
  firstProviderGate.resolve()
  assert((await stopPending).reason === 'completed', 'steered turn completes')
  assert(stopProviderCalls === 2, 'before-stop steer causes next provider call')
  assert(
    userTexts(stopProviderInputs[1] ?? []).join('|') ===
      'initial prompt|steer before stop',
    'second provider sees original and steered user input',
  )
  const stopControl = stopCoordinator
    .snapshot(stopSession.id)
    .controls.find((control) => control.controlId === 'ctrl_safe_stop')
  assert(stopControl?.state === 'promoted', 'stop steer is promoted')
  assert(
    stopControl.boundary === 'before_stop',
    'final-answer steer promotes at before_stop',
  )
  assert(
    stopEvents.some(
      (event) =>
        event.type === 'control' &&
        event.kind === 'steer' &&
        event.boundary === 'before_stop',
    ),
    'session emits structured steer promotion event',
  )

  // Tool 正在运行时收到 steer：必须晚于完整 tool result，不能拆开 pairing。
  const toolCoordinator = new SessionCoordinator()
  const toolGate = deferred()
  let toolStarted = false
  let toolProviderCalls = 0
  const toolProviderInputs: ChatMessage[][] = []
  const boundaryTool = buildTool({
    name: 'BoundaryTool',
    description: 'blocks until test releases it',
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    inputJSONSchema: { type: 'object', properties: {} },
    async call() {
      toolStarted = true
      await toolGate.promise
      return { ok: true, output: 'tool boundary result' }
    },
  })
  const toolProvider: LlmProvider = {
    id: 'safe-boundary-tool',
    async *completeStream(messages) {
      toolProviderCalls += 1
      toolProviderInputs.push(messages.map((message) => ({ ...message })))
      if (toolProviderCalls === 1) {
        yield {
          type: 'tool_call',
          id: 'call_boundary',
          name: 'BoundaryTool',
          arguments: '{}',
        }
      } else {
        yield { type: 'text_delta', text: 'after tool steer' }
      }
      yield { type: 'done' }
    },
  }
  const toolSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'safe_boundary_tool',
    coordinator: toolCoordinator,
    provider: toolProvider,
    permissionMode: 'bypassPermissions',
    systemPrompt: false,
  })
  toolSession.tools = [boundaryTool]
  const toolPending = submitPrompt(toolSession, 'use boundary tool', {
    turnId: 'turn_safe_tool',
  })
  await waitUntil(() => toolStarted, 'tool starts')
  const toolSteer = toolCoordinator.requestControl({
    controlId: 'ctrl_safe_tool',
    kind: 'steer',
    sessionId: toolSession.id,
    expectedTurnId: 'turn_safe_tool',
    prompt: 'steer after tool',
  })
  assert(toolSteer.ok, 'steer during tool is accepted')
  assert(
    !toolSession.messages.some(
      (message) =>
        message.role === 'user' && message.content === 'steer after tool',
    ),
    'steer does not enter messages while tool is running',
  )
  toolGate.resolve()
  assert((await toolPending).reason === 'completed', 'tool-steered turn completes')
  assert(toolProviderCalls === 2, 'tool steer reaches next provider call')
  const secondToolInput = toolProviderInputs[1] ?? []
  const assistantIndex = secondToolInput.findIndex(
    (message) =>
      message.role === 'assistant' &&
      message.tool_calls?.some((call) => call.id === 'call_boundary'),
  )
  const toolResultIndex = secondToolInput.findIndex(
    (message) =>
      message.role === 'tool' && message.tool_call_id === 'call_boundary',
  )
  const steerIndex = secondToolInput.findIndex(
    (message) =>
      message.role === 'user' && message.content === 'steer after tool',
  )
  assert(
    assistantIndex >= 0 &&
      toolResultIndex > assistantIndex &&
      steerIndex > toolResultIndex,
    'steer is inserted only after assistant/tool pairing closes',
  )
  assert(
    toolCoordinator
      .snapshot(toolSession.id)
      .controls.find((control) => control.controlId === 'ctrl_safe_tool')
      ?.boundary === 'after_tools',
    'tool steer promotes at after_tools',
  )

  // Coordinator interrupt signal 必须并入真实 submitPrompt abort 链。
  const interruptCoordinator = new SessionCoordinator()
  let interruptProviderCalls = 0
  const interruptProvider: LlmProvider = {
    id: 'safe-boundary-interrupt',
    async *completeStream(_messages, options) {
      interruptProviderCalls += 1
      await Promise.race([
        new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve()
          options?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          })
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ])
      if (!options?.signal?.aborted) {
        throw new Error('coordinator interrupt signal was not linked')
      }
      throw Object.assign(new Error('interrupted by coordinator'), {
        name: 'AbortError',
      })
    },
  }
  const interruptSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'safe_boundary_interrupt',
    coordinator: interruptCoordinator,
    provider: interruptProvider,
    systemPrompt: false,
  })
  const interruptPending = submitPrompt(interruptSession, 'wait for interrupt', {
    turnId: 'turn_safe_interrupt',
  })
  await waitUntil(
    () => interruptProviderCalls === 1,
    'interrupt provider starts',
  )
  const interrupt = interruptCoordinator.requestControl({
    controlId: 'ctrl_safe_interrupt',
    kind: 'interrupt',
    sessionId: interruptSession.id,
    expectedTurnId: 'turn_safe_interrupt',
  })
  assert(interrupt.ok, 'interrupt control is accepted')
  assert(
    (await interruptPending).reason === 'aborted',
    'coordinator interrupt aborts real turn',
  )
  assert(
    interruptCoordinator.snapshot(interruptSession.id).state === 'idle',
    'interrupted runner releases ownership',
  )

  console.log('PASS: test-session-safe-boundary')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
