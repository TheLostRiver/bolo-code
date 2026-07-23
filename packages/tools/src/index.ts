/**
 * 内置工具 — 执行必须经 core PermissionGate
 * Skill 工具：按 id 加载全文（对照 HC SkillTool）
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  findSkillById,
  formatSkillBodyForInjection,
  type LoadedSkill,
} from '../../skills/src/index.ts'

const execFileAsync = promisify(execFile)

export type ToolSpec = {
  name: string
  description: string
  requiresPermission: boolean
}

export type ToolContext = {
  cwd: string
  /** 会话已发现的 skills（Skill 工具用） */
  skills?: LoadedSkill[]
}

export type ToolResult = {
  ok: boolean
  output: string
}

export const BUILTIN_TOOLS: ToolSpec[] = [
  { name: 'Bash', description: 'Run a shell command', requiresPermission: true },
  { name: 'Read', description: 'Read a file', requiresPermission: false },
  { name: 'Write', description: 'Write a file', requiresPermission: true },
  {
    name: 'apply_patch',
    description: 'Apply a simple file write patch',
    requiresPermission: true,
  },
  { name: 'Glob', description: 'Find files by pattern', requiresPermission: false },
  { name: 'Grep', description: 'Search file contents', requiresPermission: false },
  {
    name: 'Skill',
    description:
      'Load a skill by id and return its full instructions. Only use skill ids listed in the Available Skills catalog. Do not invent skill names.',
    requiresPermission: false,
  },
]

export function listToolNames(): string[] {
  return BUILTIN_TOOLS.map((t) => t.name)
}

export function getToolSpec(name: string): ToolSpec | undefined {
  return BUILTIN_TOOLS.find((t) => t.name === name)
}

function resolveSafe(cwd: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
  const resolved = path.resolve(abs)
  const root = path.resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes cwd: ${filePath}`)
  }
  return resolved
}

async function runBash(
  ctx: ToolContext,
  input: { command?: string },
): Promise<ToolResult> {
  const command = input.command ?? ''
  if (!command.trim()) return { ok: false, output: 'empty command' }
  try {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command]
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd: ctx.cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
    const out = [stdout, stderr].filter(Boolean).join('\n').trim()
    return { ok: true, output: out || '(no output)' }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const out = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n')
    return { ok: false, output: out }
  }
}

async function runRead(
  ctx: ToolContext,
  input: { path?: string },
): Promise<ToolResult> {
  try {
    const p = resolveSafe(ctx.cwd, input.path ?? '')
    const text = await fs.readFile(p, 'utf8')
    return { ok: true, output: text }
  } catch (e) {
    return { ok: false, output: String(e) }
  }
}

async function runWrite(
  ctx: ToolContext,
  input: { path?: string; content?: string },
): Promise<ToolResult> {
  try {
    const p = resolveSafe(ctx.cwd, input.path ?? '')
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, input.content ?? '', 'utf8')
    return { ok: true, output: `wrote ${input.path}` }
  } catch (e) {
    return { ok: false, output: String(e) }
  }
}

async function runSkill(
  ctx: ToolContext,
  input: { skill?: string; name?: string; id?: string },
): Promise<ToolResult> {
  const key = input.skill ?? input.name ?? input.id ?? ''
  if (!key.trim()) {
    return {
      ok: false,
      output: 'Skill tool requires { "skill": "<id>" }',
    }
  }
  const skills = ctx.skills ?? []
  const found = findSkillById(skills, key)
  if (!found) {
    const ids = skills.map((s) => s.meta.id).join(', ') || '(none)'
    return {
      ok: false,
      output: `Unknown skill "${key}". Known ids: ${ids}`,
    }
  }
  if (found.meta.disableModelInvocation) {
    return {
      ok: false,
      output: `Skill "${found.meta.id}" has disable-model-invocation; user must invoke via /skill`,
    }
  }
  return {
    ok: true,
    output: formatSkillBodyForInjection(found),
  }
}

export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const input = (rawInput ?? {}) as Record<string, string>
  switch (name) {
    case 'Bash':
      return runBash(ctx, input)
    case 'Read':
      return runRead(ctx, input)
    case 'Write':
      return runWrite(ctx, input)
    case 'apply_patch':
      return runWrite(ctx, input)
    case 'Skill':
      return runSkill(ctx, input)
    default:
      return { ok: false, output: `unknown tool: ${name}` }
  }
}