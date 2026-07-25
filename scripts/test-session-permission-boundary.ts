/**
 * DR2B3a/b：permission/diff ask 退出边界与 control 竞态。
 * 运行：npx tsx scripts/test-session-permission-boundary.ts
 */
import {
  SessionCoordinator,
  createSession,
  submitPrompt,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'
import { buildTool } from '../packages/tools/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
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

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 1_000,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT: ${message}`)), timeoutMs),
    ),
  ])
}

class RecordingCoordinator extends SessionCoordinator {
  readonly boundaries: string[] = []

  override promoteControls(
    input: Parameters<SessionCoordinator['promoteControls']>[0],
  ): ReturnType<SessionCoordinator['promoteControls']> {
    this.boundaries.push(input.boundary)
    return super.promoteControls(input)
  }
}

function writeTool(onCall: () => void) {
  return buildTool({
    name: 'Write',
    description: 'permission-boundary test tool',
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async call() {
      onCall()
      return { ok: true, output: 'write fixture completed' }
    },
  })
}

function writeProvider(id: string, inputs: ChatMessage[][]): LlmProvider {
  let calls = 0
  return {
    id,
    async *completeStream(messages) {
      calls += 1
      inputs.push(messages.map((message) => ({ ...message })))
      if (calls === 1) {
        yield {
          type: 'tool_call',
          id: `${id}_call`,
          name: 'Write',
          arguments: JSON.stringify({
            path: 'permission-boundary.txt',
            content: 'candidate\n',
          }),
        }
      } else {
        yield { type: 'text_delta', text: 'done after approval' }
      }
      yield { type: 'done' }
    },
  }
}

async function main() {
  // ask 挂起时 coordinator interrupt：core 必须主动按 deny 收口，不能依赖 UI。
  const interruptCoordinator = new RecordingCoordinator()
  const interruptInputs: ChatMessage[][] = []
  let interruptAskStarted = false
  let interruptSawDiff = false
  let interruptedToolCalls = 0
  const interruptSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'permission_interrupt_session',
    coordinator: interruptCoordinator,
    provider: writeProvider('permission-interrupt', interruptInputs),
    permissionMode: 'default',
    systemPrompt: false,
    askPermission: async (request) => {
      interruptAskStarted = true
      interruptSawDiff = Boolean(request.preview?.files?.length)
      return await new Promise<'allow'>(() => undefined)
    },
  })
  interruptSession.tools = [writeTool(() => (interruptedToolCalls += 1))]
  const interrupted = submitPrompt(interruptSession, 'write after asking', {
    turnId: 'turn_permission_interrupt',
  })
  await waitUntil(() => interruptAskStarted, 'permission ask starts')
  const interrupt = interruptCoordinator.requestControl({
    controlId: 'ctrl_permission_interrupt',
    kind: 'interrupt',
    sessionId: interruptSession.id,
    expectedTurnId: 'turn_permission_interrupt',
  })
  assert(interrupt.ok, 'interrupt during permission ask is accepted')
  const interruptedTerminal = await withTimeout(
    interrupted,
    'interrupt settles pending permission ask',
  )
  assert(
    interruptedTerminal.reason === 'aborted',
    'interrupt during ask produces aborted terminal',
  )
  assert(interruptSawDiff, 'Write permission request includes diff preview')
  assert(interruptedToolCalls === 0, 'interrupted permission never executes tool')
  assert(
    interruptCoordinator.boundaries.includes('after_permission'),
    'cancelled permission exits through after_permission boundary',
  )
  assert(
    interruptCoordinator.boundaries.includes('after_diff_approval'),
    'cancelled diff approval exits through after_diff_approval boundary',
  )
  assert(
    interruptCoordinator.snapshot(interruptSession.id).state === 'idle',
    'ask-interrupted runner releases ownership',
  )

  // ask 返回前收到 steer：permission/diff boundary 只观察，不能拆 tool pairing。
  const steerCoordinator = new RecordingCoordinator()
  const steerInputs: ChatMessage[][] = []
  const approval = deferred<'allow'>()
  let steerAskStarted = false
  let steeredToolCalls = 0
  const steerSession = await createSession({
    cwd: process.cwd(),
    sessionId: 'permission_steer_session',
    coordinator: steerCoordinator,
    provider: writeProvider('permission-steer', steerInputs),
    permissionMode: 'default',
    systemPrompt: false,
    askPermission: async () => {
      steerAskStarted = true
      return await approval.promise
    },
  })
  steerSession.tools = [writeTool(() => (steeredToolCalls += 1))]
  const steered = submitPrompt(steerSession, 'write after steering', {
    turnId: 'turn_permission_steer',
  })
  await waitUntil(() => steerAskStarted, 'steer fixture permission ask starts')
  const steer = steerCoordinator.requestControl({
    controlId: 'ctrl_permission_steer',
    kind: 'steer',
    sessionId: steerSession.id,
    expectedTurnId: 'turn_permission_steer',
    prompt: 'steer after approval',
  })
  assert(steer.ok, 'steer during permission ask is accepted')
  assert(
    !steerSession.messages.some(
      (message) =>
        message.role === 'user' && message.content === 'steer after approval',
    ),
    'steer is not inserted while approval is pending',
  )
  approval.resolve('allow')
  assert(
    (await withTimeout(steered, 'approved tool turn completes')).reason ===
      'completed',
    'approved steered turn completes',
  )
  assert(steeredToolCalls === 1, 'approved tool executes exactly once')
  const secondInput = steerInputs[1] ?? []
  const assistantIndex = secondInput.findIndex(
    (message) =>
      message.role === 'assistant' &&
      message.tool_calls?.some(
        (call) => call.id === 'permission-steer_call',
      ),
  )
  const toolIndex = secondInput.findIndex(
    (message) =>
      message.role === 'tool' &&
      message.tool_call_id === 'permission-steer_call',
  )
  const steerIndex = secondInput.findIndex(
    (message) =>
      message.role === 'user' && message.content === 'steer after approval',
  )
  assert(
    assistantIndex >= 0 && toolIndex > assistantIndex && steerIndex > toolIndex,
    'ask-time steer is inserted only after assistant/tool pairing closes',
  )
  assert(
    steerCoordinator.boundaries.includes('after_permission') &&
      steerCoordinator.boundaries.includes('after_diff_approval'),
    'approved diff visits both explicit ask exit boundaries',
  )
  assert(
    steerCoordinator
      .snapshot(steerSession.id)
      .controls.find(
        (control) => control.controlId === 'ctrl_permission_steer',
      )?.boundary === 'after_tools',
    'ask-time steer promotes only at after_tools',
  )

  console.log('PASS: test-session-permission-boundary')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
