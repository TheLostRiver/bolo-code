/** Standalone retained picker for pre-session TTY selection. */

import { runWithAsyncCleanup } from '../cleanup.ts'
import type {
  BoloTerminalInput,
  BoloTerminalOutput,
} from './boloTerminalAdapter.ts'
import type {
  ArrowPickItem,
  ArrowPickResult,
} from './arrowPicker.ts'
import { createRetainedTuiController } from './retainedTui.ts'

export async function runRetainedArrowPicker(options: {
  items: ArrowPickItem[]
  title?: string
  initialIndex?: number
  color?: boolean
  isTty?: boolean
  input?: BoloTerminalInput
  output?: BoloTerminalOutput
  writeOut?: (text: string) => void
  signal?: AbortSignal
}): Promise<ArrowPickResult> {
  if (!options.items.length) {
    return { ok: false, reason: 'cancel', message: 'empty list' }
  }
  if (options.signal?.aborted) {
    return { ok: false, reason: 'cancel', message: 'cancelled' }
  }

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const isTty =
    options.isTty ??
    (input.isTTY === true && process.stdout.isTTY === true)
  if (
    !isTty ||
    input.isTTY !== true ||
    typeof input.setRawMode !== 'function'
  ) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'retained picker requires a raw TTY',
    }
  }

  const writeOut =
    options.writeOut ?? ((text: string) => process.stdout.write(text))
  const controller = createRetainedTuiController({
    writeOut,
    input,
    output,
    fallbackColumns:
      typeof output.columns === 'number' ? output.columns : 80,
    fallbackRows: typeof output.rows === 'number' ? output.rows : 24,
    color: options.color,
    rootVisible: false,
  })

  return runWithAsyncCleanup(
    async () => {
      await controller.start()
      return controller.runPickerOverlay({
        mode: 'picker',
        items: options.items,
        ...(options.title ? { title: options.title } : {}),
        ...(options.initialIndex != null
          ? { initialIndex: options.initialIndex }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    },
    [() => controller.stop()],
  )
}
