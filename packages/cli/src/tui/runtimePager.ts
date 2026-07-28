/**
 * AR1C1：轻量 runtime TTY pager。
 *
 * page/cursor 只存在于本函数栈。view 仍是 core 的不可变 query
 * projection；非 TTY 多页视图由调用方回落一次性文本输出。
 */

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

export type RuntimePagerInput = {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
  resume: () => unknown
  onceData: (listener: (chunk: Buffer | string) => void) => unknown
  onceEnd: (listener: () => void) => unknown
  onceError: (listener: (error: Error) => void) => unknown
  removeData: (listener: (chunk: Buffer | string) => void) => unknown
  removeEnd: (listener: () => void) => unknown
  removeError: (listener: (error: Error) => void) => unknown
}

export type RuntimePagerResult =
  | RuntimePagerSuccess
  | {
      ok: false
      reason: 'unsupported'
      message: string
    }

function adaptRuntimePagerInput(
  input: NodeJS.ReadStream,
): RuntimePagerInput {
  return {
    get isTTY() {
      return input.isTTY
    },
    get isRaw() {
      return input.isRaw
    },
    setRawMode: (mode) => input.setRawMode?.(mode),
    resume: () => input.resume(),
    onceData: (listener) => input.once('data', listener),
    onceEnd: (listener) => input.once('end', listener),
    onceError: (listener) => input.once('error', listener),
    removeData: (listener) => input.removeListener('data', listener),
    removeEnd: (listener) => input.removeListener('end', listener),
    removeError: (listener) =>
      input.removeListener('error', listener),
  }
}

export async function readRuntimePagerKey(options: {
  input?: RuntimePagerInput
  signal?: AbortSignal
} = {}): Promise<RuntimePagerKey> {
  const input =
    options.input ?? adaptRuntimePagerInput(process.stdin)
  if (options.signal?.aborted) return 'ctrl-c'
  if (input.isTTY !== true) return 'eof'

  return await new Promise<RuntimePagerKey>((resolve, reject) => {
    const wasRaw = input.isRaw === true
    let settled = false

    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort)
      input.removeData(onData)
      input.removeEnd(onEnd)
      input.removeError(onError)
    }
    const restoreRawMode = (): Error | undefined => {
      try {
        input.setRawMode?.(wasRaw)
        return undefined
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
      }
    }
    const finish = (key: RuntimePagerKey) => {
      if (settled) return
      settled = true
      cleanup()
      const restoreError = restoreRawMode()
      if (restoreError) reject(restoreError)
      else resolve(key)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      const restoreError = restoreRawMode()
      reject(
        restoreError ??
          (error instanceof Error ? error : new Error(String(error))),
      )
    }
    const onAbort = () => finish('ctrl-c')
    const onData = (chunk: Buffer | string) =>
      finish(parseRuntimePagerKey(chunk.toString()))
    const onEnd = () => finish('eof')
    const onError = (error: Error) => fail(error)

    options.signal?.addEventListener('abort', onAbort, { once: true })
    input.onceData(onData)
    input.onceEnd(onEnd)
    input.onceError(onError)

    try {
      input.setRawMode?.(true)
      input.resume()
    } catch (error) {
      fail(error)
    }
  })
}

function readKeyWithAbort(
  readKey: () => Promise<RuntimePagerKey>,
  signal?: AbortSignal,
): Promise<RuntimePagerKey> {
  if (!signal) return readKey()
  if (signal.aborted) return Promise.resolve('ctrl-c')
  return new Promise<RuntimePagerKey>((resolve, reject) => {
    let settled = false
    const finish = (key: RuntimePagerKey) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(key)
    }
    const onAbort = () => finish('ctrl-c')
    signal.addEventListener('abort', onAbort, { once: true })
    readKey().then(finish, (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

export async function runRuntimePager(options: {
  view: RuntimeQueryView
  columns?: number
  rows?: number
  pageSize?: number
  color?: boolean
  filter?: RuntimeTextRenderOptions['filter']
  isTty?: boolean
  readKey?: () => Promise<RuntimePagerKey>
  writeOut?: (text: string) => void
  signal?: AbortSignal
  onInterrupt?: () => void
}): Promise<RuntimePagerResult> {
  const writeOut =
    options.writeOut ?? ((text: string) => process.stdout.write(text))
  const isTty = options.isTty ?? process.stdin.isTTY === true
  const columns =
    options.columns ??
    (typeof process.stdout.columns === 'number'
      ? process.stdout.columns
      : 80)
  const rows =
    options.rows ??
    (typeof process.stdout.rows === 'number' ? process.stdout.rows : 24)
  const pageSize =
    options.pageSize ??
    Math.max(1, Math.floor(rows) - 6)
  const render = (page: number) =>
    renderRuntimeText(options.view, {
      columns,
      page,
      pageSize,
      color: options.color,
      filter: options.filter,
    })
  let current = render(0)

  if (current.pageCount <= 1) {
    writeOut(`${current.text}\n`)
    return {
      ok: true,
      reason: 'single-page',
      page: current.page,
      pageCount: current.pageCount,
    }
  }
  if (!isTty) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'runtime pager requires TTY for a multi-page view',
    }
  }

  const readKey =
    options.readKey ??
    (() => readRuntimePagerKey({ signal: options.signal }))
  const paint = () => {
    writeOut('\u001b[2J\u001b[H')
    writeOut(`${current.text}\n`)
  }

  paint()
  for (;;) {
    const key = await readKeyWithAbort(readKey, options.signal)
    if (key === 'none') continue
    const next = applyRuntimePagerKey(
      current.page,
      current.pageCount,
      key,
    )
    if (next.done) {
      if (next.done === 'interrupt') options.onInterrupt?.()
      return {
        ok: true,
        reason: next.done,
        page: next.page,
        pageCount: current.pageCount,
      }
    }
    if (next.page !== current.page) {
      current = render(next.page)
      paint()
    }
  }
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
