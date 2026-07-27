/**
 * OI-11C: reasoning segments own their timers and leave durable completion rows.
 */
import {
  createSessionEventPrinter,
  createTurnActivityIndicator,
  runOnePrompt,
} from '../packages/cli/src/index.ts'
import { createSession } from '../packages/core/src/index.ts'
import type { LlmProvider } from '../packages/providers/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

async function main(): Promise<void> {
  const boundaryEvents: Array<{ type: string }> = []
  const boundaryProvider: LlmProvider = {
    id: 'reasoning-boundary',
    async *completeStream() {
      yield { type: 'reasoning_delta', text: 'inspect' }
      yield { type: 'reasoning_end' }
      yield { type: 'text_delta', text: 'answer' }
      yield { type: 'done' }
    },
  }
  const boundarySession = await createSession({
    cwd: process.cwd(),
    provider: boundaryProvider,
    systemPrompt: false,
    askPermission: async () => 'deny',
    onEvent: (event) => boundaryEvents.push(event),
  })
  await runOnePrompt(boundarySession, 'preserve the segment boundary', {
    writeOut: () => {},
    writeErr: () => {},
  })
  assert(
    boundaryEvents.some((event) => event.type === 'reasoning_end'),
    'core preserves provider reasoning_end for UI consumers',
  )

  let nowMs = 0
  const frames: string[] = []
  const activity = createTurnActivityIndicator({
    writeOut: () => {},
    color: false,
    now: () => nowMs,
    intervalMs: 60_000,
    renderFrame: (line) => {
      frames.push(line)
      return true
    },
    clearFrame: () => true,
  })
  activity.start('Thinking')
  nowMs = 1_200
  activity.beforeEvent({ type: 'reasoning' })
  activity.afterEvent({ type: 'reasoning' })
  assert(activity.isActive(), 'reasoning chunks keep the animated activity live')
  assert(
    frames.at(-1)?.includes('1.2s'),
    'reasoning animation keeps the current segment elapsed time',
  )
  assert(
    frames.length >= 2 && frames[0]?.[0] !== frames[1]?.[0],
    'reasoning activity advances the animation frame',
  )
  nowMs = 4_200
  assert(
    activity.finishThinkingSegment() === 4_200,
    'first thinking segment reports its own duration',
  )
  assert(!activity.isActive(), 'completed thinking segment leaves no live row')

  nowMs = 5_000
  activity.afterEvent({ type: 'tool_start', name: 'Read' })
  nowMs = 7_000
  activity.beforeEvent({ type: 'tool_end', name: 'Read' })
  activity.afterEvent({ type: 'tool_end', name: 'Read' })
  nowMs = 11_200
  assert(
    activity.finishThinkingSegment() === 4_200,
    'thinking after a tool starts a fresh segment clock',
  )
  activity.finish('completed')

  nowMs = 0
  const timeline: string[] = []
  const timelineActivity = createTurnActivityIndicator({
    writeOut: (text) => timeline.push(text),
    color: false,
    now: () => nowMs,
    intervalMs: 60_000,
    renderFrame: () => true,
    clearFrame: () => true,
  })
  const printer = createSessionEventPrinter({
    writeOut: (text) => timeline.push(text),
    writeErr: (text) => timeline.push(text),
    color: false,
    timeline: true,
    activity: timelineActivity,
  })
  printer.beginTurn({ prompt: 'two thought segments', activity: true })
  nowMs = 1_200
  printer.onEvent({ type: 'reasoning', text: 'first thought' })
  nowMs = 4_200
  printer.onEvent({ type: 'reasoning_end' })
  nowMs = 5_000
  printer.onEvent({ type: 'tool_start', id: 'tool_1', name: 'Read' })
  nowMs = 7_000
  printer.onEvent({
    type: 'tool_end',
    id: 'tool_1',
    name: 'Read',
    ok: true,
  })
  nowMs = 8_000
  printer.onEvent({ type: 'reasoning', text: 'second thought' })
  nowMs = 11_200
  printer.onEvent({ type: 'reasoning_end' })
  printer.onEvent({ type: 'text', text: 'final answer' })
  printer.endTurn({ terminalReason: 'completed' })

  const rendered = timeline.join('')
  const completions = rendered.match(/Thought for 4\.2s/g) ?? []
  assert(completions.length === 2, 'each thought keeps its own completion row')
  assert(
    !rendered.includes('Done ·'),
    'timeline no longer labels total turn time as thinking time',
  )
  assert(
    rendered.indexOf('first thought') < rendered.indexOf('Thought for 4.2s') &&
      rendered.indexOf('Thought for 4.2s') < rendered.indexOf('second thought'),
    'completion rows stay attached to their reasoning segments',
  )

  console.log('PASS: CLI thinking segments')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
