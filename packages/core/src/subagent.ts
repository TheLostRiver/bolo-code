/**
 * Subagent 运行时 — 对照 HC AgentTool / runAgent / resolveAgentTools
 * 无遥测；默认禁止子 agent 再调 Agent。
 */

import { runHooks } from '../../hooks/src/index.ts'
import {
  newId,
  nowIso,
  type ChatMessage,
  type HooksConfig,
} from '../../shared/src/index.ts'
import type { LoadedSkill } from '../../skills/src/index.ts'
import {
  buildTool,
  createBuiltinTools,
  type BoloTool,
} from '../../tools/src/index.ts'
import type { QueryDeps } from './deps.ts'
import { queryLoop, type QueryLoopEvent, type Terminal } from './queryLoop.ts'
import type { AskPermissionFn } from './toolExecution.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'

export const AGENT_TOOL_NAME = 'Agent'

export type AgentDefinition = {
  agentType: string
  description: string
  /** 白名单工具名，或 '*' 表示默认可写集（仍会排除 Agent） */
  tools: string[] | '*'
  systemPrompt: string
  permissionMode?: PermissionMode
}

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: 'explore',
  description:
    'Read-only explorer: find files and search code. Use for codebase questions without edits.',
  tools: ['Read', 'Glob', 'Grep'],
  systemPrompt: `You are a read-only explore subagent for Bolo.
Use only Read, Glob, and Grep. Do not modify files or run shell writes.
Search efficiently and reply with a concise findings report for the parent agent.`,
  permissionMode: 'default',
}

export const GENERAL_AGENT: AgentDefinition = {
  agentType: 'general',
  description:
    'General-purpose subagent for multi-step tasks. Cannot spawn further agents.',
  tools: '*',
  systemPrompt: `You are a general-purpose subagent for Bolo.
Complete the task with the tools you have. Do not spawn nested agents.
When done, reply with a concise report of what you did and key findings.`,
}

const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  explore: EXPLORE_AGENT,
  general: GENERAL_AGENT,
}

export function listBuiltinAgents(): AgentDefinition[] {
  return Object.values(BUILTIN_AGENTS)
}

export function getAgentDefinition(
  agentType: string | undefined | null,
): AgentDefinition {
  const key = (agentType ?? 'general').trim().toLowerCase()
  const def = BUILTIN_AGENTS[key]
  if (!def) {
    throw new Error(
      `Unknown subagent_type "${agentType}". Known: ${Object.keys(BUILTIN_AGENTS).join(', ')}`,
    )
  }
  return def
}

export type ResolveAgentToolsResult = {
  resolvedTools: BoloTool[]
  /** 白名单里不存在的名字 */
  invalidTools: string[]
  hasWildcard: boolean
}

/**
 * 按 AgentDefinition 裁剪工具；始终排除 Agent（防递归）。
 */
export function resolveAgentTools(
  def: Pick<AgentDefinition, 'tools'>,
  allTools: readonly BoloTool[],
): ResolveAgentToolsResult {
  const withoutAgent = allTools.filter((t) => t.name !== AGENT_TOOL_NAME)
  const hasWildcard = def.tools === '*' || (Array.isArray(def.tools) && def.tools.includes('*'))

  if (hasWildcard) {
    return {
      resolvedTools: withoutAgent,
      invalidTools: [],
      hasWildcard: true,
    }
  }

  const allow = new Set(
    (def.tools as string[]).map((n) => n.trim()).filter(Boolean),
  )
  allow.delete(AGENT_TOOL_NAME)

  const byName = new Map(withoutAgent.map((t) => [t.name, t]))
  const resolvedTools: BoloTool[] = []
  const invalidTools: string[] = []

  for (const name of allow) {
    const t = byName.get(name)
    if (t) resolvedTools.push(t)
    else invalidTools.push(name)
  }

  return { resolvedTools, invalidTools, hasWildcard: false }
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.content?.trim()) {
      return m.content.trim()
    }
  }
  return ''
}

export type RunSubagentParams = {
  def: AgentDefinition
  prompt: string
  parentSessionId: string
  cwd: string
  hooks: HooksConfig
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  /** 父侧全量工具（含 Agent）；内部会 resolve 并去掉 Agent */
  allTools?: readonly BoloTool[]
  skills?: LoadedSkill[]
  maxTurns?: number
  signal?: AbortSignal
  onEvent?: (e: QueryLoopEvent) => void
}

export type RunSubagentResult = {
  agentId: string
  agentType: string
  summary: string
  isError: boolean
  terminal: Terminal
  messages: ChatMessage[]
}

/**
 * 真子 loop：SubagentStart → 独立 messages + queryLoop → 摘要 → SubagentStop
 */
export async function runSubagent(
  params: RunSubagentParams,
): Promise<RunSubagentResult> {
  const agentId = newId('agent')
  const agentType = params.def.agentType
  const allTools = params.allTools ?? createDefaultTools()
  const { resolvedTools } = resolveAgentTools(params.def, allTools)
  const messages: ChatMessage[] = [{ role: 'user', content: params.prompt }]
  const permissionMode = params.def.permissionMode ?? params.permissionMode
  const maxTurns = params.maxTurns ?? 8

  await runHooks(
    'SubagentStart',
    {
      hook_event_name: 'SubagentStart',
      session_id: params.parentSessionId,
      cwd: params.cwd,
      timestamp: nowIso(),
      agent_id: agentId,
      agent_type: agentType,
    },
    params.hooks,
  )

  let terminal: Terminal
  try {
    terminal = await queryLoop({
      sessionId: `${params.parentSessionId}:${agentId}`,
      cwd: params.cwd,
      hooks: params.hooks,
      messages,
      systemPromptSections: [params.def.systemPrompt],
      deps: params.deps,
      permissionMode,
      askPermission: params.askPermission,
      skills: params.skills,
      tools: resolvedTools,
      maxTurns,
      maxPtlRetries: 0,
      querySource: `subagent:${agentType}`,
      signal: params.signal,
      onEvent: params.onEvent,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    terminal = { reason: 'error', detail }
  }

  const summaryText = lastAssistantText(messages)
  const failed =
    terminal.reason === 'error' ||
    terminal.reason === 'aborted' ||
    terminal.reason === 'user_prompt_blocked'
  const isError = failed || !summaryText
  const summary = isError
    ? summaryText ||
      `Subagent ${agentType} ended: ${terminal.reason}${terminal.detail ? ` (${terminal.detail})` : ''}`
    : summaryText

  await runHooks(
    'SubagentStop',
    {
      hook_event_name: 'SubagentStop',
      session_id: params.parentSessionId,
      cwd: params.cwd,
      timestamp: nowIso(),
      agent_id: agentId,
      agent_type: agentType,
    },
    params.hooks,
  )

  return {
    agentId,
    agentType,
    summary,
    isError,
    terminal,
    messages,
  }
}

export type SubagentParentContext = {
  parentSessionId: string
  cwd: string
  hooks: HooksConfig
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  allTools: readonly BoloTool[]
  skills?: LoadedSkill[]
  signal?: AbortSignal
  onEvent?: (e: QueryLoopEvent) => void
}

/**
 * 主会话 Agent 工具。须在 tool.call 的 extras.subagentParent 注入父上下文。
 */
export function createAgentTool(): BoloTool {
  return buildTool({
    name: AGENT_TOOL_NAME,
    description:
      'Spawn a subagent with an isolated message loop. Use for focused exploration or multi-step subtasks. Input: prompt, optional subagent_type (explore|general).',
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Task for the subagent to perform',
        },
        subagent_type: {
          type: 'string',
          description: 'explore (read-only) or general (default)',
        },
      },
      required: ['prompt'],
    },
    async call(input, ctx) {
      const prompt = String(input.prompt ?? '').trim()
      if (!prompt) {
        return {
          ok: false,
          isError: true,
          output: 'Agent tool requires non-empty prompt',
          errorCode: 'empty_prompt',
        }
      }

      const parent = ctx.extras?.subagentParent as
        | SubagentParentContext
        | undefined
      if (!parent?.deps) {
        return {
          ok: false,
          isError: true,
          output:
            'Agent tool missing parent context (subagentParent). Use session tools from core createDefaultTools().',
          errorCode: 'no_parent',
        }
      }

      let def: AgentDefinition
      try {
        def = getAgentDefinition(
          input.subagent_type != null
            ? String(input.subagent_type)
            : 'general',
        )
      } catch (e) {
        return {
          ok: false,
          isError: true,
          output: e instanceof Error ? e.message : String(e),
          errorCode: 'unknown_type',
        }
      }

      const result = await runSubagent({
        def,
        prompt,
        parentSessionId: parent.parentSessionId,
        cwd: parent.cwd,
        hooks: parent.hooks,
        deps: parent.deps,
        permissionMode: parent.permissionMode,
        askPermission: parent.askPermission,
        allTools: parent.allTools,
        skills: parent.skills,
        signal: parent.signal ?? ctx.signal,
        onEvent: parent.onEvent,
      })

      const header = `[subagent ${result.agentType} ${result.agentId}]`
      const body = result.summary
      return {
        ok: !result.isError,
        isError: result.isError,
        output: `${header}\n${body}`,
        errorCode: result.isError ? 'subagent_failed' : undefined,
      }
    },
  })
}

/** 主会话默认工具集：内置 + Agent */
export function createDefaultTools(): BoloTool[] {
  return [...createBuiltinTools(), createAgentTool()]
}

/**
 * 从父会话上下文启动子 agent（替换旧 stub）。
 * 无 prompt 时使用占位任务（仅调试）；生产路径应走 Agent 工具。
 */
export async function spawnSubagent(
  parent: {
    id: string
    cwd: string
    hooks: HooksConfig
    deps: QueryDeps
    permissionMode: PermissionMode
    askPermission: AskPermissionFn
    skills?: LoadedSkill[]
    onEvent?: (e: QueryLoopEvent) => void
  },
  agentType: string,
  prompt?: string,
): Promise<RunSubagentResult> {
  const def = getAgentDefinition(agentType)
  return runSubagent({
    def,
    prompt:
      prompt ??
      `You are a ${def.agentType} subagent. Await a real task from the parent.`,
    parentSessionId: parent.id,
    cwd: parent.cwd,
    hooks: parent.hooks,
    deps: parent.deps,
    permissionMode: parent.permissionMode,
    askPermission: parent.askPermission,
    allTools: createDefaultTools(),
    skills: parent.skills,
    onEvent: parent.onEvent,
  })
}

/** @deprecated 使用 spawnSubagent / runSubagent；保留别名避免外部 import 断裂 */
export const spawnSubagentStub = spawnSubagent