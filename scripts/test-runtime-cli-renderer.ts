/**
 * AR1C1a：runtime query pure text renderer。
 * 运行：npx tsx scripts/test-runtime-cli-renderer.ts
 */
import assert from 'node:assert/strict'

import {
  renderRuntimeText,
  type RuntimeTextPage,
} from '../packages/core/src/runtimeTextView.ts'
import type {
  RuntimeListItem,
  RuntimeListView,
  RuntimeInspectView,
} from '../packages/shared/src/runtimeQuery.ts'
import type {
  RuntimeControlView,
  RuntimeTaskView,
  RuntimeTurnView,
} from '../packages/shared/src/runtimeProtocol.ts'

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g
const FIXTURE_TIME = '2026-07-26T12:00:00.000Z'
const visibleWidth = (line: string): number =>
  line.replace(ANSI_PATTERN, '').length

function turn(
  id: string,
  state: RuntimeTurnView['state'] = 'completed',
): RuntimeListItem {
  const record: RuntimeTurnView = {
    turnId: id,
    state,
    updatedAt: FIXTURE_TIME,
    terminalReason: state === 'completed' ? 'completed' : undefined,
  }
  return {
    entity: 'turn',
    entityId: id,
    record,
    availableActions: [],
  }
}

function control(id: string): RuntimeListItem {
  const record: RuntimeControlView = {
    controlId: id,
    sessionId: 'runtime_renderer_session',
    kind: 'queue',
    state: 'ready',
    requestedAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    prompt: `prompt for ${id}`,
  }
  return {
    entity: 'control',
    entityId: id,
    record,
    availableActions: [],
  }
}

function task(id: string): RuntimeListItem {
  const record: RuntimeTaskView = {
    taskId: id,
    sessionId: 'runtime_renderer_session',
    agentType: 'explore',
    state: 'completed',
    admittedAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  }
  return {
    entity: 'task',
    entityId: id,
    record,
    availableActions: [],
  }
}

function listView(items: RuntimeListItem[]): RuntimeListView {
  return {
    protocolVersion: 1,
    kind: 'runtime.list',
    generatedAt: FIXTURE_TIME,
    sessionId: 'runtime_renderer_session',
    phase: 'idle',
    runner: { state: 'idle' },
    entity: 'all',
    items,
  }
}

function assertPageShape(page: RuntimeTextPage): void {
  assert(page.page >= 0)
  assert(page.page < page.pageCount)
  assert.equal(page.hasPrevious, page.page > 0)
  assert.equal(page.hasNext, page.page + 1 < page.pageCount)
}

const emptyInput = listView([])
const emptyBefore = structuredClone(emptyInput)
const empty = renderRuntimeText(emptyInput, {
  columns: 80,
  page: 0,
  pageSize: 5,
  color: false,
})
assertPageShape(empty)
assert.equal(empty.totalItems, 0)
assert.equal(empty.page, 0)
assert.equal(empty.pageCount, 1)
assert.match(empty.text, /no runtime entities/i)
assert.equal(empty.text.includes('\u001b['), false)
assert.deepEqual(emptyInput, emptyBefore)

const oneInput = listView([turn('turn_one')])
const one = renderRuntimeText(oneInput, {
  columns: 80,
  page: 0,
  pageSize: 5,
  color: false,
})
assertPageShape(one)
assert.equal(one.totalItems, 1)
assert.equal(one.pageCount, 1)
assert.match(one.text, /turn_one/)
assert.doesNotMatch(one.text, /page 1\/1/i)

const manyInput = listView([
  turn('turn_1'),
  control('control_2'),
  task('task_3'),
  turn('turn_4'),
  control('control_5'),
  task('task_6'),
  turn('turn_7'),
])
const manyBefore = structuredClone(manyInput)
const middle = renderRuntimeText(manyInput, {
  columns: 80,
  page: 1,
  pageSize: 3,
  color: false,
})
assertPageShape(middle)
assert.equal(middle.page, 1)
assert.equal(middle.pageCount, 3)
assert.equal(middle.totalItems, 7)
assert.match(middle.text, /turn_4/)
assert.match(middle.text, /control_5/)
assert.match(middle.text, /task_6/)
assert.doesNotMatch(middle.text, /turn_1/)
assert.doesNotMatch(middle.text, /turn_7/)
assert.match(middle.text, /page 2\/3/i)

const clamped = renderRuntimeText(manyInput, {
  columns: 80,
  page: 99,
  pageSize: 3,
  color: false,
})
assertPageShape(clamped)
assert.equal(clamped.page, 2)
assert.match(clamped.text, /turn_7/)

const filtered = renderRuntimeText(manyInput, {
  columns: 80,
  pageSize: 10,
  filter: 'control',
  color: false,
})
assertPageShape(filtered)
assert.equal(filtered.totalItems, 2)
assert.match(filtered.text, /control_2/)
assert.match(filtered.text, /control_5/)
assert.doesNotMatch(filtered.text, /turn_1/)
assert.doesNotMatch(filtered.text, /task_3/)
assert.deepEqual(manyInput, manyBefore, 'renderer never mutates list input')

const narrowInput = listView([
  control(
    'control_with_an_intentionally_very_long_identifier_for_narrow_terminals',
  ),
])
const narrow = renderRuntimeText(narrowInput, {
  columns: 36,
  pageSize: 10,
  color: false,
})
assert(
  narrow.text.split('\n').every((line) => visibleWidth(line) <= 36),
  narrow.text,
)
assert.match(narrow.text, /…/)

const colored = renderRuntimeText(oneInput, {
  columns: 80,
  pageSize: 5,
  color: true,
})
assert.match(colored.text, /\u001b\[/)
assert(
  colored.text.split('\n').every((line) => visibleWidth(line) <= 80),
)
const noColor = renderRuntimeText(oneInput, {
  columns: 80,
  pageSize: 5,
  color: false,
})
assert.equal(
  noColor.text.includes('\u001b['),
  false,
  'NO_COLOR/plain consumers receive no ANSI',
)

const inspectInput: RuntimeInspectView = {
  protocolVersion: 1,
  kind: 'runtime.inspect',
  generatedAt: FIXTURE_TIME,
  sessionId: 'runtime_renderer_session',
  entity: 'control',
  item: control(
    'control_inspect_with_a_long_identifier_and_long_prompt_payload',
  ),
}
const inspectBefore = structuredClone(inspectInput)
const inspect = renderRuntimeText(inspectInput, {
  columns: 42,
  page: 0,
  pageSize: 4,
  color: false,
})
assertPageShape(inspect)
assert(inspect.pageCount > 1, 'inspect JSON body is pageable')
assert(
  inspect.text.split('\n').every((line) => visibleWidth(line) <= 42),
  inspect.text,
)
assert.deepEqual(
  inspectInput,
  inspectBefore,
  'renderer never mutates inspect input',
)

console.log('PASS: test-runtime-cli-renderer')
