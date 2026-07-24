/**
 * Tool 编排 — 对照 HelsincyCode toolOrchestration.ts
 *
 * 分区：连续 isConcurrencySafe 工具并发批；否则串行。
 * 无遥测。
 */

import type { ChatMessage, HooksConfig } from '../../shared/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import {
  createBuiltinTools,
  findToolByName,
  type BoloTool,
} from '../../tools/src/index.ts'
import type { QueryDeps } from './deps.ts'
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
  permissionRules?: import('../../permissions/src/index.ts').SessionPermissionRules
  maxToolResultChars?: number
  spillTruncatedToolResults?: boolean
  skills?: LoadedSkill[]
  tools?: readonly BoloTool[]
  /** 供 Agent 工具启动子 loop */
  deps?: QueryDeps
  /** 活跃 agent 定义（.bolo/agents 合并结果） */
  agentDefinitions?: import('./subagent.ts').ActiveAgentDefinitions
  /** 后台 subagent 状态表 */
  backgroundStore?: import('./subagent.ts').BackgroundAgentStore
  /** 父会话 messages；后台完成通知 + fork 继承 */
  parentMessages?: import('../../shared/src/index.ts').ChatMessage[]
  /** fork 时注入子 agent 的父 system 段 */
  parentSystemPromptSections?: readonly string[]
  signal?: AbortSignal
  onEvent?: (e: ToolExecutionEvent) => void
}

export type RunToolsResult = {
  toolResultMessages: ChatMessage[]
}

type Batch = { concurrent: boolean; blocks: ToolUseBlock[] }

/**
 * 对照 partitionToolCalls：
 * - 连续 concurrency-safe 工具合并为一批并发
 * - 否则单独串行
 */
export function partitionToolCalls(
  blocks: ToolUseBlock[],
  tools: readonly BoloTool[],
): Batch[] {
  const batches: Batch[] = []
  for (const block of blocks) {
    const tool = findToolByName(tools, block.name)
    let input: unknown = block.input
    if (input === undefined && block.argumentsJson) {
      try {
        input = JSON.parse(block.argumentsJson)
      } catch {
        input = {}
      }
    }
    const safe = tool ? tool.isConcurrencySafe(input ?? {}) : false
    const last = batches[batches.length - 1]
    if (safe && last?.concurrent) {
      last.blocks.push(block)
    } else {
      batches.push({ concurrent: safe, blocks: [block] })
    }
  }
  return batches
}

export async function runTools(params: RunToolsParams): Promise<RunToolsResult> {
  const tools = params.tools ?? createBuiltinTools()
  const baseCtx: Omit<RunToolUseContext, 'onEvent'> & {
    onEvent?: RunToolUseContext['onEvent']
  } = {
    sessionId: params.sessionId,
    cwd: params.cwd,
    hooks: params.hooks,
    permissionMode: params.permissionMode,
    askPermission: params.askPermission,
    permissionRules: params.permissionRules,
    maxToolResultChars: params.maxToolResultChars,
    spillTruncatedToolResults: params.spillTruncatedToolResults,
    skills: params.skills,
    tools,
    deps: params.deps,
    agentDefinitions: params.agentDefinitions,
    backgroundStore: params.backgroundStore,
    parentMessages: params.parentMessages,
    parentSystemPromptSections: params.parentSystemPromptSections,
    signal: params.signal,
    onEvent: params.onEvent,
  }

  const toolResultMessages: ChatMessage[] = []
  const batches = partitionToolCalls(params.blocks, tools)

  for (const batch of batches) {
    if (batch.concurrent && batch.blocks.length > 1) {
      // 对照 runToolsConcurrently
      const results = await Promise.all(
        batch.blocks.map((block) => runToolUse(block, baseCtx)),
      )
      for (const r of results) {
        toolResultMessages.push(r.toolResultMessage)
      }
    } else {
      for (const block of batch.blocks) {
        const r = await runToolUse(block, baseCtx)
        toolResultMessages.push(r.toolResultMessage)
      }
    }
  }

  return { toolResultMessages }
}