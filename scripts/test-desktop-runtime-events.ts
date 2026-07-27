/**
 * OI-06F3: packages-first runtime event projection and Desktop wiring.
 *
 * The renderer must not reinterpret safe-boundary state or forward raw control
 * prompts. Core projects the two closeout-critical events into a small display
 * contract; Electron only routes and renders that contract.
 *
 * Run: npm run test:desktop-runtime-events
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { projectSessionRuntimeEventView } from '../packages/core/src/sessionRuntimeEventView.ts'

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

async function main() {
  const progressInput = {
    type: 'tool_progress',
    id: 'tool-1',
    name: '  Bash  ',
    message: '  downloading\n  40%  ',
  }
  const progress = projectSessionRuntimeEventView(progressInput)
  assert.deepEqual(progress, {
    type: 'tool_progress',
    id: 'tool-1',
    state: 'running',
    text: '→ Bash · downloading 40%',
  })
  assert.deepEqual(
    progressInput,
    {
      type: 'tool_progress',
      id: 'tool-1',
      name: '  Bash  ',
      message: '  downloading\n  40%  ',
    },
    'projection does not mutate core events',
  )

  const controlInput = {
    type: 'control',
    kind: 'steer',
    controlId: 'control-1',
    boundary: 'after_tools',
    prompt: '  focus on\n tests  ',
  }
  const control = projectSessionRuntimeEventView(controlInput)
  assert.deepEqual(control, {
    type: 'control',
    controlId: 'control-1',
    kind: 'steer',
    state: 'applied',
    text: '↪ Steer applied after tool execution · focus on tests',
  })
  assert.equal(
    Object.prototype.hasOwnProperty.call(control, 'prompt'),
    false,
    'raw steer prompt is not part of the renderer contract',
  )

  assert.equal(
    projectSessionRuntimeEventView({ type: 'text', text: 'hello' }),
    null,
    'unrelated SessionEvent types remain on their existing compatibility path',
  )
  assert.equal(
    projectSessionRuntimeEventView({
      type: 'tool_progress',
      id: '',
      name: 'Bash',
      message: 'working',
    }),
    null,
    'invalid critical events fail closed',
  )
  assert.equal(
    projectSessionRuntimeEventView({
      type: 'control',
      kind: 'steer',
      controlId: 'control-2',
      boundary: 'invented_boundary',
      prompt: 'do not guess',
    }),
    null,
    'unknown safe boundaries are not guessed in the renderer',
  )

  const [mainSource, rendererSource] = await Promise.all([
    fs.readFile(
      path.join('apps', 'desktop', 'src', 'main', 'index.ts'),
      'utf8',
    ),
    fs.readFile(
      path.join('apps', 'desktop', 'src', 'renderer', 'app.js'),
      'utf8',
    ),
  ])

  assert(
    mainSource.includes('projectSessionRuntimeEventView'),
    'Desktop main consumes the packages-first event projector',
  )
  assert(
    mainSource.includes('function forwardDesktopSessionEvent'),
    'Desktop main has one shared forwarding boundary',
  )
  assert.equal(
    count(mainSource, 'forwardDesktopSessionEvent(event, ownsSession)'),
    2,
    'new and resumed sessions share the same projection path',
  )
  assert(
    mainSource.includes(
      "event.type === 'control' || event.type === 'tool_progress'",
    ),
    'invalid critical events are dropped instead of falling back to raw IPC',
  )

  assert(
    rendererSource.includes('const toolRuntimeRows = new Map()'),
    'renderer tracks one live row per tool',
  )
  assert(
    rendererSource.includes("e.type === 'tool_progress'"),
    'renderer presents tool progress',
  )
  assert(
    rendererSource.includes("e.type === 'control'"),
    'renderer presents applied steer controls',
  )
  assert(
    rendererSource.includes('row.textContent = e.text'),
    'renderer displays packages-projected text without recomputing it',
  )
  assert(
    rendererSource.includes('toolRuntimeRows.delete(e.id)'),
    'completed tools release their live-row identity',
  )
  assert(
    count(rendererSource, 'toolRuntimeRows.clear()') >= 2,
    'both timeline and compatibility reloads clear detached live rows',
  )

  console.log('PASS: Desktop runtime event projection and wiring')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
