import type { ResolvedSearxngSearchConfig } from '../../config/src/searxng.ts'
import { buildTool, type BoloTool, type ToolResult } from './types.ts'

export const SEARXNG_SEARCH_TOOL_NAME = 'WebSearch'
export const SEARXNG_SEARCH_MAX_RESPONSE_BYTES = 1_000_000
export const SEARXNG_SEARCH_OUTPUT_MAX_CHARS = 12_000

export type CreateSearxngSearchToolOptions = {
  isEnabled?: () => boolean
  fetchImpl?: typeof fetch
}

export type SearxngDoctorCode =
  | 'ok'
  | 'partial_success'
  | 'empty_results'
  | 'upstream_unavailable'
  | 'invalid_input'
  | 'aborted'
  | 'timeout'
  | 'fetch_failed'
  | 'http_error'
  | 'response_too_large'
  | 'invalid_json'
  | 'invalid_response'

export type SearxngDoctorStage = 'config' | 'search' | 'complete'

export type SearxngUpstreamFailure = {
  engine: string
  reason: string
}

export type SearxngDoctorReport = {
  ok: boolean
  code: SearxngDoctorCode
  stage: SearxngDoctorStage
  endpointUrl: string
  query: string
  version?: string
  instanceName?: string
  capabilities: {
    configJson: boolean
    searchJson: boolean
  }
  configuredEngineCount?: number
  resultCount: number
  workingEngines: string[]
  unresponsiveEngines: SearxngUpstreamFailure[]
  detail?: string
}

export type ProbeSearxngOptions = {
  query?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

type SearchInput = {
  query: string
  categories?: string[]
  engines?: string[]
  language?: string
  timeRange?: 'day' | 'month' | 'year'
  safeSearch?: 0 | 1 | 2
  pageNo?: number
  limit: number
}

type ParsedResult = {
  title: string
  url: string
  snippet?: string
  engines?: string[]
  category?: string
  publishedDate?: string
}

function errorResult(output: string, errorCode: string): ToolResult {
  return { ok: false, isError: true, output, errorCode }
}

function cleanText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function parseStringList(
  value: unknown,
  name: string,
): { ok: true; value?: string[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true }
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    return { ok: false, message: `${name} must be an array of 1 to 10 strings` }
  }
  const out: string[] = []
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !item.trim() ||
      item.length > 64 ||
      item.includes(',') ||
      item.split('').some((char) => char.charCodeAt(0) < 32)
    ) {
      return {
        ok: false,
        message: `${name} items must be non-empty strings without commas or control characters`,
      }
    }
    out.push(item.trim())
  }
  return { ok: true, value: out }
}

function parseInput(
  raw: Record<string, unknown>,
  config: ResolvedSearxngSearchConfig,
): { ok: true; value: SearchInput } | { ok: false; message: string } {
  const query = typeof raw.query === 'string' ? raw.query.trim() : ''
  if (!query || query.length > 1_000) {
    return {
      ok: false,
      message: 'query must be a non-empty string of at most 1000 characters',
    }
  }
  const categories = parseStringList(raw.categories, 'categories')
  if (!categories.ok) return categories
  const engines = parseStringList(raw.engines, 'engines')
  if (!engines.ok) return engines

  let language = config.language
  if (raw.language !== undefined) {
    if (
      typeof raw.language !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(raw.language.trim())
    ) {
      return {
        ok: false,
        message:
          'language must use only letters, digits, "_" or "-" and be at most 32 characters',
      }
    }
    language = raw.language.trim()
  }

  let timeRange: SearchInput['timeRange']
  if (raw.time_range !== undefined) {
    if (
      raw.time_range !== 'day' &&
      raw.time_range !== 'month' &&
      raw.time_range !== 'year'
    ) {
      return { ok: false, message: 'time_range must be day, month or year' }
    }
    timeRange = raw.time_range
  }

  const safeRaw = raw.safesearch ?? config.safeSearch
  if (
    !Number.isInteger(safeRaw) ||
    Number(safeRaw) < 0 ||
    Number(safeRaw) > 2
  ) {
    return { ok: false, message: 'safesearch must be 0, 1 or 2' }
  }
  const pageRaw = raw.pageno ?? 1
  if (
    !Number.isInteger(pageRaw) ||
    Number(pageRaw) < 1 ||
    Number(pageRaw) > 20
  ) {
    return { ok: false, message: 'pageno must be an integer from 1 to 20' }
  }
  const limitRaw = raw.limit ?? config.maxResults
  if (!Number.isInteger(limitRaw) || Number(limitRaw) < 1) {
    return { ok: false, message: 'limit must be a positive integer' }
  }

  return {
    ok: true,
    value: {
      query,
      ...(categories.value ? { categories: categories.value } : {}),
      ...(engines.value ? { engines: engines.value } : {}),
      ...(language ? { language } : {}),
      ...(timeRange ? { timeRange } : {}),
      safeSearch: Number(safeRaw) as 0 | 1 | 2,
      pageNo: Number(pageRaw),
      limit: Math.min(Number(limitRaw), config.maxResults),
    },
  }
}

async function readBodyWithLimit(
  response: Response,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return { ok: false }
  if (!response.body) return { ok: true, text: '' }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return { ok: false }
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    ok: true,
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
  }
}

function parseResults(raw: unknown, limit: number): ParsedResult[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const results = (raw as Record<string, unknown>).results
  if (!Array.isArray(results)) return null

  const out: ParsedResult[] = []
  for (const candidate of results) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue
    }
    const record = candidate as Record<string, unknown>
    const title = cleanText(record.title, 300)
    const rawUrl = cleanText(record.url, 2_000)
    if (!title || !rawUrl) continue
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    } catch {
      continue
    }
    const rawEngines = Array.isArray(record.engines)
      ? record.engines
      : record.engine === undefined
        ? []
        : [record.engine]
    const engines: string[] = []
    const seenEngines = new Set<string>()
    for (const rawEngine of rawEngines) {
      const engine = cleanText(rawEngine, 80)
      if (!engine) continue
      const key = engine.toLowerCase()
      if (seenEngines.has(key)) continue
      seenEngines.add(key)
      engines.push(engine)
      if (engines.length >= 8) break
    }
    out.push({
      title,
      url: rawUrl,
      ...(cleanText(record.content, 1_200)
        ? { snippet: cleanText(record.content, 1_200) }
        : {}),
      ...(engines.length ? { engines } : {}),
      ...(cleanText(record.category, 100)
        ? { category: cleanText(record.category, 100) }
        : {}),
      ...(cleanText(record.publishedDate ?? record.published_date, 100)
        ? {
            publishedDate: cleanText(
              record.publishedDate ?? record.published_date,
              100,
            ),
          }
        : {}),
    })
    if (out.length >= limit) break
  }
  return out
}

function parseUnresponsiveEngines(raw: unknown): SearxngUpstreamFailure[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const candidates = (raw as Record<string, unknown>).unresponsive_engines
  if (!Array.isArray(candidates)) return []

  const out: SearxngUpstreamFailure[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length < 2) continue
    const engine = cleanText(candidate[0], 80)
    const reason = cleanText(candidate[1], 160)
    if (!engine || !reason) continue
    const key = `${engine.toLowerCase()}\u0000${reason.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ engine, reason })
    if (out.length >= 8) break
  }
  return out
}

function formatUnresponsiveEngines(
  engines: SearxngUpstreamFailure[],
): string {
  return engines
    .map(({ engine, reason }) => `${engine} (${reason})`)
    .join(', ')
}

function appendUpstreamWarning(
  output: string,
  engines: SearxngUpstreamFailure[],
): string {
  if (engines.length === 0) return output
  const suffix = `\n\nWarning: SearXNG reported unavailable upstream engines: ${formatUnresponsiveEngines(
    engines,
  )}.`
  if (suffix.length >= SEARXNG_SEARCH_OUTPUT_MAX_CHARS) {
    return suffix.slice(0, SEARXNG_SEARCH_OUTPUT_MAX_CHARS)
  }
  const outputBudget = SEARXNG_SEARCH_OUTPUT_MAX_CHARS - suffix.length
  if (output.length <= outputBudget) return `${output}${suffix}`
  const marker = '\n… result text omitted to preserve upstream diagnostics'
  const bodyBudget = Math.max(0, outputBudget - marker.length)
  return `${output.slice(0, bodyBudget)}${marker}${suffix}`
}

function formatResults(query: string, results: ParsedResult[]): string {
  if (results.length === 0) {
    return `SearXNG returned no valid results for "${query}".`
  }

  let output = `SearXNG results for "${query}" (${results.length}):\n`
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!
    const metadata = [
      result.engines?.length ? `engine=${result.engines.join(', ')}` : '',
      result.category ? `category=${result.category}` : '',
      result.publishedDate ? `published=${result.publishedDate}` : '',
    ].filter(Boolean)
    const block = [
      `\n${index + 1}. ${result.title}`,
      `   URL: ${result.url}`,
      result.snippet ? `   ${result.snippet}` : '',
      metadata.length ? `   ${metadata.join(' · ')}` : '',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n')
    if (output.length + block.length > SEARXNG_SEARCH_OUTPUT_MAX_CHARS) {
      const marker = '\n… additional result text omitted by local output budget'
      const room =
        SEARXNG_SEARCH_OUTPUT_MAX_CHARS - output.length - marker.length
      if (room > 0) output += block.slice(0, room)
      output += marker
      break
    }
    output += block
  }
  return output.slice(0, SEARXNG_SEARCH_OUTPUT_MAX_CHARS)
}

type JsonRequestResult =
  | { ok: true; decoded: unknown }
  | {
      ok: false
      code:
        | 'aborted'
        | 'timeout'
        | 'fetch_failed'
        | 'http_error'
        | 'response_too_large'
        | 'invalid_json'
      detail: string
    }

async function requestSearxngJson(
  requestUrl: URL,
  options: {
    timeoutMs: number
    fetchImpl: typeof fetch
    signal?: AbortSignal
    label: string
  },
): Promise<JsonRequestResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: 'aborted',
      detail: `${options.label} request was aborted before it started.`,
    }
  }

  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`${options.label} request timed out`))
  }, options.timeoutMs)

  try {
    const response = await options.fetchImpl(requestUrl, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'BoloCode-SearXNGSearch/0.1',
      },
    })
    const body = await readBodyWithLimit(
      response,
      SEARXNG_SEARCH_MAX_RESPONSE_BYTES,
    )
    if (!body.ok) {
      return {
        ok: false,
        code: 'response_too_large',
        detail: `${options.label} response exceeded the ${SEARXNG_SEARCH_MAX_RESPONSE_BYTES} byte limit.`,
      }
    }
    if (!response.ok) {
      const status = `${response.status} ${response.statusText}`.trim()
      const bodyPreview = body.text.replace(/\s+/g, ' ').trim().slice(0, 2_000)
      return {
        ok: false,
        code: 'http_error',
        detail: `${options.label} HTTP ${status}${bodyPreview ? `: ${bodyPreview}` : ''}`,
      }
    }

    try {
      return { ok: true, decoded: JSON.parse(body.text) as unknown }
    } catch {
      return {
        ok: false,
        code: 'invalid_json',
        detail: `${options.label} returned a non-JSON response. Ensure search.formats includes json.`,
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      return {
        ok: false,
        code: 'aborted',
        detail: `${options.label} request was aborted.`,
      }
    }
    if (timedOut) {
      return {
        ok: false,
        code: 'timeout',
        detail: `${options.label} request timed out after ${options.timeoutMs} ms.`,
      }
    }
    const message = cleanText(
      error instanceof Error ? error.message : String(error),
      1_000,
    )
    return {
      ok: false,
      code: 'fetch_failed',
      detail: `${options.label} request failed${message ? `: ${message}` : '.'}`,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

function buildSearchRequestUrl(config: ResolvedSearxngSearchConfig, input: SearchInput): URL {
  const requestUrl = new URL(config.endpointUrl)
  requestUrl.searchParams.set('q', input.query)
  requestUrl.searchParams.set('format', 'json')
  if (input.categories?.length) {
    requestUrl.searchParams.set('categories', input.categories.join(','))
  }
  if (input.engines?.length) {
    requestUrl.searchParams.set('engines', input.engines.join(','))
  }
  if (input.language) {
    requestUrl.searchParams.set('language', input.language)
  }
  if (input.timeRange) {
    requestUrl.searchParams.set('time_range', input.timeRange)
  }
  requestUrl.searchParams.set('safesearch', String(input.safeSearch ?? 0))
  requestUrl.searchParams.set('pageno', String(input.pageNo ?? 1))
  return requestUrl
}

function buildConfigRequestUrl(config: ResolvedSearxngSearchConfig): URL {
  const requestUrl = new URL(config.baseUrl)
  const rootPath = requestUrl.pathname.endsWith('/search')
    ? requestUrl.pathname.slice(0, -'/search'.length)
    : requestUrl.pathname.replace(/\/+$/, '')
  requestUrl.pathname = `${rootPath}/config`.replace(/^\/\//, '/')
  requestUrl.search = ''
  requestUrl.hash = ''
  return requestUrl
}

function parseConfigInfo(raw: unknown):
  | {
      version: string
      instanceName?: string
      configuredEngineCount: number
    }
  | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const version = cleanText(record.version, 80)
  if (!version || !Array.isArray(record.engines)) return undefined
  const instanceName = cleanText(record.instance_name, 160)
  return {
    version,
    ...(instanceName ? { instanceName } : {}),
    configuredEngineCount: Math.min(record.engines.length, 10_000),
  }
}

function collectWorkingEngines(results: ParsedResult[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const result of results) {
    for (const engine of result.engines ?? []) {
      const key = engine.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(engine)
      if (out.length >= 16) return out
    }
  }
  return out
}

export async function probeSearxng(
  config: ResolvedSearxngSearchConfig,
  options: ProbeSearxngOptions = {},
): Promise<SearxngDoctorReport> {
  const rawQuery = options.query ?? 'searxng'
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : ''
  const reportBase = {
    endpointUrl: config.endpointUrl,
    query,
    resultCount: 0,
    workingEngines: [] as string[],
    unresponsiveEngines: [] as SearxngUpstreamFailure[],
  }
  if (!query || query.length > 1_000) {
    return {
      ...reportBase,
      ok: false,
      code: 'invalid_input',
      stage: 'config',
      capabilities: { configJson: false, searchJson: false },
      detail: 'SearXNG doctor query must be a non-empty string of at most 1000 characters.',
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const configResponse = await requestSearxngJson(buildConfigRequestUrl(config), {
    timeoutMs: config.timeoutMs,
    fetchImpl,
    ...(options.signal ? { signal: options.signal } : {}),
    label: 'SearXNG /config',
  })
  if (!configResponse.ok) {
    return {
      ...reportBase,
      ok: false,
      code: configResponse.code,
      stage: 'config',
      capabilities: { configJson: false, searchJson: false },
      detail: configResponse.detail,
    }
  }

  const configInfo = parseConfigInfo(configResponse.decoded)
  if (!configInfo) {
    return {
      ...reportBase,
      ok: false,
      code: 'invalid_response',
      stage: 'config',
      capabilities: { configJson: true, searchJson: false },
      detail:
        'SearXNG /config JSON is missing a bounded version string or engines array.',
    }
  }

  const parsedInput = parseInput({ query }, config)
  if (!parsedInput.ok) {
    return {
      ...reportBase,
      ...configInfo,
      ok: false,
      code: 'invalid_input',
      stage: 'search',
      capabilities: { configJson: true, searchJson: false },
      detail: parsedInput.message,
    }
  }
  const searchResponse = await requestSearxngJson(
    buildSearchRequestUrl(config, parsedInput.value),
    {
      timeoutMs: config.timeoutMs,
      fetchImpl,
      ...(options.signal ? { signal: options.signal } : {}),
      label: 'SearXNG search',
    },
  )
  if (!searchResponse.ok) {
    return {
      ...reportBase,
      ...configInfo,
      ok: false,
      code: searchResponse.code,
      stage: 'search',
      capabilities: { configJson: true, searchJson: false },
      detail: searchResponse.detail,
    }
  }

  const results = parseResults(searchResponse.decoded, parsedInput.value.limit)
  if (!results) {
    return {
      ...reportBase,
      ...configInfo,
      ok: false,
      code: 'invalid_response',
      stage: 'search',
      capabilities: { configJson: true, searchJson: true },
      detail: 'SearXNG search JSON response is missing a results array.',
    }
  }
  const unresponsiveEngines = parseUnresponsiveEngines(searchResponse.decoded)
  const workingEngines = collectWorkingEngines(results)
  const completed = {
    ...reportBase,
    ...configInfo,
    stage: 'complete' as const,
    capabilities: { configJson: true, searchJson: true },
    resultCount: results.length,
    workingEngines,
    unresponsiveEngines,
  }
  if (results.length === 0 && unresponsiveEngines.length > 0) {
    return {
      ...completed,
      ok: false,
      code: 'upstream_unavailable',
      detail: `SearXNG returned no valid results because upstream engines were unavailable: ${formatUnresponsiveEngines(
        unresponsiveEngines,
      )}.`,
    }
  }
  if (results.length === 0) {
    return {
      ...completed,
      ok: false,
      code: 'empty_results',
      detail: `SearXNG returned no valid results for the smoke query "${query}".`,
    }
  }
  return {
    ...completed,
    ok: true,
    code: unresponsiveEngines.length > 0 ? 'partial_success' : 'ok',
  }
}

export function createSearxngSearchTool(
  config: ResolvedSearxngSearchConfig,
  options: CreateSearxngSearchToolOptions = {},
): BoloTool {
  const fetchImpl = options.fetchImpl ?? fetch
  return buildTool({
    name: SEARXNG_SEARCH_TOOL_NAME,
    description:
      'Search the web through the explicitly configured SearXNG JSON endpoint. Queries may still be forwarded by SearXNG to upstream engines. Use WebFetch to fetch a known result URL.',
    requiresPermission: true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isEnabled: options.isEnabled ?? (() => true),
    interruptBehavior: () => 'cancel',
    inputJSONSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional SearXNG categories',
        },
        engines: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional SearXNG engine names',
        },
        language: { type: 'string' },
        time_range: { type: 'string', enum: ['day', 'month', 'year'] },
        safesearch: { type: 'integer', minimum: 0, maximum: 2 },
        pageno: { type: 'integer', minimum: 1, maximum: 20 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async validateInput(input) {
      const parsed = parseInput(input, config)
      return parsed.ok
        ? { ok: true }
        : { ok: false, message: parsed.message, errorCode: 'invalid_input' }
    },
    async call(input, ctx) {
      if (ctx.signal?.aborted) {
        return errorResult('WebSearch was aborted before it started.', 'aborted')
      }
      const parsed = parseInput(input, config)
      if (!parsed.ok) return errorResult(parsed.message, 'invalid_input')

      const response = await requestSearxngJson(
        buildSearchRequestUrl(config, parsed.value),
        {
          timeoutMs: config.timeoutMs,
          fetchImpl,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          label: 'SearXNG',
        },
      )
      if (!response.ok) {
        return errorResult(response.detail, response.code)
      }
      const results = parseResults(response.decoded, parsed.value.limit)
      if (!results) {
        return errorResult(
          'SearXNG JSON response is missing a results array.',
          'invalid_response',
        )
      }
      const unresponsiveEngines = parseUnresponsiveEngines(response.decoded)
      if (results.length === 0 && unresponsiveEngines.length > 0) {
        return errorResult(
          `SearXNG returned no results because upstream engines were unavailable: ${formatUnresponsiveEngines(
            unresponsiveEngines,
          )}.`,
          'upstream_unavailable',
        )
      }
      return {
        ok: true,
        output: appendUpstreamWarning(
          formatResults(parsed.value.query, results),
          unresponsiveEngines,
        ),
      }
    },
  })
}
