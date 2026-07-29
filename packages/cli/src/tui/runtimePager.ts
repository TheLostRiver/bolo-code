/** Retained runtime TTY pager backed by the shared pager reducer. */

import {
  renderRuntimeText,
  type RuntimeTextRenderOptions,
} from '../../../core/src/runtimeTextView.ts'
import type { RuntimeQueryView } from '../../../shared/src/runtimeQuery.ts'
import {
  applyRuntimePagerKey,
  parseRuntimePagerKey,
  type RuntimePagerDoneReason,
  type RuntimePagerKey,
  type RuntimePagerSuccess,
} from '../../../shared/src/runtimePager.ts'
import type {
  BoloTerminalInput,
  BoloTerminalOutput,
} from './boloTerminalAdapter.ts'
import { runWithAsyncCleanup } from '../cleanup.ts'
import { createRetainedTuiController } from './retainedTui.ts'

export { applyRuntimePagerKey, parseRuntimePagerKey }
export type { RuntimePagerDoneReason, RuntimePagerKey }

export type RuntimePagerResult =
  | RuntimePagerSuccess
  | {
      ok: false
      reason: 'unsupported'
      message: string
    }

export async function runRetainedRuntimePager(options: {
  view: RuntimeQueryView
  columns?: number
  rows?: number
  pageSize?: number
  color?: boolean
  filter?: RuntimeTextRenderOptions['filter']
  isTty?: boolean
  input?: BoloTerminalInput
  output?: BoloTerminalOutput
  writeOut?: (text: string) => void
  signal?: AbortSignal
  onInterrupt?: () => void
}): Promise<RuntimePagerResult> {
  const writeOut =
    options.writeOut ?? ((text: string) => process.stdout.write(text))
  const output = options.output ?? process.stdout
  const input = options.input ?? process.stdin
  const isTty =
    options.isTty ??
    (input.isTTY === true && process.stdout.isTTY === true)
  const columns =
    options.columns ??
    (typeof output.columns === 'number' ? output.columns : 80)
  const rows =
    options.rows ??
    (typeof output.rows === 'number' ? output.rows : 24)
  const pageSize =
    options.pageSize ?? Math.max(1, Math.floor(rows) - 6)
  const initial = renderRuntimeText(options.view, {
    columns,
    page: 0,
    pageSize,
    color: options.color,
    filter: options.filter,
  })

  if (initial.pageCount <= 1) {
    writeOut(`${initial.text}\n`)
    return {
      ok: true,
      reason: 'single-page',
      page: initial.page,
      pageCount: initial.pageCount,
    }
  }
  if (!isTty) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'runtime pager requires TTY for a multi-page view',
    }
  }
  if (options.signal?.aborted) {
    return {
      ok: true,
      reason: 'interrupt',
      page: initial.page,
      pageCount: initial.pageCount,
    }
  }

  const controller = createRetainedTuiController({
    writeOut,
    input,
    output,
    fallbackColumns: columns,
    fallbackRows: rows,
    color: options.color,
    rootVisible: false,
  })
  return runWithAsyncCleanup(
    async () => {
      await controller.start()
      return controller.runPagerOverlay({
        view: options.view,
        pageSize,
        ...(options.filter ? { filter: options.filter } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onInterrupt
          ? { onInterrupt: options.onInterrupt }
          : {}),
      })
    },
    [() => controller.stop()],
  )
}
