/**
 * Subagent 最小完成线测试 — mock 父调 Agent → 子返回文本 → tool_result 含摘要
 * 运行：npx tsx scripts/test-subagent.ts
 */

import {
  createSession,
  submitPrompt,
  resolveAgentTools,
  getAgentDefinition,
  createDefaultTools,
  createAgentTool,
  AGENT_TOOL_NAME,
  EXPLORE_AGENT,
  GENERAL_AGENT,
  runSubagent,
  identityPrepareMessages,
  type QueryDeps,
} from '../packages/core/src/index.ts'
import { createBuiltinTools, findToolByName } from '../packages/tools/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
} from '../packages/providers/src/index.ts'

function assert(c: unknown, m: string): asserts c {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

function toolNames(options?: CompleteStreamOptions): string[] {
  return (options?.tools ?? []).map((t) => t.name)
}

/**
 * 父子共用 provider：
 * - 主线程 tools 含 Agent → 调 Agent
 * - 子线程无 Agent → 直接返回摘要文本
 */
function createNestedMockProvider(): LlmProvider {
  return {
    id: 'mock',
    async *completeStream(
      messages: ChatMessage[],
      options?: CompleteStreamOptions,
    ): AsyncIterable<ProviderStreamEvent> {
      const names = toolNames(options)
      const hasAgent = names.includes(AGENT_TOOL_NAME)
      const hasToolResult = messages.some((m) => m.role === 'tool')

      if (hasAgent && !hasToolResult) {
        yield { type: 'text_delta', text: 'Parent will spawn agent.\n' }
        yield {
          type: 'tool_call',
          id: 'call_agent_1',
          name: AGENT_TOOL_NAME,
          arguments: JSON.stringify({
            prompt: 'Reply with exactly: SUBAGENT_OK_SUMMARY',
            subagent_type: 'general',
          }),
        }
        yield { type: 'done' }
        return
      }

      if (hasAgent && hasToolResult) {
        const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
        yield { type: 'text_delta', text: 'Parent done. Tool output included.\n' }
        if (lastTool?.content) {
          yield { type: 'text_delta', text: lastTool.content }
        }
        yield { type: 'done' }
        return
      }

      // 子 agent：无 Agent 工具
      yield { type: 'text_delta', text: 'SUBAGENT_OK_SUMMARY' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'n/a'
    },
  }
}

async function main() {
  // --- resolveAgentTools ---
  const all = createDefaultTools()
  assert(findToolByName(all, AGENT_TOOL_NAME), 'default tools include Agent')
  assert(
    !findToolByName(all, AGENT_TOOL_NAME)!.isConcurrencySafe({}),
    'Agent not concurrency safe',
  )

  const exploreTools = resolveAgentTools(EXPLORE_AGENT, all)
  assert(
    exploreTools.resolvedTools.every((t) =>
      ['Read', 'Glob', 'Grep'].includes(t.name),
    ),
    'explore only Read/Glob/Grep',
  )
  assert(
    !exploreTools.resolvedTools.some((t) => t.name === AGENT_TOOL_NAME),
    'explore has no Agent',
  )

  const generalTools = resolveAgentTools(GENERAL_AGENT, all)
  assert(
    !generalTools.resolvedTools.some((t) => t.name === AGENT_TOOL_NAME),
    'general excludes Agent',
  )
  assert(
    generalTools.resolvedTools.some((t) => t.name === 'Write'),
    'general keeps Write',
  )

  const def = getAgentDefinition('explore')
  assert(def.agentType === 'explore', 'get explore')

  // --- runSubagent 直接 ---
  const childProvider: LlmProvider = {
    id: 'mock',
    async *completeStream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'text_delta', text: 'direct child report' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'n/a'
    },
  }
  const childDeps: QueryDeps = {
    callModel: async function* ({ messages, signal, tools }) {
      yield* childProvider.completeStream(messages, {
        signal,
        tools: tools as CompleteStreamOptions['tools'],
      })
    },
    prepareMessages: identityPrepareMessages,
    uuid: () => 'uuid_test_1',
  }
  const direct = await runSubagent({
    def: getAgentDefinition('general'),
    prompt: 'do a thing',
    parentSessionId: 'sess_parent',
    cwd: process.cwd(),
    hooks: {
      SubagentStart: [
        {
          hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
        },
      ],
      SubagentStop: [
        {
          hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }],
        },
      ],
    },
    deps: childDeps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    allTools: createBuiltinTools(),
  })
  assert(direct.summary.includes('direct child report'), 'direct summary')
  assert(!direct.isError, 'direct ok')
  assert(direct.agentId.startsWith('agent'), 'agent id')

  // --- 父 session 调 Agent 工具 ---
  const provider = createNestedMockProvider()
  const log: string[] = []
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    systemPrompt: false,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    onEvent: (e) => {
      if (e.type === 'tool_start') log.push(`start:${e.name}`)
      if (e.type === 'tool_end')
        log.push(`end:${e.name}:${e.ok}:${e.output.slice(0, 200)}`)
      if (e.type === 'text') log.push(`text:${e.text}`)
    },
  })

  const terminal = await submitPrompt(session, 'please use Agent')
  assert(terminal.reason === 'completed', `terminal ${terminal.reason}`)

  const joined = log.join('\n')
  assert(joined.includes('start:Agent'), 'tool_start Agent')
  assert(joined.includes('end:Agent:true'), `tool_end Agent ok: ${joined}`)
  assert(
    joined.includes('SUBAGENT_OK_SUMMARY'),
    `summary in result: ${joined}`,
  )
  assert(joined.includes('[subagent general'), 'header with type')

  assert(createAgentTool().name === 'Agent', 'createAgentTool name')

  console.log('PASS test-subagent')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})