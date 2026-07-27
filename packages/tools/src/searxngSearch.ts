import type { ResolvedSearxngSearchConfig } from '../../config/src/searxng.ts'
import { buildTool, type BoloTool, type ToolResult } from './types.ts'

export const SEARXNG_SEARCH_TOOL_NAME = 'WebSearch'
export const SEARXNG_SEARCH_MAX_RESPONSE_BYTES = 1_000_000
export const SEARXNG_SEARCH_OUTPUT_MAX_CHARS = 12_000

export type CreateSearxngSearchToolOptions = {
  isEnabled?: () => boolean
  fetchImpl?: typeof fetch
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
  engines?: string
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
    const engineValue = Array.isArray(record.engines)
      ? record.engines.join(', ')
      : record.engine
    out.push({
      title,
      url: rawUrl,
      ...(cleanText(record.content, 1_200)
        ? { snippet: cleanText(record.content, 1_200) }
        : {}),
      ...(cleanText(engineValue, 200)
        ? { engines: cleanText(engineValue, 200) }
        : {}),
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

function formatResults(query: string, results: ParsedResult[]): string {
  if (results.length === 0) {
    return `SearXNG returned no valid results for "${query}".`
  }

  let output = `SearXNG results for "${query}" (${results.length}):\n`
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!
    const metadata = [
      result.engines ? `engine=${result.engines}` : '',
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

      const requestUrl = new URL(config.endpointUrl)
      requestUrl.searchParams.set('q', parsed.value.query)
      requestUrl.searchParams.set('format', 'json')
      if (parsed.value.categories?.length) {
        requestUrl.searchParams.set(
          'categories',
          parsed.value.categories.join(','),
        )
      }
      if (parsed.value.engines?.length) {
        requestUrl.searchParams.set('engines', parsed.value.engines.join(','))
      }
      if (parsed.value.language) {
        requestUrl.searchParams.set('language', parsed.value.language)
      }
      if (parsed.value.timeRange) {
        requestUrl.searchParams.set('time_range', parsed.value.timeRange)
      }
      requestUrl.searchParams.set(
        'safesearch',
        String(parsed.value.safeSearch ?? 0),
      )
      requestUrl.searchParams.set('pageno', String(parsed.value.pageNo ?? 1))

      const controller = new AbortController()
      let timedOut = false
      const onAbort = () => controller.abort(ctx.signal?.reason)
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('SearXNG request timed out'))
      }, config.timeoutMs)

      try {
        const response = await fetchImpl(requestUrl, {
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
          return errorResult(
            `SearXNG response exceeded the ${SEARXNG_SEARCH_MAX_RESPONSE_BYTES} byte limit.`,
            'response_too_large',
          )
        }
        if (!response.ok) {
          return errorResult(
            `SearXNG HTTP ${response.status} ${response.statusText}: ${body.text
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 2_000)}`,
            'http_error',
          )
        }

        let decoded: unknown
        try {
          decoded = JSON.parse(body.text)
        } catch {
          return errorResult(
            'SearXNG returned a non-JSON response. Ensure search.formats includes json.',
            'invalid_json',
          )
        }
        const results = parseResults(decoded, parsed.value.limit)
        if (!results) {
          return errorResult(
            'SearXNG JSON response is missing a results array.',
            'invalid_response',
          )
        }
        return {
          ok: true,
          output: formatResults(parsed.value.query, results),
        }
      } catch (error) {
        if (ctx.signal?.aborted) {
          return errorResult('WebSearch was aborted.', 'aborted')
        }
        if (timedOut) {
          return errorResult(
            `SearXNG request timed out after ${config.timeoutMs} ms.`,
            'timeout',
          )
        }
        return errorResult(
          `SearXNG request failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'fetch_failed',
        )
      } finally {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
      }
    },
  })
}
