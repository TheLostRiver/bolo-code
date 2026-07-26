/**
 * AR-T2：后台 shell 的两个配套工具
 *
 * - `BashOutput` 只读（增量游标读），免审批、并发安全
 * - `KillShell` 有副作用但**只能作用于本会话注册过的 shell**，
 *   所以不需要通用权限门控：它拿不到任意 pid，越权面为零
 */

import {
  formatBackgroundShellStatusLine,
  getBackgroundShell,
  isTerminalShellStatus,
  listBackgroundShells,
  type BackgroundShellStore,
} from '../../shared/src/index.ts'
import {
  killBackgroundShell,
  readBackgroundShellOutput,
} from './backgroundShellRuntime.ts'
import { buildTool, type BoloTool } from './types.ts'

export const BASH_OUTPUT_TOOL_NAME = 'BashOutput'
export const KILL_SHELL_TOOL_NAME = 'KillShell'

function knownShellIds(store: BackgroundShellStore): string {
  const ids = listBackgroundShells(store).map((s) => s.shellId)
  return ids.length ? ids.join(', ') : '(none)'
}

export function createBashOutputTool(): BoloTool {
  return buildTool({
    name: BASH_OUTPUT_TOOL_NAME,
    description:
      'Read new output from a background shell started by Bash with run_in_background. Returns only what has arrived since the last read, plus the shell status. Call it repeatedly to follow a running process.',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    interruptBehavior: () => 'cancel',
    inputJSONSchema: {
      type: 'object',
      properties: {
        bash_id: {
          type: 'string',
          description: 'Id returned when the background shell was started',
        },
      },
      required: ['bash_id'],
    },
    async call(input, ctx) {
      const store = ctx.extras?.backgroundShellStore as
        | BackgroundShellStore
        | undefined
      if (!store) {
        return {
          ok: false,
          isError: true,
          output:
            'BashOutput is unavailable: no background shell store is bound to this session.',
          errorCode: 'unavailable',
        }
      }
      const id = String(input.bash_id ?? '').trim()
      if (!id) {
        return {
          ok: false,
          isError: true,
          output: 'BashOutput requires { "bash_id": "<id>" }',
          errorCode: 'empty',
        }
      }
      const existing = getBackgroundShell(store, id)
      if (!existing) {
        return {
          ok: false,
          isError: true,
          output: `Unknown background shell "${id}". Known ids: ${knownShellIds(store)}`,
          errorCode: 'not_found',
        }
      }

      const read = await readBackgroundShellOutput(store, id)
      if (!read.ok) {
        return {
          ok: false,
          isError: true,
          output: `Error: ${read.error}`,
          errorCode: 'read_failed',
        }
      }

      const header = formatBackgroundShellStatusLine(read.record)
      const body = read.content
        ? read.content
        : isTerminalShellStatus(read.record.status)
          ? '(no new output; shell has exited)'
          : '(no new output yet)'
      const more = read.hasMore
        ? '\n[more output available — call BashOutput again]'
        : ''
      return { ok: true, output: `${header}\n${body}${more}` }
    },
  })
}

export function createKillShellTool(): BoloTool {
  return buildTool({
    name: KILL_SHELL_TOOL_NAME,
    description:
      'Stop a background shell started by Bash with run_in_background. Kills the whole process tree. Safe to call on an already-finished shell.',
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    interruptBehavior: () => 'block',
    inputJSONSchema: {
      type: 'object',
      properties: {
        shell_id: {
          type: 'string',
          description: 'Id of the background shell to stop',
        },
      },
      required: ['shell_id'],
    },
    async call(input, ctx) {
      const store = ctx.extras?.backgroundShellStore as
        | BackgroundShellStore
        | undefined
      if (!store) {
        return {
          ok: false,
          isError: true,
          output:
            'KillShell is unavailable: no background shell store is bound to this session.',
          errorCode: 'unavailable',
        }
      }
      const id = String(input.shell_id ?? input.bash_id ?? '').trim()
      if (!id) {
        return {
          ok: false,
          isError: true,
          output: 'KillShell requires { "shell_id": "<id>" }',
          errorCode: 'empty',
        }
      }
      if (!getBackgroundShell(store, id)) {
        return {
          ok: false,
          isError: true,
          output: `Unknown background shell "${id}". Known ids: ${knownShellIds(store)}`,
          errorCode: 'not_found',
        }
      }

      const killed = await killBackgroundShell(store, id)
      if (!killed.ok) {
        return {
          ok: false,
          isError: true,
          output: `Error: ${killed.error}`,
          errorCode: 'kill_failed',
        }
      }
      return {
        ok: true,
        output: killed.alreadyTerminal
          ? `Background shell ${id} had already exited: ${formatBackgroundShellStatusLine(killed.record)}`
          : `Killed background shell ${id}.`,
      }
    },
  })
}
