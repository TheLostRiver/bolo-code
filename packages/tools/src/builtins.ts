/**
 * 内置工具实现 — 对照 HC 各 Tool 目录的最小可用集
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
import { applyPatchToCwd } from './applyPatch.ts'
import {
  buildTool,
  type BoloTool,
  type ToolContext,
  type ToolResult,
} from './types.ts'

const execFileAsync = promisify(execFile)

function resolveSafe(cwd: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
  const resolved = path.resolve(abs)
  const root = path.resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes cwd: ${filePath}`)
  }
  return resolved
}

function matchGlob(rel: string, pattern: string): boolean {
  // 极简 glob：* ** 与 ?
  // ** / 必须匹配 0+ 层目录，否则 **/*.ts 漏掉根目录 a.ts
  const norm = rel.split(path.sep).join('/')
  const pat = pattern.split(path.sep).join('/')
  let re = '^'
  for (let i = 0; i < pat.length; ) {
    const c = pat[i]!
    if (c === '*' && pat[i + 1] === '*') {
      if (pat[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 3
      } else {
        re += '.*'
        i += 2
      }
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    if ('+.^${}()|[]\\'.includes(c)) {
      re += '\\' + c
      i += 1
      continue
    }
    re += c
    i += 1
  }
  re += '$'
  return new RegExp(re).test(norm)
}

async function walkFiles(root: string, maxFiles = 5000): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string) {
    if (out.length >= maxFiles) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) out.push(full)
    }
  }
  await walk(root)
  return out
}

export function createBashTool(): BoloTool {
  return buildTool({
    name: 'Bash',
    description: 'Run a shell command in the project cwd',
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default 30000, max 600000)',
        },
      },
      required: ['command'],
    },
    async call(input, ctx) {
      const command = String(input.command ?? '')
      if (!command.trim()) {
        return { ok: false, isError: true, output: 'empty command', errorCode: 'empty' }
      }
      if (ctx.signal?.aborted) {
        return {
          ok: false,
          isError: true,
          output: 'Error: tool cancelled',
          errorCode: 'aborted',
        }
      }
      const rawTimeout = Number(input.timeout)
      const timeoutMs = Number.isFinite(rawTimeout)
        ? Math.min(600_000, Math.max(1, Math.floor(rawTimeout)))
        : 30_000
      try {
        const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
        const args =
          process.platform === 'win32' ? ['/c', command] : ['-c', command]
        const { stdout, stderr } = await execFileAsync(shell, args, {
          cwd: ctx.cwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          signal: ctx.signal,
        })
        const out = [stdout, stderr].filter(Boolean).join('\n').trim()
        return { ok: true, output: out || '(no output)' }
      } catch (e) {
        const err = e as {
          stdout?: string
          stderr?: string
          message?: string
          name?: string
          code?: string | number
          killed?: boolean
        }
        if (
          ctx.signal?.aborted ||
          err.name === 'AbortError' ||
          err.code === 'ABORT_ERR'
        ) {
          return {
            ok: false,
            isError: true,
            output: 'Error: tool cancelled',
            errorCode: 'aborted',
          }
        }
        const timedOut =
          err.killed === true ||
          err.code === 'ETIMEDOUT' ||
          /timed?\s*out/i.test(err.message ?? '')
        return {
          ok: false,
          isError: true,
          output: [err.stdout, err.stderr, err.message]
            .filter(Boolean)
            .join('\n'),
          errorCode: timedOut ? 'timeout' : 'exec_failed',
        }
      }
    },
  })
}

export function createReadTool(): BoloTool {
  return buildTool({
    name: 'Read',
    description: 'Read a file relative to cwd',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to cwd' },
      },
      required: ['path'],
    },
    async call(input, ctx) {
      try {
        const p = resolveSafe(ctx.cwd, String(input.path ?? ''))
        const text = await fs.readFile(p, 'utf8')
        return { ok: true, output: text }
      } catch (e) {
        return { ok: false, isError: true, output: String(e), errorCode: 'read_failed' }
      }
    },
  })
}

export function createWriteTool(): BoloTool {
  return buildTool({
    name: 'Write',
    description: 'Write a file relative to cwd',
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async call(input, ctx) {
      try {
        const p = resolveSafe(ctx.cwd, String(input.path ?? ''))
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(p, String(input.content ?? ''), 'utf8')
        return { ok: true, output: `wrote ${input.path}` }
      } catch (e) {
        return { ok: false, isError: true, output: String(e), errorCode: 'write_failed' }
      }
    },
  })
}

export function createApplyPatchTool(): BoloTool {
  return buildTool({
    name: 'apply_patch',
    description:
      'Apply a minimal patch under cwd. Prefer *** Begin Patch with *** Add/Update/Delete File, or a simple unified diff. Input: { patch } (or legacy path+content full write).',
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description:
            'Patch text: *** Begin Patch ... *** End Patch, or unified ---/+++/@@ hunks',
        },
        // legacy Write-style full replace (kept for older prompts)
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
    async call(input, ctx) {
      try {
        const patch = input.patch != null ? String(input.patch) : ''
        if (patch.trim()) {
          const result = await applyPatchToCwd(ctx.cwd, patch)
          return { ok: true, output: result.output }
        }
        // legacy: full-file write via path + content
        const filePath = input.path != null ? String(input.path) : ''
        if (filePath && input.content != null) {
          const p = resolveSafe(ctx.cwd, filePath)
          await fs.mkdir(path.dirname(p), { recursive: true })
          await fs.writeFile(p, String(input.content), 'utf8')
          return { ok: true, output: `wrote ${filePath}` }
        }
        return {
          ok: false,
          isError: true,
          output: 'apply_patch: provide `patch` text (or legacy path+content)',
          errorCode: 'invalid_input',
        }
      } catch (e) {
        return {
          ok: false,
          isError: true,
          output: e instanceof Error ? e.message : String(e),
          errorCode: 'apply_patch_failed',
        }
      }
    },
  })
}

export function createGlobTool(): BoloTool {
  return buildTool({
    name: 'Glob',
    description: 'Find files by glob pattern under cwd',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts' },
      },
      required: ['pattern'],
    },
    async call(input, ctx) {
      const pattern = String(input.pattern ?? '')
      if (!pattern) {
        return { ok: false, isError: true, output: 'pattern required', errorCode: 'empty' }
      }
      try {
        const files = await walkFiles(ctx.cwd)
        const hits = files
          .map((f) => path.relative(ctx.cwd, f))
          .filter((rel) => matchGlob(rel, pattern))
          .slice(0, 200)
        return {
          ok: true,
          output: hits.length ? hits.join('\n') : '(no matches)',
        }
      } catch (e) {
        return { ok: false, isError: true, output: String(e), errorCode: 'glob_failed' }
      }
    },
  })
}

export function createGrepTool(): BoloTool {
  return buildTool({
    name: 'Grep',
    description: 'Search file contents under cwd for a pattern',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Optional subpath under cwd' },
      },
      required: ['pattern'],
    },
    async call(input, ctx) {
      const pattern = String(input.pattern ?? '')
      if (!pattern) {
        return { ok: false, isError: true, output: 'pattern required', errorCode: 'empty' }
      }
      let re: RegExp
      try {
        re = new RegExp(pattern)
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      }
      const root = input.path
        ? resolveSafe(ctx.cwd, String(input.path))
        : ctx.cwd
      const files = await walkFiles(root, 2000)
      const lines: string[] = []
      for (const f of files) {
        if (lines.length >= 100) break
        let text: string
        try {
          text = await fs.readFile(f, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\0')) continue // skip binary
        const rel = path.relative(ctx.cwd, f)
        const fileLines = text.split(/\r?\n/)
        for (let i = 0; i < fileLines.length; i++) {
          if (lines.length >= 100) break
          if (re.test(fileLines[i]!)) {
            lines.push(`${rel}:${i + 1}:${fileLines[i]}`)
          }
        }
      }
      return {
        ok: true,
        output: lines.length ? lines.join('\n') : '(no matches)',
      }
    },
  })
}

export function createSkillTool(): BoloTool {
  return buildTool({
    name: 'Skill',
    description:
      'Load a skill by id and return its full instructions. Only use skill ids listed in the Available Skills catalog.',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill id from the Available Skills catalog',
        },
      },
      required: ['skill'],
    },
    async call(input, ctx) {
      const key = String(input.skill ?? input.name ?? input.id ?? '')
      if (!key.trim()) {
        return {
          ok: false,
          isError: true,
          output: 'Skill tool requires { "skill": "<id>" }',
          errorCode: 'empty',
        }
      }
      const skills = (ctx.extras?.skills as LoadedSkill[] | undefined) ?? []
      const found = findSkillById(skills, key)
      if (!found) {
        const ids = skills.map((s) => s.meta.id).join(', ') || '(none)'
        return {
          ok: false,
          isError: true,
          output: `Unknown skill "${key}". Known ids: ${ids}`,
          errorCode: 'not_found',
        }
      }
      if (found.meta.disableModelInvocation) {
        return {
          ok: false,
          isError: true,
          output: `Skill "${found.meta.id}" has disable-model-invocation`,
          errorCode: 'disabled',
        }
      }
      return { ok: true, output: formatSkillBodyForInjection(found) }
    },
  })
}

export function createBuiltinTools(): BoloTool[] {
  return [
    createBashTool(),
    createReadTool(),
    createWriteTool(),
    createApplyPatchTool(),
    createGlobTool(),
    createGrepTool(),
    createSkillTool(),
  ]
}

/** @deprecated 使用 createBuiltinTools + registry；保留兼容 */
export type ToolSpec = {
  name: string
  description: string
  requiresPermission: boolean
}

export type LegacyToolContext = {
  cwd: string
  skills?: LoadedSkill[]
}

export function getBuiltinToolSpecs(): ToolSpec[] {
  return createBuiltinTools().map((t) => ({
    name: t.name,
    description: t.description,
    requiresPermission: t.requiresPermission,
  }))
}

/** 兼容旧 executeTool 入口 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: LegacyToolContext,
): Promise<ToolResult> {
  const tools = createBuiltinTools()
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    return {
      ok: false,
      isError: true,
      output: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`,
      errorCode: 'unknown_tool',
    }
  }
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}
  return tool.call(input, {
    cwd: ctx.cwd,
    extras: { skills: ctx.skills },
  })
}

export function listToolNames(): string[] {
  return createBuiltinTools().map((t) => t.name)
}

export function getToolSpec(name: string): ToolSpec | undefined {
  return getBuiltinToolSpecs().find((t) => t.name === name)
}

/** 兼容旧名 */
export const BUILTIN_TOOLS = getBuiltinToolSpecs()