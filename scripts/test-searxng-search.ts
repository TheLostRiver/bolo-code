/**
 * OI-04: SearXNG JSON direct search contract.
 *
 * This test uses a local HTTP fixture. It does not claim that a real SearXNG
 * instance or any upstream engine has been exercised.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_SEARCH_PRESETS,
  describeWebSearchStatus,
  loadWorkspace,
  mergeConfigs,
  resolveSearxngSearchConfig,
} from '../packages/config/src/index.ts'
import {
  createSessionFromWorkspace,
  dispatchSlashCommand,
  reloadSessionPlugins,
} from '../packages/core/src/index.ts'
import {
  createSearxngSearchTool,
  SEARXNG_SEARCH_MAX_RESPONSE_BYTES,
  SEARXNG_SEARCH_OUTPUT_MAX_CHARS,
  SEARXNG_SEARCH_TOOL_NAME,
} from '../packages/tools/src/index.ts'
import { runSearchCli } from '../packages/cli/src/searchCli.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error('FAIL:', message)
    process.exit(1)
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function main() {
  let lastRequest: URL | undefined
  const server = createServer((req, res) => {
    const request = new URL(req.url ?? '/', 'http://127.0.0.1')
    lastRequest = request
    const query = request.searchParams.get('q')

    if (query === 'slow') {
      setTimeout(() => {
        if (res.destroyed) return
        res.setHeader('content-type', 'application/json')
        res.end('{"results":[]}')
      }, 300)
      return
    }
    if (query === 'http-error') {
      res.statusCode = 503
      res.end('upstream engines unavailable')
      return
    }
    if (query === 'bad-json') {
      res.setHeader('content-type', 'application/json')
      res.end('{not json')
      return
    }
    if (query === 'bad-shape') {
      res.setHeader('content-type', 'application/json')
      res.end('{"results":{"title":"not-an-array"}}')
      return
    }
    if (query === 'too-big') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          results: [
            {
              title: 'oversized',
              url: 'https://example.test/oversized',
              content: 'x'.repeat(SEARXNG_SEARCH_MAX_RESPONSE_BYTES + 1024),
            },
          ],
        }),
      )
      return
    }

    const results = Array.from({ length: 10 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.test/${index + 1}`,
      content: `Snippet ${index + 1} `.repeat(300),
      engine: index % 2 === 0 ? 'duckduckgo' : 'bing',
      score: 10 - index,
      category: 'general',
    }))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ query, number_of_results: results.length, results }))
  })
  const port = await listen(server)
  const baseUrl = `http://127.0.0.1:${port}`

  const tmpRoot = path.join(process.cwd(), '.bolo-tmp', 'searxng-search-test')
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(tmpRoot, { recursive: true })

  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  const previousProvider = process.env.BOLO_PROVIDER

  try {
    // 1) Direct SearXNG is not an MCP bridge preset.
    assert(
      !BUILTIN_SEARCH_PRESETS.some((preset) => preset.id === 'searxng'),
      'the misleading SearXNG-to-MCP bridge preset is removed',
    )

    // 2) Configuration is opt-in and invalid values fail closed.
    const absent = resolveSearxngSearchConfig(undefined)
    assert(absent.status === 'disabled', 'no config means no network tool')

    const disabled = resolveSearxngSearchConfig({ enabled: false })
    assert(disabled.status === 'disabled', 'explicit false disables inherited config')

    const valid = resolveSearxngSearchConfig({
      baseUrl,
      timeoutMs: 1_000,
      maxResults: 3,
      language: 'en',
      safeSearch: 1,
    })
    assert(valid.status === 'enabled', `valid loopback config: ${JSON.stringify(valid)}`)
    assert(
      valid.status === 'enabled' && valid.config.endpointUrl === `${baseUrl}/search`,
      'baseUrl resolves to the native /search JSON endpoint',
    )

    for (const [name, input] of [
      ['missing baseUrl', {}],
      ['public plaintext HTTP', { baseUrl: 'http://example.com' }],
      ['hostname resembling IPv6 prefix', { baseUrl: 'http://fcorp.example' }],
      ['embedded credentials', { baseUrl: 'https://user:pass@example.com' }],
      ['query in baseUrl', { baseUrl: 'https://example.com?q=hidden' }],
      ['invalid timeout', { baseUrl, timeoutMs: 0 }],
      ['invalid result budget', { baseUrl, maxResults: 99 }],
    ] as const) {
      const resolved = resolveSearxngSearchConfig(input)
      assert(
        resolved.status === 'invalid',
        `${name} must disable the tool instead of being guessed: ${JSON.stringify(resolved)}`,
      )
    }

    const merged = mergeConfigs(
      { search: { searxng: { baseUrl, timeoutMs: 2_000 } } },
      { search: { searxng: { maxResults: 4 } } },
    )
    assert(merged.search?.searxng?.baseUrl === baseUrl, 'config merge keeps user baseUrl')
    assert(merged.search?.searxng?.maxResults === 4, 'project config overrides one field')
    const malformedOverride = mergeConfigs(
      { search: { searxng: { baseUrl } } },
      {
        search: {
          searxng: 'not-an-object' as never,
        },
      },
    )
    const malformedResolution = resolveSearxngSearchConfig(
      malformedOverride.search?.searxng,
    )
    assert(
      malformedResolution.status === 'invalid',
      `malformed project override must fail closed instead of inheriting a user endpoint: ${JSON.stringify(malformedOverride)}`,
    )

    // 3) Request parameters, response parsing and result budget.
    assert(valid.status === 'enabled', 'valid config remains enabled')
    const tool = createSearxngSearchTool(valid.config)
    const searched = await tool.call(
      {
        query: 'contract query',
        categories: ['general', 'news'],
        engines: ['duckduckgo', 'bing'],
        language: 'zh-CN',
        time_range: 'month',
        safesearch: 2,
        pageno: 2,
        limit: 9,
      },
      { cwd: process.cwd() },
    )
    assert(searched.ok, `fixture search succeeds: ${searched.output}`)
    assert(lastRequest?.pathname === '/search', 'native /search endpoint was called')
    assert(lastRequest?.searchParams.get('q') === 'contract query', 'q is forwarded')
    assert(lastRequest?.searchParams.get('format') === 'json', 'JSON is explicit')
    assert(
      lastRequest?.searchParams.get('categories') === 'general,news',
      'categories are comma-separated',
    )
    assert(
      lastRequest?.searchParams.get('engines') === 'duckduckgo,bing',
      'engines are comma-separated',
    )
    assert(lastRequest?.searchParams.get('language') === 'zh-CN', 'language is forwarded')
    assert(lastRequest?.searchParams.get('time_range') === 'month', 'time range is forwarded')
    assert(lastRequest?.searchParams.get('safesearch') === '2', 'safe search is forwarded')
    assert(lastRequest?.searchParams.get('pageno') === '2', 'page number is forwarded')
    assert(searched.output.includes('Result 1'), 'first result is rendered')
    assert(searched.output.includes('Result 3'), 'configured maxResults is rendered')
    assert(!searched.output.includes('Result 4'), 'input limit cannot exceed config budget')
    assert(
      searched.output.length <= SEARXNG_SEARCH_OUTPUT_MAX_CHARS,
      `formatted result stays within ${SEARXNG_SEARCH_OUTPUT_MAX_CHARS} chars`,
    )

    // 4) Timeout and malformed upstream responses are distinct hard failures.
    const timeoutConfig = resolveSearxngSearchConfig({
      baseUrl,
      timeoutMs: 100,
      maxResults: 3,
    })
    assert(timeoutConfig.status === 'enabled', 'timeout fixture config is valid')
    const timeoutTool = createSearxngSearchTool(timeoutConfig.config)

    for (const [query, code] of [
      ['slow', 'timeout'],
      ['http-error', 'http_error'],
      ['bad-json', 'invalid_json'],
      ['bad-shape', 'invalid_response'],
      ['too-big', 'response_too_large'],
    ] as const) {
      const result = await timeoutTool.call({ query }, { cwd: process.cwd() })
      assert(!result.ok && result.isError, `${query} fails closed`)
      assert(
        result.errorCode === code,
        `${query} has actionable code ${code}, got ${result.errorCode}: ${result.output}`,
      )
    }

    // 5) Workspace wiring: valid config adds one tool; invalid config warns and adds none.
    process.env.BOLO_CONFIG_DIR = path.join(tmpRoot, 'user')
    process.env.BOLO_PROVIDER = 'mock'
    const project = path.join(tmpRoot, 'valid-project')
    await fs.mkdir(path.join(project, '.bolo'), { recursive: true })
    await fs.writeFile(
      path.join(project, '.bolo', 'config.json'),
      JSON.stringify({
        provider: { kind: 'mock' },
        search: { searxng: { baseUrl, timeoutMs: 1_000, maxResults: 3 } },
      }),
      'utf8',
    )
    const created = await createSessionFromWorkspace({
      cwd: project,
      ensureDefaults: false,
      connectMcp: false,
      systemPrompt: false,
      wireCompactSummarizer: false,
    })
    const wired = created.session.tools?.find(
      (candidate) => candidate.name === SEARXNG_SEARCH_TOOL_NAME,
    )
    assert(wired, 'valid workspace config registers WebSearch in the production tool table')

    const off = await dispatchSlashCommand(created.session, 'websearch', 'off')
    assert(off.ok, '/websearch off succeeds')
    assert(!wired!.isEnabled(), '/websearch off hides the local search tool')
    const on = await dispatchSlashCommand(created.session, 'websearch', 'on')
    assert(on.ok && wired!.isEnabled(), '/websearch on restores the local search tool')

    const statusOutput: string[] = []
    const statusCode = await runSearchCli(['status'], {
      cwd: project,
      writeOut: (text) => statusOutput.push(text),
      writeErr: (text) => statusOutput.push(text),
    })
    assert(statusCode === 0, 'bolo search status succeeds')
    assert(
      /searxng|direct json/i.test(statusOutput.join('')),
      `status reports the direct lane: ${statusOutput.join('')}`,
    )
    const combinedStatus = describeWebSearchStatus({
      dialectId: 'off',
      hasSearchMcpServer: true,
      hasSearxngSearchTool: true,
    }).summary
    assert(
      /mcp/i.test(combinedStatus) && /searxng|direct json/i.test(combinedStatus),
      `status names every configured lane instead of contradicting endpoint details: ${combinedStatus}`,
    )

    await reloadSessionPlugins(created.session, {
      reconnectMcp: false,
      refreshSkillCatalog: false,
    })
    await reloadSessionPlugins(created.session, {
      reconnectMcp: false,
      refreshSkillCatalog: false,
    })
    assert(
      created.session.tools?.filter(
        (candidate) => candidate.name === SEARXNG_SEARCH_TOOL_NAME,
      ).length === 1,
      'repeated reload keeps exactly one direct WebSearch tool',
    )

    const invalidProject = path.join(tmpRoot, 'invalid-project')
    await fs.mkdir(path.join(invalidProject, '.bolo'), { recursive: true })
    await fs.writeFile(
      path.join(invalidProject, '.bolo', 'config.json'),
      JSON.stringify({
        provider: { kind: 'mock' },
        search: { searxng: { baseUrl: 'http://example.com' } },
      }),
      'utf8',
    )
    const invalidWorkspace = await loadWorkspace({
      cwd: invalidProject,
      ensureDefaults: false,
      loadPlugins: false,
    })
    assert(!invalidWorkspace.searxngSearch, 'invalid config does not resolve a tool config')
    assert(
      invalidWorkspace.configWarnings?.some((warning) =>
        /search\.searxng|WebSearch/i.test(warning),
      ),
      `invalid config is visible: ${JSON.stringify(invalidWorkspace.configWarnings)}`,
    )
    const invalidEvents: string[] = []
    const invalidSession = await createSessionFromWorkspace({
      cwd: invalidProject,
      ensureDefaults: false,
      connectMcp: false,
      systemPrompt: false,
      wireCompactSummarizer: false,
      onEvent: (event) => {
        if (event.type === 'warning') invalidEvents.push(event.message)
      },
    })
    assert(
      invalidEvents.some((warning) => /search\.searxng|WebSearch/i.test(warning)),
      `Desktop-style core event sink sees invalid search config: ${JSON.stringify(invalidEvents)}`,
    )
    assert(
      !invalidSession.session.tools?.some(
        (candidate) => candidate.name === SEARXNG_SEARCH_TOOL_NAME,
      ),
      'invalid config never registers WebSearch during production assembly',
    )

    const malformedRootProject = path.join(tmpRoot, 'malformed-root-project')
    await fs.mkdir(path.join(malformedRootProject, '.bolo'), { recursive: true })
    await fs.writeFile(
      path.join(malformedRootProject, '.bolo', 'config.json'),
      JSON.stringify({
        provider: { kind: 'mock' },
        search: 'not-an-object',
      }),
      'utf8',
    )
    const malformedRoot = await loadWorkspace({
      cwd: malformedRootProject,
      ensureDefaults: false,
      loadPlugins: false,
    })
    assert(!malformedRoot.searxngSearch, 'malformed search root cannot register a tool')
    assert(
      malformedRoot.configWarnings?.some((warning) =>
        /search must be an object/i.test(warning),
      ),
      `malformed search root is visible instead of looking disabled: ${JSON.stringify(malformedRoot.configWarnings)}`,
    )
  } finally {
    if (previousConfigDir === undefined) delete process.env.BOLO_CONFIG_DIR
    else process.env.BOLO_CONFIG_DIR = previousConfigDir
    if (previousProvider === undefined) delete process.env.BOLO_PROVIDER
    else process.env.BOLO_PROVIDER = previousProvider
    await close(server)
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }

  console.log('PASS: SearXNG direct JSON search')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
