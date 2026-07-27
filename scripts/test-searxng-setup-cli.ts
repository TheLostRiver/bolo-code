/**
 * OI-07C2: Docker orchestration contract.
 *
 * A fake runner proves command order and rollback. This must never require a
 * Docker daemon in the default gate.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createSearxngSetupPlan,
  writeSearxngSetupFiles,
} from '../packages/config/src/index.ts'
import { runSearchCli } from '../packages/cli/src/searchCli.ts'
import {
  runSearxngSetupCli,
  type DockerCommandResult,
  type SearxngDockerRunner,
} from '../packages/cli/src/searxngSetupCli.ts'
import type { SearxngDoctorReport } from '../packages/tools/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('FAIL: ' + message)
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

function successReport(baseUrl: string): SearxngDoctorReport {
  return {
    ok: true,
    code: 'partial_success',
    stage: 'search',
    endpointUrl: baseUrl + '/search',
    query: 'searxng',
    version: 'fixture',
    capabilities: { configJson: true, searchJson: true },
    configuredEngineCount: 2,
    resultCount: 1,
    workingEngines: ['fixture'],
    unresponsiveEngines: [{ engine: 'other', reason: 'fixture warning' }],
  }
}

function failureReport(baseUrl: string): SearxngDoctorReport {
  return {
    ok: false,
    code: 'empty_results',
    stage: 'search',
    endpointUrl: baseUrl + '/search',
    query: 'searxng',
    capabilities: { configJson: true, searchJson: true },
    configuredEngineCount: 2,
    resultCount: 0,
    workingEngines: [],
    unresponsiveEngines: [],
    detail: 'fixture has no result',
  }
}

function runner(
  calls: string[][],
  overrides: Record<string, DockerCommandResult> = {},
): SearxngDockerRunner {
  return async (args) => {
    const copy = [...args]
    calls.push(copy)
    const key = copy.join(' ')
    if (overrides[key]) return overrides[key]!
    if (copy[0] === 'version') {
      return { code: 0, stdout: '29.4.3\n', stderr: '' }
    }
    if (copy[0] === 'compose' && copy.includes('version')) {
      return { code: 0, stdout: '5.1.3\n', stderr: '' }
    }
    if (copy.includes('ps')) {
      return {
        code: 0,
        stdout: '[{"Service":"searxng","State":"running"}]\n',
        stderr: '',
      }
    }
    if (copy.includes('logs')) {
      return { code: 0, stdout: 'fixture log line\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function includesCall(calls: readonly string[][], expected: readonly string[]) {
  return calls.some(
    (actual) =>
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
  )
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'searxng-setup-cli-test')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  try {
    // Fresh setup: doctor precedes config commit and the secret stays private.
    {
      const scope = path.join(root, 'success')
      const layoutRoot = path.join(scope, 'user')
      const configPath = path.join(layoutRoot, 'config.json')
      await fs.mkdir(layoutRoot, { recursive: true })
      const before = [
        '{',
        '  // keep this note',
        '  "provider": { "kind": "mock" }',
        '}',
        '',
      ].join('\n')
      await fs.writeFile(configPath, before, 'utf8')
      const calls: string[][] = []
      let configWasUnchangedDuringProbe = false
      const io = collect()
      const code = await runSearxngSetupCli(['setup', '--port', '8892'], {
        layoutRoot,
        configPath,
        runDocker: runner(calls),
        checkPort: async () => ({ ok: true }),
        secretKey: () => 'B'.repeat(43),
        maxProbeAttempts: 1,
        sleep: async () => {},
        probe: async (config) => {
          configWasUnchangedDuringProbe =
            (await fs.readFile(configPath, 'utf8')) === before
          return successReport(config.baseUrl)
        },
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      })
      assert(code === 0, 'fresh setup exits 0: ' + io.stderr())
      assert(io.stderr() === '', 'successful setup writes no stderr')
      assert(configWasUnchangedDuringProbe, 'doctor runs before config commit')
      assert(
        includesCall(calls, ['version', '--format', '{{.Server.Version}}']) &&
          includesCall(calls, ['compose', 'version', '--short']),
        'setup verifies Docker and Compose before mutating files',
      )
      const up = calls.find((args) => args.includes('up'))
      assert(
        !!up &&
          up.includes('--project-name') &&
          up.includes('bolo-searxng') &&
          up.includes('--detach') &&
          up.includes('--pull') &&
          up.includes('missing'),
        'setup starts only the isolated Bolo compose project',
      )
      const settings = await fs.readFile(
        path.join(layoutRoot, 'searxng', 'config', 'settings.yml'),
        'utf8',
      )
      assert(settings.includes('secret_key: "BBBB'), 'setup writes its generated secret')
      const config = await fs.readFile(configPath, 'utf8')
      assert(
        config.includes('// keep this note') &&
          config.includes('http://127.0.0.1:8892'),
        'successful smoke atomically commits the local endpoint',
      )
      const manifest = await fs.readFile(
        path.join(layoutRoot, 'searxng', 'bolo-managed.json'),
        'utf8',
      )
      assert(
        !io.stdout().includes('BBBB') &&
          !io.stderr().includes('BBBB') &&
          !manifest.includes('BBBB'),
        'setup never emits or persists the secret outside settings.yml',
      )
    }

    // A failed smoke rolls back only fresh Bolo-owned files and config.
    {
      const scope = path.join(root, 'smoke-failure')
      const layoutRoot = path.join(scope, 'user')
      const configPath = path.join(layoutRoot, 'config.json')
      await fs.mkdir(layoutRoot, { recursive: true })
      const before = '{"provider":{"kind":"mock"}}\n'
      await fs.writeFile(configPath, before, 'utf8')
      const calls: string[][] = []
      const io = collect()
      const code = await runSearxngSetupCli(['setup', '--port', '8893'], {
        layoutRoot,
        configPath,
        runDocker: runner(calls),
        checkPort: async () => ({ ok: true }),
        secretKey: () => 'C'.repeat(43),
        maxProbeAttempts: 1,
        sleep: async () => {},
        probe: async (config) => failureReport(config.baseUrl),
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      })
      assert(code === 1, 'failed smoke exits 1')
      assert(
        (await fs.readFile(configPath, 'utf8')) === before,
        'failed smoke never changes Bolo config',
      )
      assert(
        calls.some((args) => args.includes('down')),
        'failed fresh setup runs compose down for its own project',
      )
      await fs.access(path.join(layoutRoot, 'searxng')).then(
        () => {
          throw new Error('FAIL: failed fresh setup leaves its managed directory')
        },
        (error: NodeJS.ErrnoException) => {
          assert(error.code === 'ENOENT', 'failed setup removes only fresh files')
        },
      )
      assert(
        !io.stderr().includes('CCCC'),
        'failed setup does not disclose the generated secret',
      )
    }

    // Missing Docker fails before any setup file or config write.
    {
      const scope = path.join(root, 'docker-missing')
      const layoutRoot = path.join(scope, 'user')
      const configPath = path.join(layoutRoot, 'config.json')
      await fs.mkdir(layoutRoot, { recursive: true })
      const before = '{}\n'
      await fs.writeFile(configPath, before, 'utf8')
      const calls: string[][] = []
      const io = collect()
      const code = await runSearxngSetupCli(['setup'], {
        layoutRoot,
        configPath,
        runDocker: runner(calls, {
          'version --format {{.Server.Version}}': {
            code: 1,
            stdout: '',
            stderr: 'docker not found',
          },
        }),
        checkPort: async () => ({ ok: true }),
        secretKey: () => 'D'.repeat(43),
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      })
      assert(code === 2, 'missing Docker is a setup prerequisite failure')
      assert(
        (await fs.readFile(configPath, 'utf8')) === before,
        'missing Docker leaves config unchanged',
      )
      await fs.access(path.join(layoutRoot, 'searxng')).then(
        () => {
          throw new Error('FAIL: missing Docker creates a managed directory')
        },
        (error: NodeJS.ErrnoException) => {
          assert(error.code === 'ENOENT', 'missing Docker has no filesystem side effect')
        },
      )
      assert(calls.length === 1, 'missing Docker stops before Compose')
    }

    // An unavailable or OS-reserved loopback port fails before Docker/files.
    {
      const layoutRoot = path.join(root, 'port-unavailable', 'user')
      const calls: string[][] = []
      const io = collect()
      const code = await runSearxngSetupCli(
        ['setup', '--port', '8896'],
        {
          layoutRoot,
          configPath: path.join(layoutRoot, 'config.json'),
          runDocker: runner(calls),
          checkPort: async () => ({
            ok: false,
            reason: 'listen EACCES (Windows excluded port range)',
          }),
          secretKey: () => 'H'.repeat(43),
          maxProbeAttempts: 1,
          probe: async (config) => successReport(config.baseUrl),
          writeOut: io.writeOut,
          writeErr: io.writeErr,
        },
      )
      assert(code === 2, 'unavailable port is a prerequisite failure')
      assert(
        calls.length === 0 &&
          io.stderr().includes('8896') &&
          io.stderr().includes('EACCES'),
        'port preflight explains the port and runs before Docker',
      )
      assert(
        !(await fs
          .access(path.join(layoutRoot, 'searxng'))
          .then(() => true, () => false)),
        'port preflight failure creates no managed directory',
      )
    }

    // Management commands operate only on an existing Bolo manifest.
    {
      const scope = path.join(root, 'management')
      const layoutRoot = path.join(scope, 'user')
      const plan = createSearxngSetupPlan({
        layoutRoot,
        port: 8894,
        secretKey: 'E'.repeat(43),
      })
      await writeSearxngSetupFiles(plan)
      const calls: string[][] = []

      const statusIo = collect()
      const statusCode = await runSearxngSetupCli(['status', '--json'], {
        layoutRoot,
        runDocker: runner(calls),
        writeOut: statusIo.writeOut,
        writeErr: statusIo.writeErr,
      })
      assert(statusCode === 0 && statusIo.stderr() === '', 'managed status exits 0')
      const status = JSON.parse(statusIo.stdout()) as {
        state?: string
        baseUrl?: string
      }
      assert(
        status.state === 'running' &&
          status.baseUrl === 'http://127.0.0.1:8894',
        'status reports Docker state without probing the public upstream',
      )
      assert(
        calls.some((args) => args.includes('ps') && args.includes('--all')),
        'status uses compose ps on the managed project',
      )

      const logsIo = collect()
      const logsCode = await runSearxngSetupCli(['logs', '--tail', '7'], {
        layoutRoot,
        runDocker: runner(calls),
        writeOut: logsIo.writeOut,
        writeErr: logsIo.writeErr,
      })
      assert(
        logsCode === 0 &&
          logsIo.stdout().includes('fixture log line') &&
          calls.some(
            (args) =>
              args.includes('logs') &&
              args.includes('--no-color') &&
              args.includes('--tail') &&
              args.includes('7'),
          ),
        'logs uses a bounded non-following compose command',
      )

      const stopIo = collect()
      const stopCode = await runSearxngSetupCli(['stop'], {
        layoutRoot,
        runDocker: runner(calls),
        writeOut: stopIo.writeOut,
        writeErr: stopIo.writeErr,
      })
      assert(
        stopCode === 0 &&
          calls.some((args) => args.includes('down')) &&
          !stopIo.stderr(),
        'stop only downs the managed compose project',
      )
      assert(
        await fs
          .access(path.join(layoutRoot, 'searxng', 'bolo-managed.json'))
          .then(() => true, () => false),
        'stop keeps managed data and manifest for a later explicit setup',
      )

      const invalidIo = collect()
      const beforeInvalid = calls.length
      const invalidCode = await runSearxngSetupCli(['logs', '--tail', 'bad'], {
        layoutRoot,
        runDocker: runner(calls),
        writeOut: invalidIo.writeOut,
        writeErr: invalidIo.writeErr,
      })
      assert(
        invalidCode === 2 && calls.length === beforeInvalid,
        'invalid logs usage fails before Docker',
      )
    }

    // Existing user files without the Bolo manifest are never overwritten.
    {
      const layoutRoot = path.join(root, 'unmanaged', 'user')
      const unmanagedFile = path.join(layoutRoot, 'searxng', 'keep.txt')
      await fs.mkdir(path.dirname(unmanagedFile), { recursive: true })
      await fs.writeFile(unmanagedFile, 'user file\n', 'utf8')
      const calls: string[][] = []
      const io = collect()
      const code = await runSearxngSetupCli(['setup'], {
        layoutRoot,
        configPath: path.join(layoutRoot, 'config.json'),
        runDocker: runner(calls),
        secretKey: () => 'F'.repeat(43),
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      })
      assert(code === 2 && calls.length === 0, 'unmanaged setup root is refused')
      assert(
        (await fs.readFile(unmanagedFile, 'utf8')) === 'user file\n',
        'unmanaged files remain untouched',
      )
    }

    // The public dispatcher preserves status and routes the nested namespace.
    {
      const layoutRoot = path.join(root, 'dispatch', 'user')
      const plan = createSearxngSetupPlan({
        layoutRoot,
        port: 8895,
        secretKey: 'G'.repeat(43),
      })
      await writeSearxngSetupFiles(plan)
      const calls: string[][] = []
      const io = collect()
      const code = await runSearchCli(['searxng', 'status', '--json'], {
        searxngSetup: {
          layoutRoot,
          runDocker: runner(calls),
        },
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      })
      assert(
        code === 0 &&
          JSON.parse(io.stdout()).baseUrl === 'http://127.0.0.1:8895' &&
          calls.some((args) => args.includes('ps')),
        'search dispatch routes the explicit management namespace',
      )
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log('PASS: searxng setup cli')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
