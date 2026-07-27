export type ProviderRequestAbortSource = 'timeout' | 'parent' | 'transport'

export type ProviderRequestAbort = {
  signal: AbortSignal
  source(): ProviderRequestAbortSource | undefined
  normalizeError(error: unknown): Error
  dispose(): void
}

export type ProviderRequestAbortOptions = {
  label: string
  endpoint: string
  timeoutMs: number
  parent?: AbortSignal
}

function safeEndpointLabel(endpoint: string): string {
  try {
    const parsed = new URL(endpoint)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return '(invalid configured endpoint)'
  }
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

/**
 * Own one provider request deadline without losing whether the first abort
 * came from that deadline or from the caller.
 */
export function createProviderRequestAbort(
  options: ProviderRequestAbortOptions,
): ProviderRequestAbort {
  const controller = new AbortController()
  const endpoint = safeEndpointLabel(options.endpoint)
  let source: ProviderRequestAbortSource | undefined
  let sourceError: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let listeningToParent = false

  const abort = (
    nextSource: Exclude<ProviderRequestAbortSource, 'transport'>,
    error: Error,
  ) => {
    if (source || controller.signal.aborted) return
    source = nextSource
    sourceError = error
    controller.abort(error)
  }
  const onParentAbort = () => {
    abort(
      'parent',
      namedError(
        'AbortError',
        `${options.label} request aborted by caller (endpoint: ${endpoint})`,
      ),
    )
  }

  if (options.parent?.aborted) {
    onParentAbort()
  } else {
    if (options.parent) {
      options.parent.addEventListener('abort', onParentAbort, { once: true })
      listeningToParent = true
    }
    timer = setTimeout(() => {
      abort(
        'timeout',
        namedError(
          'TimeoutError',
          `${options.label} request timed out after ${options.timeoutMs} ms ` +
            `(endpoint: ${endpoint})`,
        ),
      )
    }, options.timeoutMs)
  }

  return {
    signal: controller.signal,
    source: () => source,
    normalizeError(error: unknown): Error {
      if (sourceError) return sourceError
      if (error instanceof Error && error.name === 'AbortError') {
        source = 'transport'
        return namedError(
          'NetworkError',
          `${options.label} network request was aborted by the transport ` +
            `(endpoint: ${endpoint})`,
        )
      }
      if (error instanceof Error) return error
      return new Error(String(error))
    },
    dispose() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (listeningToParent) {
        options.parent?.removeEventListener('abort', onParentAbort)
        listeningToParent = false
      }
    },
  }
}
