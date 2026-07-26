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

export type RuntimePagerKey =
  | 'next'
  | 'previous'
  | 'quit'
  | 'ctrl-c'
  | 'eof'
  | 'none'

export type RuntimePagerDoneReason =
  | 'single-page'
  | 'quit'
  | 'interrupt'
  | 'eof'

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
  | {
      ok: true
      reason: RuntimePagerDoneReason
      page: number
      pageCount: number
    }
  | {
      ok: false
      reason: 'unsupported'
      message: string
    }

export function parseRuntimePagerKey(input: string): RuntimePagerKey {
  if (input === '' || input === '\u0004') return 'eof'
  if (input === '\u0003') return 'ctrl-c'
  if (input === '\u001b' || input === 'q' || input === 'Q') {
    return 'quit'
  }
  if (
    input === '\u001b[B' ||
    input === '\u001b[C' ||
    input === '\u001b[6~' ||
    input === 'n' ||
    input === 'N' ||
    input === 'j' ||
    input === 'l' ||
    input === ' '
  ) {
    return 'next'
  }
  if (
    input === '\u001b[A' ||
    input === '\u001b[D' ||
    input === '\u001b[5~' ||
    input === 'p' ||
    input === 'P' ||
    input === 'k' ||
    input === 'h' ||
    input === 'b' ||
    input === 'B'
  ) {
    return 'previous'
  }
  return 'none'
}

export function applyRuntimePagerKey(
  page: number,
  pageCount: number,
  key: RuntimePagerKey,
): {
  page: number
  done?: 'quit' | 'interrupt' | 'eof'
} {
  const last = Math.max(0, Math.floor(pageCount) - 1)
  const current = Math.max(0, Math.min(last, Math.floor(page)))
  if (key === 'next') return { page: Math.min(last, current + 1) }
  if (key === 'previous') return { page: Math.max(0, current - 1) }
  if (key === 'quit') return { page: current, done: 'quit' }
  if (key === 'ctrl-c') {
    return { page: current, done: 'interrupt' }
  }
  if (key === 'eof') return { page: current, done: 'eof' }
  return { page: current }
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
