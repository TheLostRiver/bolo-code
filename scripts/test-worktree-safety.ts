/**
 * Subagent worktree safety:
 * - clean worktree can be removed
 * - dirty/untracked/ignored worktree content is retained with a recoverable path
 * - nested cwd resolves from the repository root and cross-repo reuse is rejected
 * - requested isolation failure is fail-closed before model execution
 *
 * 运行：npx tsx scripts/test-worktree-safety.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  removeSubagentWorktree,
  tryCreateSubagentWorktree,
} from '../packages/core/src/worktree.ts'
import {
  runSubagent,
  type AgentDefinition,
} from '../packages/core/src/subagent.ts'
import type { QueryDeps } from '../packages/core/src/deps.ts'

const execFileAsync = promisify(execFile)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error('FAIL:', message)
    process.exit(1)
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
  })
  return result.stdout
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-worktree-safe-'))
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo, { recursive: true })
  await git(repo, 'init')
  await git(repo, 'config', 'user.email', 'bolo-test@example.invalid')
  await git(repo, 'config', 'user.name', 'Bolo Test')
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n', 'utf8')
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored-result.txt\n', 'utf8')
  await git(repo, 'add', 'tracked.txt', '.gitignore')
  await git(repo, 'commit', '-m', 'fixture')

  try {
    const clean = await tryCreateSubagentWorktree({
      parentCwd: repo,
      agentId: 'clean',
      force: true,
    })
    assert(clean.ok, `clean create: ${clean.ok ? 'ok' : clean.reason}`)
    const cleanResult = await removeSubagentWorktree({
      parentCwd: repo,
      worktreePath: clean.path,
    })
    assert(cleanResult.status === 'removed', `clean status=${cleanResult.status}`)
    assert(!(await pathExists(clean.path)), 'clean worktree path removed')

    const dirty = await tryCreateSubagentWorktree({
      parentCwd: repo,
      agentId: 'dirty',
      force: true,
    })
    assert(dirty.ok, `dirty create: ${dirty.ok ? 'ok' : dirty.reason}`)
    const artifact = path.join(dirty.path, 'agent-result.txt')
    await fs.writeFile(artifact, 'valuable untracked result\n', 'utf8')
    const dirtyResult = await removeSubagentWorktree({
      parentCwd: repo,
      worktreePath: dirty.path,
    })
    assert(dirtyResult.status === 'retained', `dirty status=${dirtyResult.status}`)
    assert(dirtyResult.dirty === true, 'dirty result flagged')
    assert(await pathExists(artifact), 'dirty artifact remains recoverable')
    assert(
      dirtyResult.path === path.resolve(dirty.path),
      'dirty retained absolute path returned',
    )

    const ignored = await tryCreateSubagentWorktree({
      parentCwd: repo,
      agentId: 'ignored',
      force: true,
    })
    assert(ignored.ok, `ignored create: ${ignored.ok ? 'ok' : ignored.reason}`)
    const ignoredArtifact = path.join(ignored.path, 'ignored-result.txt')
    await fs.writeFile(ignoredArtifact, 'ignored but valuable\n', 'utf8')
    const ignoredResult = await removeSubagentWorktree({
      parentCwd: repo,
      worktreePath: ignored.path,
    })
    assert(
      ignoredResult.status === 'retained',
      `ignored status=${ignoredResult.status}`,
    )
    assert(ignoredResult.dirty === true, 'ignored result flagged')
    assert(await pathExists(ignoredArtifact), 'ignored artifact remains recoverable')

    const nestedCwd = path.join(repo, 'nested')
    await fs.mkdir(nestedCwd, { recursive: true })
    const nested = await tryCreateSubagentWorktree({
      parentCwd: nestedCwd,
      agentId: 'nested',
      force: true,
    })
    assert(nested.ok, `nested create: ${nested.ok ? 'ok' : nested.reason}`)
    assert(nested.created, 'nested cwd creates a real worktree')
    assert(
      nested.path === path.resolve(repo, '..', '.bolo-worktrees', 'nested'),
      `nested worktree root=${nested.path}`,
    )
    const nestedResult = await removeSubagentWorktree({
      parentCwd: nestedCwd,
      worktreePath: nested.path,
    })
    assert(nestedResult.status === 'removed', 'nested worktree removed')

    const collision = await tryCreateSubagentWorktree({
      parentCwd: repo,
      agentId: 'collision',
      force: true,
    })
    assert(
      collision.ok,
      `collision fixture create: ${collision.ok ? 'ok' : collision.reason}`,
    )
    const secondRepo = path.join(root, 'repo-two')
    await fs.mkdir(secondRepo, { recursive: true })
    await git(secondRepo, 'init')
    await git(secondRepo, 'config', 'user.email', 'bolo-test@example.invalid')
    await git(secondRepo, 'config', 'user.name', 'Bolo Test')
    await fs.writeFile(path.join(secondRepo, 'tracked.txt'), 'second\n', 'utf8')
    await git(secondRepo, 'add', 'tracked.txt')
    await git(secondRepo, 'commit', '-m', 'fixture')
    const crossRepoReuse = await tryCreateSubagentWorktree({
      parentCwd: secondRepo,
      agentId: 'collision',
      force: true,
    })
    assert(
      !crossRepoReuse.ok,
      'existing worktree from another repository must not be reused',
    )
    const collisionResult = await removeSubagentWorktree({
      parentCwd: repo,
      worktreePath: collision.path,
    })
    assert(collisionResult.status === 'removed', 'collision fixture removed')

    let modelCalls = 0
    const deps: QueryDeps = {
      callModel: async function* () {
        modelCalls += 1
        yield { type: 'text_delta', text: 'must not run' }
        yield { type: 'done' }
      },
      prepareMessages: async ({ messages }) => ({ messages }),
      uuid: () => 'worktree_fail_closed',
    }
    const def: AgentDefinition = {
      agentType: 'general',
      description: 'worktree failure fixture',
      tools: [],
      systemPrompt: 'test',
    }
    const nonGit = path.join(root, 'not-a-repo')
    await fs.mkdir(nonGit, { recursive: true })
    const failedIsolation = await runSubagent({
      def,
      prompt: 'must not fall back',
      parentSessionId: 'parent',
      cwd: nonGit,
      hooks: {},
      deps,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      allTools: [],
      isolation: 'worktree',
      writeTranscript: false,
    })
    assert(failedIsolation.isError, 'failed isolation returns subagent error')
    assert(
      failedIsolation.terminal.reason === 'error',
      `failed isolation terminal=${failedIsolation.terminal.reason}`,
    )
    assert(modelCalls === 0, `failed isolation model calls=${modelCalls}`)
    assert(
      failedIsolation.summary.includes('worktree isolation failed'),
      `failed isolation summary=${failedIsolation.summary}`,
    )

    await git(repo, 'worktree', 'remove', '--force', dirty.path)
    await git(repo, 'worktree', 'remove', '--force', ignored.path)
    console.log('PASS test-worktree-safety')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
