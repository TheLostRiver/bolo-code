/**
 * CLI zero-step first run:
 * - normal startup materializes user state, never project scaffolding
 * - new sessions use the user workspace bucket
 * - legacy project/user sessions remain discoverable
 * - read-only loading has no filesystem side effects
 * - explicit project init is idempotent and non-overwriting
 */

import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  getProjectBoloDir,
  getUserLayout,
  getWorkspaceSessionsDir,
  loadWorkspace,
  writeJsonFile,
} from '../packages/config/src/index.ts'
import {
  createSession,
  getSessionPersistMeta,
  listWorkspaceSessions,
  loadSession,
  resolveSubagentTranscriptPath,
  runToolUse,
  saveSession,
} from '../packages/core/src/index.ts'
import { buildTool } from '../packages/tools/src/index.ts'
import {
  runInitCli,
  runNewSessionCli,
} from '../packages/cli/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const execFileAsync = promisify(execFile)

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-first-run-'))
  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  const previousProvider = process.env.BOLO_PROVIDER

  try {
    process.env.BOLO_PROVIDER = 'mock'

    // Read-only workspace loading must not materialize user or project state.
    const readOnlyRoot = path.join(tempRoot, 'read-only')
    const readOnlyCwd = path.join(readOnlyRoot, 'workspace')
    const readOnlyUser = path.join(readOnlyRoot, 'user')
    await fs.mkdir(readOnlyCwd, { recursive: true })
    process.env.BOLO_CONFIG_DIR = readOnlyUser
    await loadWorkspace({
      cwd: readOnlyCwd,
      materializeUserState: false,
      loadPlugins: false,
    })
    assert(!(await exists(readOnlyUser)), 'read-only load created user state')
    assert(
      !(await exists(getProjectBoloDir(readOnlyCwd))),
      'read-only load created project .bolo',
    )

    // Normal first run creates only user defaults and persists under the
    // workspace-specific user session bucket.
    const freshRoot = path.join(tempRoot, 'fresh')
    const freshCwd = path.join(freshRoot, 'workspace')
    const freshUser = path.join(freshRoot, 'user')
    await fs.mkdir(freshCwd, { recursive: true })
    process.env.BOLO_CONFIG_DIR = freshUser
    const firstRun = await runNewSessionCli({
      cwd: freshCwd,
      prompt: 'hello',
      print: true,
      forceMock: true,
      isTty: false,
      skipBanner: true,
      writeOut: () => {},
      writeErr: () => {},
    })
    assert(await exists(getUserLayout().configJson), 'user config not created')
    assert(
      !(await exists(getProjectBoloDir(freshCwd))),
      'normal first run created project .bolo',
    )
    const workspaceSessions = getWorkspaceSessionsDir(freshCwd)
    assert(
      await exists(
        path.join(workspaceSessions, `${firstRun.session.id}.jsonl`),
      ),
      'new transcript not written to user workspace bucket',
    )
    assert(
      getSessionPersistMeta(firstRun.session)?.scope === 'workspace',
      'new CLI session did not use workspace persistence scope',
    )
    assert(
      resolveSubagentTranscriptPath({
        cwd: freshCwd,
        agentId: 'child',
        writeTranscript: true,
      }) === path.join(workspaceSessions, 'agent-child.jsonl'),
      'subagent transcript did not use workspace persistence',
    )

    const spillOutput = 'spill'.repeat(40)
    const spillTool = buildTool({
      name: 'FirstRunSpill',
      description: 'Emit a long result for first-run persistence testing.',
      requiresPermission: false,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      inputJSONSchema: { type: 'object', properties: {} },
      async call() {
        return { ok: true, output: spillOutput }
      },
    })
    const spillResult = await runToolUse(
      { id: 'spill/first-run', name: spillTool.name, input: {} },
      {
        sessionId: firstRun.session.id,
        cwd: freshCwd,
        hooks: {},
        permissionMode: 'bypassPermissions',
        askPermission: async () => 'allow',
        tools: [spillTool],
        maxToolResultChars: 50,
      },
    )
    const spillRef = spillResult.presentation.fullResult
    assert(spillRef, 'tool-result spill reference missing')
    const spillPath = spillRef.path
    const spillRoot = path.join(workspaceSessions, 'tool-results')
    const spillRelative = path.relative(spillRoot, spillPath)
    assert(
      spillRelative &&
        !spillRelative.startsWith('..') &&
        !path.isAbsolute(spillRelative),
      'tool-result spill escaped workspace session store',
    )
    assert(await exists(spillPath), 'tool-result spill not written to user workspace')
    assert(
      (await fs.readFile(spillPath, 'utf8')) === spillOutput,
      'tool-result spill content changed',
    )
    assert(
      spillResult.toolResultMessage.content.includes(spillPath),
      'truncated tool result did not report workspace spill path',
    )
    assert(
      !(await exists(getProjectBoloDir(freshCwd))),
      'tool-result spill created project .bolo',
    )

    // Existing project config is loaded without scaffolding sibling dirs.
    const configuredRoot = path.join(tempRoot, 'configured')
    const configuredCwd = path.join(configuredRoot, 'workspace')
    const configuredUser = path.join(configuredRoot, 'user')
    const configuredProject = getProjectBoloDir(configuredCwd)
    await fs.mkdir(configuredProject, { recursive: true })
    await writeJsonFile(path.join(configuredProject, 'config.json'), {
      provider: { model: 'existing-project-model' },
    })
    process.env.BOLO_CONFIG_DIR = configuredUser
    const configured = await loadWorkspace({
      cwd: configuredCwd,
      materializeUserState: false,
    })
    assert(
      configured.config.provider?.model === 'existing-project-model',
      'existing project config was not loaded',
    )
    assert(
      !(await exists(path.join(configuredProject, 'sessions'))),
      'loading existing project config scaffolded sessions',
    )
    assert(
      !(await exists(path.join(configuredProject, 'plugins'))),
      'loading existing project config scaffolded plugins',
    )

    // New workspace sessions, legacy project sessions, and cwd-matching legacy
    // user sessions are all discoverable without migration.
    const compatRoot = path.join(tempRoot, 'compat')
    const compatCwd = path.join(compatRoot, 'workspace')
    const compatUser = path.join(compatRoot, 'user')
    const legacyProjectSessions = path.join(
      getProjectBoloDir(compatCwd),
      'sessions',
    )
    await fs.mkdir(compatCwd, { recursive: true })
    process.env.BOLO_CONFIG_DIR = compatUser

    const workspaceSession = await createSession({
      cwd: compatCwd,
      sessionId: 'sess_workspace_new',
      systemPrompt: false,
    })
    workspaceSession.messages.push({ role: 'user', content: 'workspace new' })
    await saveSession(workspaceSession, { scope: 'workspace' })

    const legacyProjectSession = await createSession({
      cwd: compatCwd,
      sessionId: 'sess_project_legacy',
      systemPrompt: false,
    })
    legacyProjectSession.messages.push({
      role: 'user',
      content: 'project legacy',
    })
    await saveSession(legacyProjectSession, {
      sessionsDir: legacyProjectSessions,
    })

    const legacyUserSession = await createSession({
      cwd: compatCwd,
      sessionId: 'sess_user_legacy',
      systemPrompt: false,
    })
    legacyUserSession.messages.push({ role: 'user', content: 'user legacy' })
    await saveSession(legacyUserSession, { scope: 'user' })

    const otherWorkspaceSession = await createSession({
      cwd: path.join(compatRoot, 'other-workspace'),
      sessionId: 'sess_other_workspace',
      systemPrompt: false,
    })
    otherWorkspaceSession.messages.push({ role: 'user', content: 'other' })
    await saveSession(otherWorkspaceSession, { scope: 'user' })

    const listed = await listWorkspaceSessions({ cwd: compatCwd })
    const listedIds = new Set(listed.map((item) => item.id))
    assert(listedIds.has('sess_workspace_new'), 'new workspace session missing')
    assert(listedIds.has('sess_project_legacy'), 'legacy project session missing')
    assert(listedIds.has('sess_user_legacy'), 'legacy user session missing')
    assert(
      !listedIds.has('sess_other_workspace'),
      'unrelated legacy user session leaked into workspace list',
    )

    const loadedWorkspace = await loadSession('sess_workspace_new', {
      cwd: compatCwd,
    })
    assert(
      loadedWorkspace.path.startsWith(getWorkspaceSessionsDir(compatCwd)),
      'workspace session lookup did not prefer workspace bucket',
    )
    const loadedProject = await loadSession('sess_project_legacy', {
      cwd: compatCwd,
    })
    assert(
      loadedProject.snapshot.messages[0]?.content === 'project legacy',
      'legacy project session no longer resumes',
    )

    // Invalid user state must fail before touching the project directory.
    const invalidRoot = path.join(tempRoot, 'invalid-user')
    const invalidCwd = path.join(invalidRoot, 'workspace')
    const invalidUser = path.join(invalidRoot, 'user-is-a-file')
    await fs.mkdir(invalidCwd, { recursive: true })
    await fs.mkdir(invalidRoot, { recursive: true })
    await fs.writeFile(invalidUser, 'not a directory', 'utf8')
    process.env.BOLO_CONFIG_DIR = invalidUser
    let materializeFailed = false
    try {
      await loadWorkspace({
        cwd: invalidCwd,
        materializeUserState: true,
      })
    } catch {
      materializeFailed = true
    }
    assert(materializeFailed, 'invalid user state did not fail startup')
    assert(
      !(await exists(getProjectBoloDir(invalidCwd))),
      'failed user materialization touched project .bolo',
    )

    // The installed command shape must dispatch init before generic prompt
    // parsing. Running the real TypeScript entry catches accidental fallthrough
    // that a direct runInitCli call cannot.
    const cliProcessRoot = path.join(tempRoot, 'init-process')
    const cliProcessCwd = path.join(cliProcessRoot, 'workspace')
    const cliProcessUser = path.join(cliProcessRoot, 'user')
    await fs.mkdir(cliProcessCwd, { recursive: true })
    const cliProcess = await execFileAsync(
      process.execPath,
      [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('packages/cli/src/main.ts'),
        'init',
        '--cwd',
        cliProcessCwd,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOLO_CONFIG_DIR: cliProcessUser,
          BOLO_PROVIDER: 'mock',
        },
        windowsHide: true,
      },
    )
    assert(
      cliProcess.stdout.includes(`project layout: ${getProjectBoloDir(cliProcessCwd)}`),
      'real CLI init did not report the project target',
    )
    assert(cliProcess.stderr === '', 'real CLI init wrote unexpected stderr')
    assert(
      await exists(path.join(getProjectBoloDir(cliProcessCwd), 'config.json')),
      'real CLI init fell through instead of creating project config',
    )
    assert(
      !(await exists(cliProcessUser)),
      'project CLI init unexpectedly materialized user state',
    )

    // Project init is explicit, idempotent, and never overwrites config.
    const initRoot = path.join(tempRoot, 'init')
    const initCwd = path.join(initRoot, 'workspace')
    const initUser = path.join(initRoot, 'user')
    await fs.mkdir(initCwd, { recursive: true })
    process.env.BOLO_CONFIG_DIR = initUser
    const initOut: string[] = []
    const firstInit = await runInitCli(
      ['--project', '--cwd', initCwd],
      {
        writeOut: (text) => initOut.push(text),
        writeErr: () => {},
      },
    )
    assert(firstInit.exitCode === 0, 'project init failed')
    const initConfig = path.join(getProjectBoloDir(initCwd), 'config.json')
    assert(await exists(initConfig), 'project init did not create config')
    await fs.writeFile(initConfig, '{"sentinel":true}\n', 'utf8')
    const secondInit = await runInitCli(
      ['--project', '--cwd', initCwd],
      {
        writeOut: (text) => initOut.push(text),
        writeErr: () => {},
      },
    )
    assert(secondInit.exitCode === 0, 'idempotent project init failed')
    assert(
      (await fs.readFile(initConfig, 'utf8')) === '{"sentinel":true}\n',
      'project init overwrote existing config',
    )
    assert(
      initOut.join('').includes(getProjectBoloDir(initCwd)),
      'project init did not report its target',
    )
  } finally {
    if (previousConfigDir === undefined) delete process.env.BOLO_CONFIG_DIR
    else process.env.BOLO_CONFIG_DIR = previousConfigDir
    if (previousProvider === undefined) delete process.env.BOLO_PROVIDER
    else process.env.BOLO_PROVIDER = previousProvider
    await fs.rm(tempRoot, { recursive: true, force: true })
  }

  console.log('PASS: test-cli-first-run')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
