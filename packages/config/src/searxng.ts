/**
 * SearXNG direct JSON search configuration.
 *
 * The endpoint is configuration, never model input. This is what makes
 * loopback/LAN access intentional instead of turning WebFetch into an SSRF
 * escape hatch.
 */

export type SearxngSearchConfigJson = {
  /** Presence defaults to enabled; false can disable an inherited user config. */
  enabled?: boolean
  /** SearXNG root URL. `/search` is appended unless already present. */
  baseUrl?: string
  /** Per-request deadline. */
  timeoutMs?: number
  /** Maximum results returned to the model. */
  maxResults?: number
  /** Default SearXNG language when the tool call omits one. */
  language?: string
  /** Default SearXNG safe-search level: 0 off, 1 moderate, 2 strict. */
  safeSearch?: number
}

export type SearchConfigJson = {
  searxng?: SearxngSearchConfigJson
}

export type ResolvedSearxngSearchConfig = {
  baseUrl: string
  endpointUrl: string
  timeoutMs: number
  maxResults: number
  language?: string
  safeSearch: 0 | 1 | 2
}

export type ResolveSearxngSearchConfigResult =
  | { status: 'disabled' }
  | { status: 'invalid'; reason: string }
  | { status: 'enabled'; config: ResolvedSearxngSearchConfig }

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESULTS = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function resolveSearxngSearchConfigFromSearch(
  rawSearch: unknown,
): ResolveSearxngSearchConfigResult {
  if (rawSearch === undefined) return { status: 'disabled' }
  if (!isRecord(rawSearch)) {
    return { status: 'invalid', reason: 'search must be an object' }
  }
  return resolveSearxngSearchConfig(rawSearch.searxng)
}

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const isIpv6 = host.includes(':')
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    (isIpv6 &&
      (host.startsWith('fc') ||
        host.startsWith('fd') ||
        host.startsWith('fe8') ||
        host.startsWith('fe9') ||
        host.startsWith('fea') ||
        host.startsWith('feb')))
  ) {
    return true
  }
  const match = /^172\.(\d{1,3})\./.exec(host)
  if (!match) return false
  const second = Number(match[1])
  return second >= 16 && second <= 31
}

function integerInRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: fallback }
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    return {
      ok: false,
      reason: `${name} must be an integer from ${min} to ${max}`,
    }
  }
  return { ok: true, value: Number(value) }
}

export function resolveSearxngSearchConfig(
  raw: unknown,
): ResolveSearxngSearchConfigResult {
  if (raw === undefined || raw === null) return { status: 'disabled' }
  if (!isRecord(raw)) {
    return { status: 'invalid', reason: 'search.searxng must be an object' }
  }
  if (raw.enabled === false) return { status: 'disabled' }
  if (raw.enabled !== undefined && raw.enabled !== true) {
    return {
      status: 'invalid',
      reason: 'search.searxng.enabled must be true or false',
    }
  }

  const rawBaseUrl =
    typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  if (!rawBaseUrl) {
    return {
      status: 'invalid',
      reason: 'search.searxng.baseUrl is required when direct search is enabled',
    }
  }

  let base: URL
  try {
    base = new URL(rawBaseUrl)
  } catch {
    return {
      status: 'invalid',
      reason: `search.searxng.baseUrl is not a valid URL: ${rawBaseUrl}`,
    }
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return {
      status: 'invalid',
      reason: 'search.searxng.baseUrl must use http or https',
    }
  }
  if (base.username || base.password) {
    return {
      status: 'invalid',
      reason:
        'search.searxng.baseUrl must not contain credentials; put authentication in a reverse proxy',
    }
  }
  if (base.search || base.hash) {
    return {
      status: 'invalid',
      reason: 'search.searxng.baseUrl must not contain a query string or fragment',
    }
  }
  if (base.protocol === 'http:' && !isPrivateHttpHost(base.hostname)) {
    return {
      status: 'invalid',
      reason:
        'public SearXNG endpoints must use https; plaintext http is allowed only for explicit loopback/LAN hosts',
    }
  }

  const timeout = integerInRange(
    raw.timeoutMs,
    'search.searxng.timeoutMs',
    100,
    60_000,
    DEFAULT_TIMEOUT_MS,
  )
  if (!timeout.ok) return { status: 'invalid', reason: timeout.reason }
  const maxResults = integerInRange(
    raw.maxResults,
    'search.searxng.maxResults',
    1,
    20,
    DEFAULT_MAX_RESULTS,
  )
  if (!maxResults.ok) return { status: 'invalid', reason: maxResults.reason }
  const safeSearch = integerInRange(
    raw.safeSearch,
    'search.searxng.safeSearch',
    0,
    2,
    0,
  )
  if (!safeSearch.ok) return { status: 'invalid', reason: safeSearch.reason }

  let language: string | undefined
  if (raw.language !== undefined) {
    if (
      typeof raw.language !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(raw.language.trim())
    ) {
      return {
        status: 'invalid',
        reason:
          'search.searxng.language must be a language tag using letters, digits, "_" or "-"',
      }
    }
    language = raw.language.trim()
  }

  base.pathname = base.pathname.replace(/\/+$/, '') || '/'
  const endpoint = new URL(base.toString())
  if (!endpoint.pathname.endsWith('/search')) {
    endpoint.pathname =
      `${endpoint.pathname.replace(/\/+$/, '')}/search`.replace(/^\/\//, '/')
  }
  const normalizedBase = new URL(base.toString())
  normalizedBase.pathname = normalizedBase.pathname.replace(/\/+$/, '') || '/'

  return {
    status: 'enabled',
    config: {
      baseUrl: normalizedBase.toString().replace(/\/$/, ''),
      endpointUrl: endpoint.toString(),
      timeoutMs: timeout.value,
      maxResults: maxResults.value,
      ...(language ? { language } : {}),
      safeSearch: safeSearch.value as 0 | 1 | 2,
    },
  }
}
