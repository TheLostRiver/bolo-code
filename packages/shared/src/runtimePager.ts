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

export type RuntimePagerTransition = {
  page: number
  done?: Exclude<RuntimePagerDoneReason, 'single-page'>
}

export type RuntimePagerSuccess = {
  ok: true
  reason: RuntimePagerDoneReason
  page: number
  pageCount: number
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
): RuntimePagerTransition {
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
