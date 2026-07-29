/**
 * H1: shared overlay views remain pure text and never own terminal repainting.
 */
import {
  buildDiffViewModelFromPreview,
  formatDiffViewScreen,
} from '../packages/core/src/index.ts'
import {
  applyArrowPickerKey,
  formatArrowPickerScreen,
} from '../packages/cli/src/tui/arrowPicker.ts'
import {
  applyPermissionPanelKey,
  formatPermissionPanelScreen,
} from '../packages/cli/src/tui/permissionPanel.ts'
import {
  applyQuestionPickerKey,
  createQuestionPickerState,
  formatQuestionPickerScreen,
} from '../packages/cli/src/tui/questionPicker.ts'
import type { AskQuestion } from '../packages/shared/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function assertPureView(name: string, output: string): void {
  const ownershipControls = [
    '\u001b[2J',
    '\u001b[H',
    '\u001b[2K',
    '\u001b[?25l',
    '\u001b[?25h',
  ]
  for (const control of ownershipControls) {
    assert(!output.includes(control), `${name} omits ${JSON.stringify(control)}`)
  }
  assert(
    !/\u001b\[\d+[ABCD]/u.test(output),
    `${name} does not move the global cursor`,
  )
}

async function main(): Promise<void> {
  const items = [
    { id: 'first', label: 'First' },
    { id: 'second', label: 'Second' },
  ]
  const arrow = applyArrowPickerKey(0, items.length, 'down')
  assert(arrow.index === 1, 'arrow reducer still selects the next item')
  assertPureView(
    'arrow picker view',
    formatArrowPickerScreen(items, arrow.index),
  )

  const diffModel = buildDiffViewModelFromPreview({
    tool: 'Edit',
    files: [
      {
        path: 'src/example.ts',
        op: 'update',
        added: 1,
        removed: 1,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-old', '+new'],
          },
        ],
      },
    ],
  })
  assertPureView(
    'diff view',
    formatDiffViewScreen(diffModel, { rows: 16, cols: 60 }),
  )

  const permissionRequest = {
    toolName: 'Bash',
    toolInput: { command: 'npm.cmd test' },
    toolUseId: 'bash_1',
    cwd: process.cwd(),
  }
  const permission = applyPermissionPanelKey(2, 'up')
  assert(permission.index === 1, 'permission reducer still moves selection')
  assertPureView(
    'permission view',
    formatPermissionPanelScreen(permissionRequest, permission.index, {
      columns: 72,
      color: false,
    }),
  )

  const questions: AskQuestion[] = [
    {
      header: 'Database',
      question: 'Which database?',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    },
  ]
  const question = applyQuestionPickerKey(
    createQuestionPickerState(questions),
    'down',
  )
  assert(question.state.cursor === 1, 'question reducer still moves selection')
  assertPureView(
    'question view',
    formatQuestionPickerScreen(question.state),
  )

  console.log('PASS: shared TUI views have no terminal ownership controls')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
