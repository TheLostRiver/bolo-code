/**
 * Tool 编排 — 对照 HelsincyCode toolOrchestration.ts
 * Bolo v1：全部串行
 */

import type { ChatMessage, HooksConfig } from '../../shared/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import {
  runToolUse,
  type AskPermissionFn,
  type RunToolUseContext,
  type ToolExecutionEvent,
  type ToolUseBlock,
} from './toolExecution.ts'

export type RunToolsParams = {
  blocks: ToolUseBlock[]
  sessionId: string
  cwd: string
  hooks: HooksConfig
  permissionMode: import('../../permissions/src/index.ts').PermissionMode
  askPermission: AskPermissionFn
  skills?: LoadedSkill[]
  onEvent?: (e: ToolExecutionEvent) => void
}

export type RunToolsResult = {
  toolResultMessages: ChatMessage[]
}

export async function runTools(params: RunToolsParams): Promise<RunToolsResult> {
  const ctx: RunToolUseContext = {
    sessionId: params.sessionId,
    cwd: params.cwd,
    hooks: params.hooks,
    permissionMode: params.permissionMode,
    askPermission: params.askPermission,
    skills: params.skills,
    onEvent: params.onEvent,
  }

  const toolResultMessages: ChatMessage[] = []
  for (const block of params.blocks) {
    const { toolResultMessage } = await runToolUse(block, ctx)
    toolResultMessages.push(toolResultMessage)
  }
  return { toolResultMessages }
}