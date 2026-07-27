/**
 * Explicit management commands for the optional Bolo-owned SearXNG Docker
 * setup. Docker remains external: this CLI never installs it and all process
 * calls are behind an injectable runner.
 */

import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import {
  DEFAULT_SEARXNG_SETUP_PORT,
  commitSearxngSearchConfig,
  createSearxngSetupPlan,
  getUserLayout,
  readSearxngSetup,
  removeSearxngSetupFiles,
  resolveSearxngSearchConfig,
  writeSearxngSetupFiles,
  type SearxngManagedSetup,
} from '../../config/src/index.ts'
import {
  probeSearxng,
  type SearxngDoctorReport,
} from '../../tools/src/index.ts'

export type DockerCommandResult = {
  code: number
  stdout: string
  stderr: string
}

export type SearxngDockerRunner = (
  args: readonly string[],
) => Promise<DockerCommandResult>

export type SearxngPortCheck = (
  port: number,
) => Promise<{ ok: true } | { ok: false; reason: string }>

export type SearxngSetupCliOptions = {
  layoutRoot?: string
  configPath?: string
  runDocker?: SearxngDockerRunner
  checkPort?: SearxngPortCheck
  probe?: (
    config: Parameters<typeof probeSearxng>[0],
  ) => Promise<SearxngDoctorReport>
  secretKey?: () => string
  sleep?: (ms: number) => Promise<void>
  maxProbeAttempts?: number
  writeOut?: (text: string) => void
  writeErr?: (text: string) => void
}

const MAX_LOG_OUTPUT = 24_000
const DEFAULT_LOG_TAIL = 200
const DEFAULT_PROBE_ATTEMPTS = 12

function usage(): string {
  return [
    'Usage: bolo search searxng <command>',
    '',
    '  setup [--port N]    create or start Bolo-managed local SearXNG',
    '  status [--json]     show Docker state without an upstream search',
    '  logs [--tail N]     show bounded managed SearXNG logs',
    '  stop                stop only the Bolo-managed SearXNG project',
    '',
    'Docker is optional and must already be installed. setup is the only',
    'command that creates files or starts a container.',
    '',
  ].join('\n')
}

function bounded(text: string, limit = 2_000): string {
  if (text.length <= limit) return text
  return text.slice(0, limit - 1) + '…'
}

function commandFailure(label: string, result: DockerCommandResult): string {
  const detail = bounded((result.stderr || result.stdout).trim())
  return label + ' failed' + (detail ? ': ' + detail : ' (exit ' + result.code + ')')
}

function defaultSecretKey(): string {
  return randomBytes(32).toString('base64url')
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const defaultCheckPort: SearxngPortCheck = async (port) =>
  await new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    server.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason:
          (error.code ? error.code + ': ' : '') +
          (error.message || 'could not bind loopback port'),
      })
    })
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error) {
          finish({
            ok: false,
            reason: error.message || 'could not release loopback port',
          })
          return
        }
        finish({ ok: true })
      })
    })
  })

const defaultDockerRunner: SearxngDockerRunner = async (args) =>
  await new Promise((resolve) => {
    execFile(
      'docker',
      [...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 512 * 1024,
      },
      (error, stdout, stderr) => {
        const rawCode = (
          error as (Error & { code?: number | string }) | null
        )?.code
        resolve({
          code: typeof rawCode === 'number' ? rawCode : error ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr:
            String(stderr ?? '') ||
            (error instanceof Error ? error.message : ''),
        })
      },
    )
  })

async function requireDocker(
  runDocker: SearxngDockerRunner,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const docker = await runDocker(['version', '--format', '{{.Server.Version}}'])
  if (docker.code !== 0 || !docker.stdout.trim()) {
    return { ok: false, reason: commandFailure('Docker', docker) }
  }
  const compose = await runDocker(['compose', 'version', '--short'])
  if (compose.code !== 0 || !compose.stdout.trim()) {
    return { ok: false, reason: commandFailure('Docker Compose', compose) }
  }
  return { ok: true }
}

function composeArgs(
  setup: SearxngManagedSetup,
  command: readonly string[],
): string[] {
  return [
    'compose',
    '--project-name',
    setup.projectName,
    '--file',
    setup.paths.composeFile,
    ...command,
  ]
}

function parsePort(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) return null
  return value
}

function parseSetupArgs(
  args: readonly string[],
): { ok: true; port?: number } | { ok: false; reason: string } {
  if (args.length === 0) return { ok: true }
  if (args.length !== 2 || args[0] !== '--port') {
    return { ok: false, reason: 'Usage: bolo search searxng setup [--port N]' }
  }
  const port = parsePort(args[1])
  if (port === null) {
    return { ok: false, reason: 'setup --port must be an integer from 1 to 65535' }
  }
  return { ok: true, port }
}

function parseLogsArgs(
  args: readonly string[],
): { ok: true; tail: number } | { ok: false; reason: string } {
  if (args.length === 0) return { ok: true, tail: DEFAULT_LOG_TAIL }
  if (args.length !== 2 || args[0] !== '--tail') {
    return { ok: false, reason: 'Usage: bolo search searxng logs [--tail N]' }
  }
  const tail = parsePort(args[1])
  if (tail === null || tail > 1_000) {
    return { ok: false, reason: 'logs --tail must be an integer from 1 to 1000' }
  }
  return { ok: true, tail }
}

function parseComposeState(stdout: string): string {
  const text = stdout.trim()
  if (!text) return 'stopped'
  let records: unknown[] = []
  try {
    const parsed = JSON.parse(text) as unknown
    records = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    try {
      records = text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
    } catch {
      return 'unknown'
    }
  }
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const value = record as Record<string, unknown>
    if (value.Service !== 'searxng' && value.service !== 'searxng') continue
    const state = String(value.State ?? value.state ?? value.Status ?? value.status ?? '')
      .trim()
      .toLowerCase()
    if (state.includes('running') || state.startsWith('up')) return 'running'
    if (state) return state
  }
  return 'stopped'
}

async function probeUntilReady(
  setup: SearxngManagedSetup,
  options: SearxngSetupCliOptions,
): Promise<SearxngDoctorReport> {
  const resolved = resolveSearxngSearchConfig({
    enabled: true,
    baseUrl: setup.baseUrl,
    timeoutMs: 3_000,
    maxResults: 5,
    safeSearch: 1,
  })
  if (resolved.status !== 'enabled') {
    throw new Error('internal error: generated SearXNG endpoint is invalid')
  }
  const probe = options.probe ?? probeSearxng
  const attempts = Math.max(
    1,
    Math.min(30, Math.floor(options.maxProbeAttempts ?? DEFAULT_PROBE_ATTEMPTS)),
  )
  const sleep = options.sleep ?? defaultSleep
  let report: SearxngDoctorReport | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    report = await probe(resolved.config)
    if (report.ok) return report
    if (attempt + 1 < attempts) await sleep(1_000)
  }
  if (!report) throw new Error('SearXNG probe did not return a report')
  return report
}

async function rollbackFreshSetup(
  setup: SearxngManagedSetup,
  runDocker: SearxngDockerRunner,
): Promise<string | undefined> {
  const down = await runDocker(composeArgs(setup, ['down']))
  if (down.code !== 0) {
    return commandFailure('SearXNG rollback', down)
  }
  try {
    await removeSearxngSetupFiles(setup.paths)
  } catch (error) {
    return (
      'SearXNG rollback could not remove fresh files: ' +
      (error instanceof Error ? error.message : String(error))
    )
  }
  return undefined
}

function formatManagedProblem(
  status: Awaited<ReturnType<typeof readSearxngSetup>>,
): string {
  if (status.status === 'missing') {
    return 'No Bolo-managed SearXNG setup exists. Run: bolo search searxng setup'
  }
  if (status.status === 'ready') return 'Bolo-managed SearXNG setup is ready'
  return status.reason
}

async function runSetup(
  args: readonly string[],
  options: SearxngSetupCliOptions,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): Promise<number> {
  const parsed = parseSetupArgs(args)
  if (!parsed.ok) {
    writeErr(parsed.reason + '\n')
    return 2
  }
  const layoutRoot = options.layoutRoot ?? getUserLayout().root
  const existing = await readSearxngSetup(layoutRoot)
  if (existing.status === 'unmanaged' || existing.status === 'invalid') {
    writeErr(existing.reason + '\n')
    return 2
  }
  if (
    existing.status === 'ready' &&
    parsed.port !== undefined &&
    parsed.port !== existing.setup.port
  ) {
    writeErr(
      'Managed SearXNG already uses port ' +
        existing.setup.port +
        '; refusing to rewrite it\n',
    )
    return 2
  }
  if (existing.status === 'missing') {
    const port = parsed.port ?? DEFAULT_SEARXNG_SETUP_PORT
    const portCheck = await (options.checkPort ?? defaultCheckPort)(port)
    if (!portCheck.ok) {
      writeErr(
        'Port ' + port + ' is unavailable for local SearXNG: ' + portCheck.reason + '\n',
      )
      return 2
    }
  }

  const runDocker = options.runDocker ?? defaultDockerRunner
  const docker = await requireDocker(runDocker)
  if (!docker.ok) {
    writeErr(docker.reason + '\n')
    return 2
  }

  let setup: SearxngManagedSetup
  let fresh = false
  if (existing.status === 'ready') {
    setup = existing.setup
  } else {
    const plan = createSearxngSetupPlan({
      layoutRoot,
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      secretKey: (options.secretKey ?? defaultSecretKey)(),
    })
    try {
      await writeSearxngSetupFiles(plan)
    } catch (error) {
      try {
        await removeSearxngSetupFiles(plan.paths)
      } catch {
        // Original write error is more useful; no Docker process exists yet.
      }
      writeErr(
        'Could not create managed SearXNG files: ' +
          (error instanceof Error ? error.message : String(error)) +
          '\n',
      )
      return 1
    }
    setup = {
      version: plan.version,
      port: plan.port,
      baseUrl: plan.baseUrl,
      image: plan.image,
      projectName: plan.projectName,
      paths: plan.paths,
    }
    fresh = true
  }

  const up = await runDocker(
    composeArgs(setup, ['up', '--detach', '--pull', 'missing']),
  )
  if (up.code !== 0) {
    const rollback = fresh ? await rollbackFreshSetup(setup, runDocker) : undefined
    writeErr(
      commandFailure('SearXNG setup', up) +
        (rollback ? '; ' + rollback : '') +
        '\n',
    )
    return 1
  }

  let report: SearxngDoctorReport
  try {
    report = await probeUntilReady(setup, options)
  } catch (error) {
    const rollback = fresh ? await rollbackFreshSetup(setup, runDocker) : undefined
    writeErr(
      'SearXNG smoke failed: ' +
        (error instanceof Error ? error.message : String(error)) +
        (rollback ? '; ' + rollback : '') +
        '\n',
    )
    return 1
  }
  if (!report.ok) {
    const rollback = fresh ? await rollbackFreshSetup(setup, runDocker) : undefined
    writeErr(
      'SearXNG smoke failed (' +
        report.code +
        ')' +
        (report.detail ? ': ' + bounded(report.detail) : '') +
        (rollback ? '; ' + rollback : '') +
        '\n',
    )
    return 1
  }

  const configPath = options.configPath ?? getUserLayout().configJson
  const committed = await commitSearxngSearchConfig({
    configPath,
    searxng: { enabled: true, baseUrl: setup.baseUrl },
  })
  if (!committed.ok) {
    const rollback = fresh ? await rollbackFreshSetup(setup, runDocker) : undefined
    writeErr(
      'SearXNG is running but Bolo config was not changed: ' +
        committed.reason +
        (rollback ? '; ' + rollback : '') +
        '\n',
    )
    return 1
  }

  writeOut(
    [
      'SearXNG setup complete',
      'endpoint: ' + setup.baseUrl,
      'doctor: ' + report.code + ' (' + report.resultCount + ' valid results)',
      'config: ' + committed.configPath,
      '',
    ].join('\n'),
  )
  return 0
}

async function requireManaged(
  layoutRoot: string,
  writeErr: (text: string) => void,
): Promise<SearxngManagedSetup | undefined> {
  const result = await readSearxngSetup(layoutRoot)
  if (result.status === 'ready') return result.setup
  writeErr(formatManagedProblem(result) + '\n')
  return undefined
}

async function runStatus(
  args: readonly string[],
  options: SearxngSetupCliOptions,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    writeErr('Usage: bolo search searxng status [--json]\n')
    return 2
  }
  const json = args[0] === '--json'
  const layoutRoot = options.layoutRoot ?? getUserLayout().root
  const setup = await requireManaged(layoutRoot, writeErr)
  if (!setup) return 2
  const runDocker = options.runDocker ?? defaultDockerRunner
  const docker = await requireDocker(runDocker)
  if (!docker.ok) {
    writeErr(docker.reason + '\n')
    return 2
  }
  const ps = await runDocker(composeArgs(setup, ['ps', '--all', '--format', 'json']))
  if (ps.code !== 0) {
    writeErr(commandFailure('SearXNG status', ps) + '\n')
    return 1
  }
  const report = {
    ok: true,
    code: 'ok',
    state: parseComposeState(ps.stdout),
    baseUrl: setup.baseUrl,
    port: setup.port,
    image: setup.image,
  }
  if (json) {
    writeOut(JSON.stringify(report) + '\n')
  } else {
    writeOut(
      [
        'SearXNG managed status: ' + report.state,
        'endpoint: ' + report.baseUrl,
        'port: ' + report.port,
        'image: ' + report.image,
        '',
      ].join('\n'),
    )
  }
  return 0
}

async function runLogs(
  args: readonly string[],
  options: SearxngSetupCliOptions,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): Promise<number> {
  const parsed = parseLogsArgs(args)
  if (!parsed.ok) {
    writeErr(parsed.reason + '\n')
    return 2
  }
  const layoutRoot = options.layoutRoot ?? getUserLayout().root
  const setup = await requireManaged(layoutRoot, writeErr)
  if (!setup) return 2
  const runDocker = options.runDocker ?? defaultDockerRunner
  const docker = await requireDocker(runDocker)
  if (!docker.ok) {
    writeErr(docker.reason + '\n')
    return 2
  }
  const logs = await runDocker(
    composeArgs(setup, [
      'logs',
      '--no-color',
      '--tail',
      String(parsed.tail),
      'searxng',
    ]),
  )
  if (logs.code !== 0) {
    writeErr(commandFailure('SearXNG logs', logs) + '\n')
    return 1
  }
  writeOut(bounded(logs.stdout || logs.stderr, MAX_LOG_OUTPUT) + '\n')
  return 0
}

async function runStop(
  args: readonly string[],
  options: SearxngSetupCliOptions,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): Promise<number> {
  if (args.length !== 0) {
    writeErr('Usage: bolo search searxng stop\n')
    return 2
  }
  const layoutRoot = options.layoutRoot ?? getUserLayout().root
  const setup = await requireManaged(layoutRoot, writeErr)
  if (!setup) return 2
  const runDocker = options.runDocker ?? defaultDockerRunner
  const docker = await requireDocker(runDocker)
  if (!docker.ok) {
    writeErr(docker.reason + '\n')
    return 2
  }
  const down = await runDocker(composeArgs(setup, ['down']))
  if (down.code !== 0) {
    writeErr(commandFailure('SearXNG stop', down) + '\n')
    return 1
  }
  writeOut(
    'SearXNG stopped. Managed files and Bolo config remain; run setup to start it again.\n',
  )
  return 0
}

export async function runSearxngSetupCli(
  argv: readonly string[],
  options: SearxngSetupCliOptions = {},
): Promise<number> {
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text))
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text))
  const command = (argv[0] ?? '').trim().toLowerCase()
  const args = argv.slice(1)
  if (command === 'setup') return await runSetup(args, options, writeOut, writeErr)
  if (command === 'status') return await runStatus(args, options, writeOut, writeErr)
  if (command === 'logs') return await runLogs(args, options, writeOut, writeErr)
  if (command === 'stop') return await runStop(args, options, writeOut, writeErr)
  writeErr(usage())
  return 2
}
