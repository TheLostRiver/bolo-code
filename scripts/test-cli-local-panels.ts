/**
 * OI-11E: embedded pickers repaint only rows they own.
 */
import {
  buildDiffViewModelFromPreview,
} from '../packages/core/src/index.ts'
import { runArrowPicker } from '../packages/cli/src/tui/arrowPicker.ts'
import {
  runDiffApprovePane,
  runDiffPane,
} from '../packages/cli/src/tui/diffPane.ts'
import { runQuestionPicker } from '../packages/cli/src/tui/questionPicker.ts'
import type { AskQuestion } from '../packages/shared/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function assertLocalPanel(name: string, output: string): void {
  assert(!output.includes('\u001b[2J'), `${name} never clears the full screen`)
  assert(!output.includes('\u001b[H'), `${name} never homes the global cursor`)
  assert(output.includes('\u001b[2K'), `${name} erases only owned rows`)
}

async function main(): Promise<void> {
  const arrowOut = ['HISTORY\n']
  const arrowKeys = ['down', 'enter']
  const arrow = await runArrowPicker({
    items: [
      { id: 'first', label: 'First' },
      { id: 'second', label: 'Second' },
    ],
    isTty: true,
    readKey: async () => arrowKeys.shift() ?? 'q',
    writeOut: (text) => arrowOut.push(text),
  })
  assert(arrow.ok && arrow.id === 'second', 'arrow picker result is unchanged')
  assertLocalPanel('arrow picker', arrowOut.join(''))

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

  const diffOut = ['HISTORY\n']
  const diffKeys = ['down', 'q']
  const diff = await runDiffPane({
    model: diffModel,
    isTty: true,
    readKey: async () => diffKeys.shift() ?? 'q',
    writeOut: (text) => diffOut.push(text),
    rows: 16,
    cols: 60,
  })
  assert(diff.ok, 'diff browser still exits normally')
  assertLocalPanel('diff browser', diffOut.join(''))

  const approveOut = ['HISTORY\n']
  const approve = await runDiffApprovePane({
    model: diffModel,
    toolName: 'Edit',
    isTty: true,
    readKey: async () => 'y',
    writeOut: (text) => approveOut.push(text),
    rows: 16,
    cols: 60,
  })
  assert(
    approve.ok && approve.decision === 'allow',
    'diff approval result is unchanged',
  )
  assertLocalPanel('diff approval', approveOut.join(''))

  const question: AskQuestion = {
    header: 'Database',
    question: 'Which database?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  }
  const questionOut = ['HISTORY\n']
  const questionKeys = ['down', 'enter']
  const answer = await runQuestionPicker({
    questions: [question],
    isTty: true,
    readKey: async () => questionKeys.shift() ?? 'esc',
    writeOut: (text) => questionOut.push(text),
  })
  assert(
    answer.kind === 'answered' &&
      answer.selections[0]?.selected[0] === 'SQLite',
    'question picker result is unchanged',
  )
  assertLocalPanel('question picker', questionOut.join(''))

  console.log('PASS: CLI local panels preserve history')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
