/**
 * OI-07B: structured SearXNG health probe and `bolo search doctor`.
 *
 * The fixture is local and deterministic. Public SearXNG/upstream availability
 * must never become a default gate.
 */
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  resolveSearxngSearchConfig,
  type ResolvedSearxngSearchConfig,
} from '../packages/config/src/index.ts'
import { runSearchCli } from '../packages/cli/src/searchCli.ts'
import { probeSearxng } from '../packages/tools/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
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

function collect() {
  const out: string[] = []
  const err: string[] = []
  return {
    writeOut: (text: string) => out.push(text),
    writeErr: (text: string) => err.push(text),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

async function runMainCli(
  repoRoot: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        path.join(repoRoot, 'packages', 'cli', 'src', 'main.ts'),
        ...args,
      ],
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const errorCode = (
          error as (Error & { code?: string | number }) | null
        )?.code
        resolve({
          code: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
          stdout,
          stderr,
        })
      },
    )
  })
}

function fixtureConfig(
  origin: string,
  mode: string,
  timeoutMs = 1_000,
): ResolvedSearxngSearchConfig {
  const resolved = resolveSearxngSearchConfig({
    baseUrl: `${origin}/${mode}`,
    timeoutMs,
    maxResults: 5,
    safeSearch: 1,
  })
  assert(resolved.status === 'enabled', `fixture config resolves: ${JSON.stringify(resolved)}`)
  return resolved.config
}

async function writeProject(
  root: string,
  name: string,
  search: unknown,
): Promise<string> {
  const cwd = path.join(root, name)
  await fs.mkdir(path.join(cwd, '.bolo'), { recursive: true })
  await fs.writeFile(
    path.join(cwd, '.bolo', 'config.json'),
    `${JSON.stringify({
      provider: { kind: 'mock' },
      ...(search === undefined ? {} : { search }),
    })}\n`,
    'utf8',
  )
  return cwd
}

async function main() {
  const repoRoot = process.cwd()
  const requests: URL[] = []
  const server = createServer((req, res) => {
    const request = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push(request)
    const [mode = '', resource = ''] = request.pathname
      .split('/')
      .filter(Boolean)

    const json = (value: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }

    if (resource === 'config') {
      if (mode === 'config-http') {
        res.statusCode = 503
        res.end('config unavailable')
        return
      }
      if (mode === 'config-bad-json') {
        res.setHeader('content-type', 'application/json')
        res.end('{not json')
        return
      }
      if (mode === 'config-bad-shape') {
        json({ version: 'fixture-version', engines: { nope: true } })
        return
      }
      if (mode === 'slow-config') {
        setTimeout(() => {
          if (!res.destroyed) {
            json({
              version: 'fixture-version',
              instance_name: 'Fixture SearXNG',
              engines: [],
            })
          }
        }, 300)
        return
      }
      json({
        version: '2026.7.26+fixture',
        instance_name: 'Fixture SearXNG',
        engines: [
          { name: 'bing', enabled: true },
          { name: 'duckduckgo', enabled: true },
          { name: 'brave', enabled: true },
        ],
      })
      return
    }

    if (resource !== 'search') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    if (mode === 'search-http') {
      res.statusCode = 502
      res.end('search unavailable')
      return
    }
    if (mode === 'search-bad-json') {
      res.setHeader('content-type', 'application/json')
      res.end('{not json')
      return
    }
    if (mode === 'search-bad-shape') {
      json({ results: { nope: true } })
      return
    }
    if (mode === 'slow-search') {
      setTimeout(() => {
        if (!res.destroyed) json({ results: [], unresponsive_engines: [] })
      }, 300)
      return
    }
    if (mode === 'empty') {
      json({ results: [], unresponsive_engines: [] })
      return
    }
    if (mode === 'upstream-down') {
      json({
        results: [],
        unresponsive_engines: [
          ['brave', 'too many requests'],
          ['google cse', 'timeout'],
          ['brave', 'too many requests'],
        ],
      })
      return
    }
    if (mode === 'partial') {
      json({
        results: [
          {
            title: 'Partial result',
            url: 'https://example.test/partial',
            engine: 'bing',
          },
        ],
        unresponsive_engines: [
          ['brave', 'too many requests'],
          ['google cse', 'timeout'],
        ],
      })
      return
    }

    json({
      results: [
        {
          title: 'Healthy result',
          url: 'https://example.test/healthy',
          engines: ['bing', 'duckduckgo'],
        },
        {
          title: 'Second result',
          url: 'https://example.test/second',
          engine: 'bing',
        },
      ],
      unresponsive_engines: [],
    })
  })

  const port = await listen(server)
  const origin = `http://127.0.0.1:${port}`
  const root = path.join(process.cwd(), '.bolo-tmp', 'search-doctor-test')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  const previousProvider = process.env.BOLO_PROVIDER

  try {
    process.env.BOLO_CONFIG_DIR = path.join(root, 'user')
    process.env.BOLO_PROVIDER = 'mock'

    // 1) The packages-first probe returns one bounded, structured report.
    const healthy = await probeSearxng(fixtureConfig(origin, 'healthy'), {
      query: 'bolo doctor smoke',
    })
    assert(healthy.ok && healthy.code === 'ok', `healthy probe: ${JSON.stringify(healthy)}`)
    assert(healthy.stage === 'complete', 'healthy probe reaches the complete stage')
    assert(healthy.version === '2026.7.26+fixture', 'reads version from /config')
    assert(healthy.instanceName === 'Fixture SearXNG', 'reads bounded instance name')
    assert(healthy.capabilities.configJson, 'reports config JSON capability')
    assert(healthy.capabilities.searchJson, 'reports search JSON capability')
    assert(healthy.configuredEngineCount === 3, 'reports configured engine count')
    assert(healthy.resultCount === 2, 'requires and counts valid smoke results')
    assert(
      healthy.workingEngines.join(',') === 'bing,duckduckgo',
      `working engines are cleaned and deduplicated: ${JSON.stringify(healthy.workingEngines)}`,
    )
    assert(healthy.unresponsiveEngines.length === 0, 'healthy probe has no outage tuples')
    assert(
      requests.some(
        (request) =>
          request.pathname === '/healthy/search' &&
          request.searchParams.get('q') === 'bolo doctor smoke' &&
          request.searchParams.get('format') === 'json',
      ),
      'probe performs an explicit JSON smoke query',
    )

    // 2) Partial success stays exit-success shaped; empty and full outage differ.
    const partial = await probeSearxng(fixtureConfig(origin, 'partial'))
    assert(
      partial.ok && partial.code === 'partial_success',
      `partial success stays healthy: ${JSON.stringify(partial)}`,
    )
    assert(partial.resultCount === 1, 'partial success preserves the valid result')
    assert(partial.workingEngines.includes('bing'), 'partial success names a working engine')
    assert(
      partial.unresponsiveEngines.some(
        (entry) => entry.engine === 'brave' && entry.reason === 'too many requests',
      ),
      'partial success also names unavailable engines',
    )

    const empty = await probeSearxng(fixtureConfig(origin, 'empty'))
    assert(
      !empty.ok && empty.code === 'empty_results' && empty.stage === 'complete',
      `legitimate empty results fail the deployment smoke distinctly: ${JSON.stringify(empty)}`,
    )

    const upstreamDown = await probeSearxng(
      fixtureConfig(origin, 'upstream-down'),
    )
    assert(
      !upstreamDown.ok &&
        upstreamDown.code === 'upstream_unavailable' &&
        upstreamDown.unresponsiveEngines.length === 2,
      `full upstream outage is deduplicated: ${JSON.stringify(upstreamDown)}`,
    )

    // 3) Every network/JSON stage has a stable machine code and stage.
    for (const [mode, code, stage] of [
      ['config-http', 'http_error', 'config'],
      ['config-bad-json', 'invalid_json', 'config'],
      ['config-bad-shape', 'invalid_response', 'config'],
      ['slow-config', 'timeout', 'config'],
      ['search-http', 'http_error', 'search'],
      ['search-bad-json', 'invalid_json', 'search'],
      ['search-bad-shape', 'invalid_response', 'search'],
      ['slow-search', 'timeout', 'search'],
    ] as const) {
      const report = await probeSearxng(
        fixtureConfig(
          origin,
          mode,
          mode.startsWith('slow-') ? 100 : 1_000,
        ),
      )
      assert(
        !report.ok && report.code === code && report.stage === stage,
        `${mode} => ${stage}/${code}: ${JSON.stringify(report)}`,
      )
      assert(
        JSON.stringify(report).length < 20_000,
        `${mode} report is bounded and does not expose a raw response`,
      )
    }

    // 4) CLI JSON is exactly one stdout payload and uses stable exit codes.
    const healthyCwd = await writeProject(root, 'healthy-project', {
      searxng: {
        baseUrl: `${origin}/healthy`,
        timeoutMs: 1_000,
        maxResults: 5,
      },
    })
    const configPath = path.join(healthyCwd, '.bolo', 'config.json')
    const configBefore = await fs.readFile(configPath, 'utf8')
    const jsonIo = collect()
    const healthyCode = await runSearchCli(['doctor', '--json'], {
      cwd: healthyCwd,
      writeOut: jsonIo.writeOut,
      writeErr: jsonIo.writeErr,
    })
    assert(healthyCode === 0, `healthy doctor exits 0: ${jsonIo.stderr()}`)
    assert(jsonIo.stderr() === '', `JSON mode keeps stderr clean: ${jsonIo.stderr()}`)
    const jsonReport = JSON.parse(jsonIo.stdout()) as Record<string, unknown>
    assert(jsonReport.ok === true && jsonReport.code === 'ok', 'JSON mode emits the probe report')
    assert(
      (jsonIo.stdout().match(/\n/g) ?? []).length === 1,
      `JSON mode emits one newline-terminated payload: ${JSON.stringify(jsonIo.stdout())}`,
    )
    assert(
      (await fs.readFile(configPath, 'utf8')) === configBefore,
      'doctor does not modify the project configuration',
    )

    const realCli = await runMainCli(
      repoRoot,
      healthyCwd,
      ['search', 'doctor', '--json'],
      {
        ...process.env,
        BOLO_CONFIG_DIR: process.env.BOLO_CONFIG_DIR,
        BOLO_PROVIDER: 'mock',
      },
    )
    assert(
      realCli.code === 0,
      `real CLI entrypoint preserves doctor --json and exits cleanly: code=${realCli.code} stdout=${realCli.stdout} stderr=${realCli.stderr}`,
    )
    assert(realCli.stderr === '', `real CLI JSON stderr stays clean: ${realCli.stderr}`)
    assert(
      (JSON.parse(realCli.stdout) as { code?: string }).code === 'ok',
      `real CLI entrypoint emits the doctor report: ${realCli.stdout}`,
    )

    const textIo = collect()
    const textCode = await runSearchCli(['doctor'], {
      cwd: healthyCwd,
      writeOut: textIo.writeOut,
      writeErr: textIo.writeErr,
    })
    assert(textCode === 0 && textIo.stderr() === '', 'healthy text doctor exits cleanly')
    assert(
      /2026\.7\.26\+fixture/.test(textIo.stdout()) &&
        /config-json.*search-json/i.test(textIo.stdout()) &&
        /bing.*duckduckgo/i.test(textIo.stdout()),
      `text report renders version, capabilities and working engines: ${textIo.stdout()}`,
    )

    for (const [mode, expectedCode, exitCode] of [
      ['partial', 'partial_success', 0],
      ['empty', 'empty_results', 1],
      ['upstream-down', 'upstream_unavailable', 1],
      ['search-bad-json', 'invalid_json', 1],
    ] as const) {
      const cwd = await writeProject(root, `${mode}-project`, {
        searxng: {
          baseUrl: `${origin}/${mode}`,
          timeoutMs: 1_000,
          maxResults: 5,
        },
      })
      const io = collect()
      const code = await runSearchCli(['doctor', '--json'], {
        cwd,
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      })
      const report = JSON.parse(io.stdout()) as { code?: string }
      assert(code === exitCode, `${mode} exits ${exitCode}, got ${code}`)
      assert(report.code === expectedCode, `${mode} JSON code is ${expectedCode}`)
      assert(io.stderr() === '', `${mode} JSON stderr stays clean`)
    }

    // 5) Missing/invalid configuration is usage/config exit 2 and never probes.
    const missingCwd = await writeProject(root, 'missing-project', undefined)
    const requestCountBeforeMissing = requests.length
    const missingIo = collect()
    const missingCode = await runSearchCli(['doctor', '--json'], {
      cwd: missingCwd,
      writeOut: missingIo.writeOut,
      writeErr: missingIo.writeErr,
    })
    assert(missingCode === 2, `missing config exits 2, got ${missingCode}`)
    assert(
      (JSON.parse(missingIo.stdout()) as { code?: string }).code === 'not_configured',
      'missing config has a stable machine code',
    )
    assert(missingIo.stderr() === '', 'missing config JSON keeps stderr clean')
    assert(requests.length === requestCountBeforeMissing, 'missing config performs no request')

    const invalidCwd = await writeProject(root, 'invalid-project', {
      searxng: { baseUrl: 'http://example.com' },
    })
    const invalidIo = collect()
    const invalidCode = await runSearchCli(['doctor', '--json'], {
      cwd: invalidCwd,
      writeOut: invalidIo.writeOut,
      writeErr: invalidIo.writeErr,
    })
    assert(invalidCode === 2, `invalid config exits 2, got ${invalidCode}`)
    assert(
      (JSON.parse(invalidIo.stdout()) as { code?: string }).code === 'invalid_config',
      'invalid config has a stable machine code',
    )
    assert(invalidIo.stderr() === '', 'invalid config JSON keeps stderr clean')

    // 6) Unknown doctor flags fail before network; status remains configuration-only.
    const requestCountBeforeUsage = requests.length
    const usageIo = collect()
    const usageCode = await runSearchCli(['doctor', '--json', '--unknown'], {
      cwd: healthyCwd,
      writeOut: usageIo.writeOut,
      writeErr: usageIo.writeErr,
    })
    assert(usageCode === 2, `unknown doctor option exits 2, got ${usageCode}`)
    assert(
      (JSON.parse(usageIo.stdout()) as { code?: string }).code === 'usage_error',
      'unknown doctor option has a machine-readable usage error',
    )
    assert(usageIo.stderr() === '', 'usage error JSON keeps stderr clean')
    assert(requests.length === requestCountBeforeUsage, 'invalid doctor usage performs no request')

    const requestCountBeforeStatus = requests.length
    const statusIo = collect()
    const statusCode = await runSearchCli(['status'], {
      cwd: healthyCwd,
      writeOut: statusIo.writeOut,
      writeErr: statusIo.writeErr,
    })
    assert(statusCode === 0, 'status still succeeds')
    assert(
      requests.length === requestCountBeforeStatus,
      'status remains configuration-only and never becomes an implicit doctor',
    )
  } finally {
    if (previousConfigDir === undefined) delete process.env.BOLO_CONFIG_DIR
    else process.env.BOLO_CONFIG_DIR = previousConfigDir
    if (previousProvider === undefined) delete process.env.BOLO_PROVIDER
    else process.env.BOLO_PROVIDER = previousProvider
    await close(server)
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log('PASS: search doctor')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
