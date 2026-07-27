/**
 * Explicit Bolo layout scaffolding.
 *
 * Normal startup already materializes user state and never creates project
 * `.bolo`. This command exists only for users who deliberately want templates.
 */

import path from 'node:path'
import {
  ensureProjectLayout,
  ensureUserLayout,
  type EnsureLayoutResult,
} from '../../config/src/index.ts'

export type InitCliOptions = {
  writeOut?: (text: string) => void
  writeErr?: (text: string) => void
}

export type InitCliResult = {
  exitCode: number
  scope?: 'project' | 'user'
  root?: string
  created?: string[]
}

function formatInitHelp(): string {
  return `Usage:
  bolo init [--project] [--cwd <dir>]
  bolo init --user

Normal \`bolo\` startup needs no init. Project init is explicit, idempotent,
and never overwrites existing files.
`
}

function parseInitArgs(argv: string[]): {
  help: boolean
  scope: 'project' | 'user'
  cwd: string
} {
  let project = false
  let user = false
  let help = false
  let cwd = process.cwd()

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--project') {
      project = true
      continue
    }
    if (arg === '--user') {
      user = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--cwd') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) {
        throw new Error('missing value after --cwd')
      }
      cwd = value
      index++
      continue
    }
    if (arg.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length)
      if (!value) throw new Error('missing value after --cwd=')
      cwd = value
      continue
    }
    throw new Error(`unknown init option: ${arg}`)
  }

  if (project && user) {
    throw new Error('init accepts either --project or --user, not both')
  }
  return {
    help,
    scope: user ? 'user' : 'project',
    cwd: path.resolve(cwd),
  }
}

function formatInitResult(
  scope: 'project' | 'user',
  ensured: EnsureLayoutResult,
): string {
  const lines = [
    `Bolo ${scope} layout: ${ensured.layout.root}`,
  ]
  if (ensured.created.length === 0) {
    lines.push('  no files created (already initialized)')
  } else {
    lines.push(`  created ${ensured.created.length} file(s):`)
    for (const filePath of ensured.created) {
      lines.push(`  + ${filePath}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export async function runInitCli(
  argv: string[],
  options: InitCliOptions = {},
): Promise<InitCliResult> {
  const writeOut = options.writeOut ?? ((text) => process.stdout.write(text))
  const writeErr = options.writeErr ?? ((text) => process.stderr.write(text))

  let args: ReturnType<typeof parseInitArgs>
  try {
    args = parseInitArgs(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeErr(`error: ${message}\n\n${formatInitHelp()}`)
    return { exitCode: 2 }
  }

  if (args.help) {
    writeOut(formatInitHelp())
    return { exitCode: 0, scope: args.scope }
  }

  try {
    const ensured =
      args.scope === 'user'
        ? await ensureUserLayout({ writeDefaults: true })
        : await ensureProjectLayout(args.cwd, { writeDefaults: true })
    writeOut(formatInitResult(args.scope, ensured))
    return {
      exitCode: 0,
      scope: args.scope,
      root: ensured.layout.root,
      created: [...ensured.created],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeErr(`error: failed to initialize ${args.scope} layout: ${message}\n`)
    return { exitCode: 1, scope: args.scope }
  }
}
