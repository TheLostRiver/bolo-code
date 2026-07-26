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
  skillModelInvokeBlockReason,
  type LoadedSkill,
} from '../../skills/src/index.ts'
import {
  applySandboxEnv,
  mergePolicyDenyPrefixes,
  resolveBoloPolicy,
  resolveSandboxMode,
} from '../../permissions/src/policy.ts'
import {
  cleanupOsSandboxPlan,
  planSandboxedShell,
} from '../../permissions/src/osSandbox.ts'
import { applyPatchToCwd } from './applyPatch.ts'
import { createTodoWriteTool } from './todoWrite.ts'
import { createExitPlanModeTool } from './exitPlanMode.ts'
import {
  createBashOutputTool,
  createKillShellTool,
} from './backgroundShellTools.ts'
import { spawnBackgroundShell } from './backgroundShellRuntime.ts'
import type { BackgroundShellStore } from '../../shared/src/index.ts'
import {
  countHunkLines,
  diffHunksFromEdit,
  diffHunksFromFullReplace,
  formatEditToolOutput,
  formatUnifiedDiff,
  formatWriteToolOutput,
} from './textDiff.ts'
import {
  buildTool,
  type BoloTool,
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

function abortedResult(): ToolResult {
  return {
    ok: false,
    isError: true,
    output: 'Error: tool cancelled',
    errorCode: 'aborted',
  }
}

export function createBashTool(): BoloTool {
  return buildTool({
    name: 'Bash',
    description: 'Run a shell command in the project cwd',
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    /** 用户 interrupt 时可取消 shell（对照 HC Bash cancel） */
    interruptBehavior: () => 'cancel',
    inputJSONSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default 30000, max 600000)',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Run the command in the background and return immediately. Use for dev servers, watchers and long builds; read incremental output with BashOutput and stop it with KillShell. Background shells outlive the turn but never the session.',
        },
        description: {
          type: 'string',
          description:
            'Short human label for a background command (shown in status lines)',
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
        return abortedResult()
      }

      // Y5：策略 deny 前缀 + sandbox 环境标记（对照 HC sandbox 语义的最小接线）
      const { policy } = await resolveBoloPolicy({ cwd: ctx.cwd })
      if (policy?.denyTools?.includes('Bash')) {
        return {
          ok: false,
          isError: true,
          output: 'Error: Bash denied by policy.denyTools',
          errorCode: 'policy_deny',
        }
      }
      const denyPrefixes = mergePolicyDenyPrefixes([], policy)
      const cmdTrim = command.trim()
      for (const pfx of denyPrefixes) {
        if (pfx && (cmdTrim === pfx || cmdTrim.startsWith(pfx + ' ') || cmdTrim.startsWith(pfx))) {
          return {
            ok: false,
            isError: true,
            output: `Error: command denied by policy prefix: ${pfx}`,
            errorCode: 'policy_deny',
          }
        }
      }
      const sandboxMode = resolveSandboxMode(process.env, policy)
      const sand = applySandboxEnv(process.env, sandboxMode)
      const plan = await planSandboxedShell({
        command,
        cwd: ctx.cwd,
        mode: sandboxMode,
      })
      if (sandboxMode === 'require' && !plan.isolated) {
        if (
          process.env.BOLO_SANDBOX_FAIL_CLOSED === '1' ||
          process.env.BOLO_SANDBOX_FAIL_CLOSED === 'true'
        ) {
          await cleanupOsSandboxPlan(plan)
          return {
            ok: false,
            isError: true,
            output: `Error: sandbox require but OS isolation unavailable (${plan.warning ?? sand.warning ?? 'none'})`,
            errorCode: 'sandbox_unavailable',
          }
        }
      }

      // AR-T2：后台分支。走完与前台**同一套** policy/sandbox 门禁后才分流；
      // 之后不套 timeout、不吃 ctx.signal —— 后台进程的意义就是跨 turn 存活。
      if (input.run_in_background === true) {
        const store = ctx.extras?.backgroundShellStore as
          | BackgroundShellStore
          | undefined
        if (!store) {
          await cleanupOsSandboxPlan(plan)
          return {
            ok: false,
            isError: true,
            output:
              'run_in_background is unavailable: no background shell store is bound to this session.',
            errorCode: 'unavailable',
          }
        }
        const description =
          typeof input.description === 'string' && input.description.trim()
            ? input.description.trim()
            : undefined
        const spawned = await spawnBackgroundShell({
          store,
          command,
          cwd: ctx.cwd,
          file: plan.file,
          args: plan.args,
          env: sand.env,
          // 沙箱临时文件必须活到进程退出后才清理
          cleanup: () => cleanupOsSandboxPlan(plan),
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(description ? { description } : {}),
        })
        if (!spawned.ok) {
          await cleanupOsSandboxPlan(plan)
          return {
            ok: false,
            isError: true,
            output: `Error: ${spawned.error}`,
            errorCode: 'spawn_failed',
          }
        }
        return {
          ok: true,
          output: [
            `Started background shell ${spawned.record.shellId}`,
            `command: ${command}`,
            `Use BashOutput with bash_id "${spawned.record.shellId}" to read incremental output, and KillShell to stop it.`,
          ].join('\n'),
        }
      }

      const rawTimeout = Number(input.timeout)
      const timeoutMs = Number.isFinite(rawTimeout)
        ? Math.min(600_000, Math.max(1, Math.floor(rawTimeout)))
        : 30_000
      const preview =
        command.length > 80 ? `${command.slice(0, 79)}…` : command
      try {
        ctx.onProgress?.(`running: ${preview}`)
      } catch {
        /* progress 不得拖垮工具 */
      }
      try {
        const { stdout, stderr } = await execFileAsync(plan.file, plan.args, {
          cwd: ctx.cwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          signal: ctx.signal,
          env: sand.env,
        })
        if (ctx.signal?.aborted) return abortedResult()
        const out = [stdout, stderr].filter(Boolean).join('\n').trim()
        const notes: string[] = []
        if (plan.isolated) notes.push(`[sandbox] os=${plan.kind}`)
        else if (plan.warning) notes.push(`[sandbox] ${plan.warning}`)
        else if (sand.warning && sandboxMode !== 'off')
          notes.push(`[sandbox] ${sand.warning}`)
        const note = notes.length ? `\n${notes.join(' ')}` : ''
        return { ok: true, output: (out || '(no output)') + note }
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
          return abortedResult()
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
      } finally {
        await cleanupOsSandboxPlan(plan)
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
      if (ctx.signal?.aborted) return abortedResult()
      try {
        const p = resolveSafe(ctx.cwd, String(input.path ?? ''))
        if (ctx.signal?.aborted) return abortedResult()
        const text = await fs.readFile(p, 'utf8')
        if (ctx.signal?.aborted) return abortedResult()
        return { ok: true, output: text }
      } catch (e) {
        if (ctx.signal?.aborted) return abortedResult()
        return { ok: false, isError: true, output: String(e), errorCode: 'read_failed' }
      }
    },
  })
}

export function createWriteTool(): BoloTool {
  return buildTool({
    name: 'Write',
    description: 'Write a file relative to cwd (full replace)',
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
      if (ctx.signal?.aborted) return abortedResult()
      try {
        const filePath = String(input.path ?? '')
        const content = String(input.content ?? '')
        const p = resolveSafe(ctx.cwd, filePath)
        if (ctx.signal?.aborted) return abortedResult()
        let before = ''
        let created = true
        try {
          before = await fs.readFile(p, 'utf8')
          created = false
        } catch {
          created = true
        }
        if (ctx.signal?.aborted) return abortedResult()
        await fs.mkdir(path.dirname(p), { recursive: true })
        if (ctx.signal?.aborted) return abortedResult()
        await fs.writeFile(p, content, 'utf8')
        if (ctx.signal?.aborted) return abortedResult()

        const hunks = created
          ? diffHunksFromFullReplace('', content)
          : diffHunksFromFullReplace(before, content)
        const { added, removed } = countHunkLines(hunks)
        const unified = formatUnifiedDiff(filePath, hunks)
        const output = formatWriteToolOutput({
          path: filePath,
          created,
          hunks,
          includeUnified: true,
        })
        return {
          ok: true,
          output,
          meta: {
            kind: 'file_write',
            path: filePath,
            added,
            removed,
            structuredPatch: hunks,
            ...(unified ? { unified } : {}),
          },
        }
      } catch (e) {
        if (ctx.signal?.aborted) return abortedResult()
        return {
          ok: false,
          isError: true,
          output: String(e),
          errorCode: 'write_failed',
        }
      }
    },
  })
}

/**
 * 精确字符串替换编辑 — 对照 HC Edit 语义（old_string/new_string，默认唯一匹配）。
 * 不抄 HC 实现；失败消息对模型友好。
 */
export function createEditTool(): BoloTool {
  return buildTool({
    name: 'Edit',
    description:
      'Replace exact text in a file under cwd. Uses old_string → new_string; by default old_string must match exactly once (set replace_all=true to replace all). Prefer Edit for small surgical changes; use Write for full-file rewrite; use apply_patch for multi-hunk patches.',
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to cwd' },
        old_string: {
          type: 'string',
          description: 'Exact text to find (must be unique unless replace_all)',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text',
        },
        replace_all: {
          type: 'boolean',
          description: 'If true, replace every occurrence (default false)',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async call(input, ctx) {
      if (ctx.signal?.aborted) return abortedResult()
      const filePath = String(input.path ?? '')
      const oldStr = String(input.old_string ?? '')
      const newStr = String(input.new_string ?? '')
      const replaceAll = input.replace_all === true

      if (!filePath.trim()) {
        return {
          ok: false,
          isError: true,
          output: 'Edit: path is required',
          errorCode: 'invalid_input',
        }
      }
      if (oldStr === '') {
        return {
          ok: false,
          isError: true,
          output:
            'Edit: old_string is empty. Provide non-empty text to find, or use Write for full-file content.',
          errorCode: 'invalid_input',
        }
      }
      if (oldStr === newStr) {
        return {
          ok: false,
          isError: true,
          output: 'Edit: old_string and new_string are identical; nothing to change',
          errorCode: 'no_change',
        }
      }

      try {
        const p = resolveSafe(ctx.cwd, filePath)
        if (ctx.signal?.aborted) return abortedResult()
        let text: string
        try {
          text = await fs.readFile(p, 'utf8')
        } catch (e) {
          const err = e as NodeJS.ErrnoException
          if (err.code === 'ENOENT') {
            return {
              ok: false,
              isError: true,
              output: `Edit: file not found: ${filePath}`,
              errorCode: 'not_found',
            }
          }
          throw e
        }
        if (ctx.signal?.aborted) return abortedResult()

        // 统计不重叠出现次数（indexOf 步进）
        let count = 0
        let from = 0
        while (from <= text.length) {
          const idx = text.indexOf(oldStr, from)
          if (idx < 0) break
          count += 1
          from = idx + oldStr.length
          if (!replaceAll && count > 1) break
        }

        if (count === 0) {
          const preview =
            oldStr.length > 120 ? oldStr.slice(0, 120) + '…' : oldStr
          return {
            ok: false,
            isError: true,
            output: `Edit: old_string not found in ${filePath}. Ensure exact match (including whitespace). Snippet: ${JSON.stringify(preview)}`,
            errorCode: 'not_found',
          }
        }
        if (!replaceAll && count > 1) {
          return {
            ok: false,
            isError: true,
            output: `Edit: old_string matched ${count} times in ${filePath}; expected unique match. Narrow old_string or set replace_all=true.`,
            errorCode: 'not_unique',
          }
        }

        const next = replaceAll
          ? text.split(oldStr).join(newStr)
          : text.replace(oldStr, newStr)

        if (ctx.signal?.aborted) return abortedResult()
        await fs.writeFile(p, next, 'utf8')
        if (ctx.signal?.aborted) return abortedResult()

        const n = replaceAll ? count : 1
        const hunks = diffHunksFromEdit(text, oldStr, newStr, replaceAll)
        const { added, removed } = countHunkLines(hunks)
        const unified = formatUnifiedDiff(filePath, hunks)
        const output = formatEditToolOutput({
          path: filePath,
          replacements: n,
          hunks,
          includeUnified: true,
        })
        return {
          ok: true,
          output,
          meta: {
            kind: 'file_edit',
            path: filePath,
            added,
            removed,
            replacements: n,
            structuredPatch: hunks,
            ...(unified ? { unified } : {}),
          },
        }
      } catch (e) {
        if (ctx.signal?.aborted) return abortedResult()
        return {
          ok: false,
          isError: true,
          output: e instanceof Error ? e.message : String(e),
          errorCode: 'edit_failed',
        }
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
      if (ctx.signal?.aborted) return abortedResult()
      try {
        const patch = input.patch != null ? String(input.patch) : ''
        if (patch.trim()) {
          const result = await applyPatchToCwd(ctx.cwd, patch)
          if (ctx.signal?.aborted) return abortedResult()
          const first = result.files[0]
          const unifiedParts: string[] = []
          for (const f of result.files.slice(0, 2)) {
            if (!f.structuredPatch?.length) continue
            const u = formatUnifiedDiff(f.path, f.structuredPatch)
            if (u) unifiedParts.push(u)
          }
          return {
            ok: true,
            output: result.output,
            meta: {
              kind: 'apply_patch',
              path: first?.path,
              paths: result.changed,
              op: first?.op,
              added: result.added,
              removed: result.removed,
              files: result.files.map((f) => ({
                path: f.path,
                op: f.op,
                added: f.added,
                removed: f.removed,
                ...(f.structuredPatch?.length
                  ? { structuredPatch: f.structuredPatch }
                  : {}),
              })),
              ...(first?.structuredPatch?.length
                ? { structuredPatch: first.structuredPatch }
                : {}),
              ...(unifiedParts.length
                ? { unified: unifiedParts.join('\n') }
                : {}),
            },
          }
        }
        // legacy: full-file write via path + content
        const filePath = input.path != null ? String(input.path) : ''
        if (filePath && input.content != null) {
          const p = resolveSafe(ctx.cwd, filePath)
          if (ctx.signal?.aborted) return abortedResult()
          let before = ''
          let created = true
          try {
            before = await fs.readFile(p, 'utf8')
            created = false
          } catch {
            created = true
          }
          await fs.mkdir(path.dirname(p), { recursive: true })
          const content = String(input.content)
          await fs.writeFile(p, content, 'utf8')
          if (ctx.signal?.aborted) return abortedResult()
          const hunks = created
            ? diffHunksFromFullReplace('', content)
            : diffHunksFromFullReplace(before, content)
          const { added, removed } = countHunkLines(hunks)
          const unified = formatUnifiedDiff(filePath, hunks)
          const head = created
            ? `wrote ${filePath} (new file; +${added})`
            : `wrote ${filePath} (+${added}/-${removed})`
          return {
            ok: true,
            output: unified ? `${head}\n${unified}` : head,
            meta: {
              kind: 'apply_patch',
              path: filePath,
              paths: [filePath],
              op: created ? 'add' : 'update',
              added,
              removed,
              files: [
                {
                  path: filePath,
                  op: created ? 'add' : 'update',
                  added,
                  removed,
                  ...(hunks.length ? { structuredPatch: hunks } : {}),
                },
              ],
              ...(hunks.length ? { structuredPatch: hunks } : {}),
              ...(unified ? { unified } : {}),
            },
          }
        }
        return {
          ok: false,
          isError: true,
          output: 'apply_patch: provide `patch` text (or legacy path+content)',
          errorCode: 'invalid_input',
        }
      } catch (e) {
        if (ctx.signal?.aborted) return abortedResult()
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
          output:
            skillModelInvokeBlockReason(found) ??
            `Skill "${found.meta.id}" has disable-model-invocation`,
          errorCode: 'disabled',
        }
      }
      return { ok: true, output: formatSkillBodyForInjection(found) }
    },
  })
}

/**
 * WebFetch — 对照 HC WebFetchTool 最小实现：HTTP(S) GET 文本，有超时与体积上限。
 * requiresPermission：网络出站需门控。
 */
export function createWebFetchTool(): BoloTool {
  return buildTool({
    name: 'WebFetch',
    description:
      'Fetch a public http(s) URL and return text body (truncated). Use for docs/API pages; not for secrets.',
    requiresPermission: true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http or https URL' },
        timeout: {
          type: 'number',
          description: 'Timeout ms (default 15000, max 60000)',
        },
      },
      required: ['url'],
    },
    async call(input, ctx) {
      if (ctx.signal?.aborted) return abortedResult()
      const rawUrl = String(input.url ?? '').trim()
      if (!rawUrl) {
        return {
          ok: false,
          isError: true,
          output: 'WebFetch requires { "url": "https://..." }',
          errorCode: 'empty',
        }
      }
      let u: URL
      try {
        u = new URL(rawUrl)
      } catch {
        return {
          ok: false,
          isError: true,
          output: `invalid URL: ${rawUrl}`,
          errorCode: 'bad_url',
        }
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return {
          ok: false,
          isError: true,
          output: 'only http/https allowed',
          errorCode: 'bad_scheme',
        }
      }
      // 基础 SSRF 防护：禁止明显本地/链路本地
      const host = u.hostname.toLowerCase()
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host.endsWith('.local') ||
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        host.startsWith('169.254.')
      ) {
        return {
          ok: false,
          isError: true,
          output: `blocked host (local/private): ${host}`,
          errorCode: 'ssrf_block',
        }
      }
      const rawTimeout = Number(input.timeout)
      const timeoutMs = Number.isFinite(rawTimeout)
        ? Math.min(60_000, Math.max(1, Math.floor(rawTimeout)))
        : 15_000
      const ac = new AbortController()
      const onAbort = () => ac.abort()
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const res = await fetch(u.toString(), {
          method: 'GET',
          redirect: 'follow',
          signal: ac.signal,
          headers: { 'user-agent': 'BoloCode-WebFetch/0.1' },
        })
        const buf = await res.arrayBuffer()
        const max = 200_000
        const slice = buf.byteLength > max ? buf.slice(0, max) : buf
        const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
        const trunc =
          buf.byteLength > max
            ? `\n…(truncated ${buf.byteLength}→${max} bytes)`
            : ''
        if (!res.ok) {
          return {
            ok: false,
            isError: true,
            output: `HTTP ${res.status} ${res.statusText}\n${text.slice(0, 4000)}${trunc}`,
            errorCode: 'http_error',
          }
        }
        return {
          ok: true,
          output: `URL: ${u}\nStatus: ${res.status}\n\n${text}${trunc}`,
        }
      } catch (e) {
        if (ctx.signal?.aborted || ac.signal.aborted) return abortedResult()
        return {
          ok: false,
          isError: true,
          output: String(e),
          errorCode: 'fetch_failed',
        }
      } finally {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
      }
    },
  })
}

export function createBuiltinTools(): BoloTool[] {
  return [
    createBashTool(),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createApplyPatchTool(),
    createGlobTool(),
    createGrepTool(),
    createSkillTool(),
    createWebFetchTool(),
    createTodoWriteTool(),
    createExitPlanModeTool(),
    createBashOutputTool(),
    createKillShellTool(),
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
