/**
 * Subagent 最小完成线 + S7 项目 agents 目录测试
 * 运行：npx tsx scripts/test-subagent.ts
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureProjectLayout } from '../packages/config/src/index.ts'
import {
  createSession,
  submitPrompt,
  resolveAgentTools,
  getAgentDefinition,
  createDefaultTools,
  createAgentTool,
  createBackgroundAgentStore,
  AGENT_TOOL_NAME,
  EXPLORE_AGENT,
  GENERAL_AGENT,
  PLAN_AGENT,
  runSubagent,
  identityPrepareMessages,
  loadAgentsDir,
  mergeAgentDefinitions,
  listActiveAgents,
  createEmptySessionUsage,
  countToolUses,
  finalizeSubagentStats,
  formatSubagentToolOutput,
  buildAgentToolDescription,
  type QueryDeps,
} from '../packages/core/src/index.ts'
import { createBuiltinTools, findToolByName } from '../packages/tools/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type {
  CompleteStreamOptions,
  LlmProvider,
  ProviderStreamEvent,
} from '../packages/providers/src/index.ts'
import { dispatchSlashCommand } from '../packages/core/src/slash.ts'

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

async function testProjectAgentsDir(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-agents-'))
  const userRoot = path.join(tmp, 'user-bolo')
  try {
    const ensured = await ensureProjectLayout(tmp, { writeDefaults: false })
    assert(
      ensured.layout.agentsDir === path.join(tmp, '.bolo', 'agents'),
      'layout.agentsDir',
    )
    const st = await fs.stat(ensured.layout.agentsDir)
    assert(st.isDirectory(), 'ensureProjectLayout creates agents/')

    // 覆盖内置 explore description
    await fs.writeFile(
      path.join(ensured.layout.agentsDir, 'explore.md'),
      `---
name: explore
description: PROJECT_EXPLORE_DESC_OVERRIDE
tools:
  - Read
  - Glob
  - Grep
permissionMode: default
---

You are project explore. Report PROJECT_EXPLORE_SYSTEM.
`,
      'utf8',
    )

    // 新类型
    await fs.writeFile(
      path.join(ensured.layout.agentsDir, 'reviewer.md'),
      `---
agentType: reviewer
description: Custom reviewer subagent
tools: Read, Grep
permissionMode: plan
---

You are a code reviewer. Summarize findings only.
`,
      'utf8',
    )

    const loaded = await loadAgentsDir({
      cwd: tmp,
      userConfigDir: userRoot,
      loadUserAgents: true,
    })
    assert(loaded.errors.length === 0, `load errors: ${loaded.errors.join('; ')}`)

    const explore = getAgentDefinition('explore', loaded.active)
    assert(
      explore.description === 'PROJECT_EXPLORE_DESC_OVERRIDE',
      `explore desc override: ${explore.description}`,
    )
    assert(explore.source === 'project', 'explore source project')
    assert(
      explore.systemPrompt.includes('PROJECT_EXPLORE_SYSTEM'),
      'explore system body',
    )

    const reviewer = getAgentDefinition('reviewer', loaded.active)
    assert(reviewer.agentType === 'reviewer', 'reviewer type')
    assert(reviewer.permissionMode === 'plan', 'reviewer mode')
    assert(
      Array.isArray(reviewer.tools) &&
        reviewer.tools.includes('Read') &&
        reviewer.tools.includes('Grep'),
      'reviewer tools',
    )

    // runSubagent resolve 项目类型
    const childProvider: LlmProvider = {
      id: 'mock',
      async *completeStream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: 'text_delta', text: 'reviewer ok' }
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
      uuid: () => 'uuid_reviewer_1',
    }
    const ran = await runSubagent({
      def: getAgentDefinition('reviewer', loaded.active),
      prompt: 'review this',
      parentSessionId: 'sess_p',
      cwd: tmp,
      hooks: {},
      deps: childDeps,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      allTools: createBuiltinTools(),
    })
    assert(ran.summary.includes('reviewer ok'), 'project type runSubagent')
    assert(!ran.isError, 'project type ok')

    // createSession 装入 active + /agents
    const session = await createSession({
      cwd: tmp,
      provider: createNestedMockProvider(),
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      agentDefinitions: loaded.active,
    })
    assert(
      session.agentDefinitions?.explore?.description ===
        'PROJECT_EXPLORE_DESC_OVERRIDE',
      'session agentDefinitions',
    )
    const slash = await dispatchSlashCommand(session, 'agents', '')
    assert(slash.ok, 'slash /agents ok')
    assert(slash.message.includes('reviewer'), `/agents lists reviewer: ${slash.message}`)
    assert(
      slash.message.includes('PROJECT_EXPLORE_DESC_OVERRIDE'),
      '/agents lists override desc',
    )

    // Agent 工具能 resolve 项目类型
    const tool = createAgentTool(loaded.active)
    const toolResult = await tool.call(
      { prompt: 'hi', subagent_type: 'reviewer' },
      {
        cwd: tmp,
        sessionId: 's1',
        extras: {
          subagentParent: {
            parentSessionId: 's1',
            cwd: tmp,
            hooks: {},
            deps: childDeps,
            permissionMode: 'bypassPermissions' as const,
            askPermission: async () => 'allow' as const,
            allTools: createBuiltinTools(),
            agentDefinitions: loaded.active,
          },
        },
      },
    )
    assert(toolResult.ok, `Agent tool project type: ${toolResult.output}`)
    assert(
      toolResult.output.includes('[subagent reviewer'),
      `header: ${toolResult.output}`,
    )
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
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

  // --- 侧链 transcript ---
  const sideTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-side-'))
  const sideSessions = path.join(sideTmp, 'sessions')
  let stopPath: string | undefined
  const side = await runSubagent({
    def: getAgentDefinition('general'),
    prompt: 'sidechain me',
    parentSessionId: 'sess_side_parent',
    cwd: sideTmp,
    hooks: {
      SubagentStop: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'node -e "const fs=require(\'fs\');const d=JSON.parse(fs.readFileSync(0,\'utf8\'));if(d.agent_transcript_path)fs.writeFileSync(process.env.BOLO_SIDE_MARK,d.agent_transcript_path)"',
            },
          ],
        },
      ],
    },
    deps: childDeps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    allTools: createBuiltinTools(),
    writeTranscript: sideSessions,
  })
  assert(side.agentTranscriptPath, 'side transcript path returned')
  assert(
    side.agentTranscriptPath!.includes(`agent-${side.agentId}`),
    'side path has agent id',
  )
  const sideBody = await fs.readFile(side.agentTranscriptPath!, 'utf8')
  assert(sideBody.includes('direct child report') || sideBody.includes('sidechain me'), 'side jsonl has messages')
  assert(sideBody.includes('"type":"meta"') || sideBody.includes('"type": "meta"'), 'side has meta')

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

  // --- S12 background Agent ---
  await testBackgroundSubagent()

  // --- S12 fork inherits parent messages ---
  await testForkSubagent()

  // --- polish: maxTurns / disallowedTools / parent usage rollup ---
  await testSubagentUsageAndLimits()

  // --- polish: plan builtin + finalize stats + description ---
  await testPlanAndFinalize()

  // --- S7 project agents ---
  await testProjectAgentsDir()
  assert(
    listActiveAgents(mergeAgentDefinitions([])).some(
      (a) => a.agentType === 'general',
    ),
    'merge keeps builtins',
  )
  assert(
    listActiveAgents().some((a) => a.agentType === 'plan'),
    'builtin plan agent present',
  )

  console.log('PASS test-subagent')
}

async function testSubagentUsageAndLimits(): Promise<void> {
  // disallowedTools 二次剔除
  const banned = resolveAgentTools(
    { tools: '*', disallowedTools: ['Write', 'Edit'] },
    createDefaultTools(),
  )
  assert(
    !banned.resolvedTools.some((t) => t.name === 'Write' || t.name === 'Edit'),
    'disallowedTools strips Write/Edit',
  )
  assert(
    banned.resolvedTools.some((t) => t.name === 'Read'),
    'disallowedTools keeps Read',
  )
  assert(
    !banned.resolvedTools.some((t) => t.name === AGENT_TOOL_NAME),
    'disallowed still no Agent',
  )

  // maxTurns=1：子若试图 tool 后仍会停
  let childCalls = 0
  const limitedProvider: LlmProvider = {
    id: 'mock',
    async *completeStream(
      _messages: ChatMessage[],
      options?: CompleteStreamOptions,
    ): AsyncIterable<ProviderStreamEvent> {
      childCalls += 1
      const names = toolNames(options)
      if (childCalls === 1 && names.includes('Read')) {
        yield {
          type: 'tool_call',
          id: 'call_read_1',
          name: 'Read',
          arguments: JSON.stringify({ path: 'package.json' }),
        }
        yield { type: 'done' }
        return
      }
      yield { type: 'text_delta', text: 'SHOULD_NOT_REACH_IF_MAX1' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'n/a'
    },
  }
  const limitedDeps: QueryDeps = {
    callModel: async function* ({ messages, signal, tools }) {
      yield* limitedProvider.completeStream(messages, {
        signal,
        tools: tools as CompleteStreamOptions['tools'],
      })
    },
    prepareMessages: identityPrepareMessages,
    uuid: () => `uuid_lim_${childCalls}`,
  }
  const parentUsage = createEmptySessionUsage()
  const limited = await runSubagent({
    def: {
      ...getAgentDefinition('general'),
      maxTurns: 1,
      tools: ['Read'],
    },
    prompt: 'read something',
    parentSessionId: 'sess_lim',
    cwd: process.cwd(),
    hooks: {},
    deps: limitedDeps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    allTools: createBuiltinTools(),
    parentUsage,
    model: 'mock-sub',
    writeTranscript: false,
  })
  // maxTurns=1：第一轮 tool_call 后 turn 用尽，可能无最终 assistant 文本
  assert(childCalls === 1, `maxTurns=1 only one model call, got ${childCalls}`)
  assert(limited.usage != null && limited.usage.calls >= 1, 'child usage tracked')
  assert(parentUsage.calls >= 1, 'parent usage rollup after subagent')
  assert(
    parentUsage.totalTokens === limited.usage!.totalTokens,
    'parent totals match child after merge',
  )
  assert(
    parentUsage.byModel?.['mock-sub'] != null || limited.usage!.calls > 0,
    'byModel or estimated child calls present',
  )

  // Agent 工具 max_turns + parentUsage 注入
  childCalls = 0
  const toolProvider: LlmProvider = {
    id: 'mock',
    async *completeStream(): AsyncIterable<ProviderStreamEvent> {
      childCalls += 1
      yield {
        type: 'usage',
        usage: {
          inputTokens: 30,
          outputTokens: 10,
          totalTokens: 40,
          cacheReadInputTokens: 12,
        },
      }
      yield { type: 'text_delta', text: 'USAGE_CHILD_OK' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'n/a'
    },
  }
  const toolDeps: QueryDeps = {
    callModel: async function* ({ messages, signal, tools }) {
      yield* toolProvider.completeStream(messages, {
        signal,
        tools: tools as CompleteStreamOptions['tools'],
      })
    },
    prepareMessages: identityPrepareMessages,
    uuid: () => 'uuid_usage_tool',
  }
  const parentU2 = createEmptySessionUsage()
  const tool = createAgentTool()
  const tr = await tool.call(
    {
      prompt: 'report usage',
      subagent_type: 'general',
      max_turns: 2,
    },
    {
      cwd: process.cwd(),
      sessionId: 'sess_usage_tool',
      extras: {
        writeTranscript: false,
        subagentParent: {
          parentSessionId: 'sess_usage_tool',
          cwd: process.cwd(),
          hooks: {},
          deps: toolDeps,
          permissionMode: 'bypassPermissions' as const,
          askPermission: async () => 'allow' as const,
          allTools: createBuiltinTools(),
          parentUsage: parentU2,
          model: 'mock-parent-model',
        },
      },
    },
  )
  assert(tr.ok, `usage tool ok: ${tr.output}`)
  assert(tr.output.includes('USAGE_CHILD_OK'), 'usage summary')
  assert(
    /stats:.*40 tokens/.test(tr.output) || /40 tokens/.test(tr.output),
    `tool output usage/stats line: ${tr.output}`,
  )
  assert(parentU2.calls >= 1, 'tool path parentUsage rollup')
  assert((parentU2.cacheReadInputTokens ?? 0) >= 12, 'cache read rolled up')
  assert(
    parentU2.byModel?.['mock-parent-model'] != null,
    'parent model tag on child usage',
  )
}

async function testPlanAndFinalize(): Promise<void> {
  // plan builtin resolve
  const plan = getAgentDefinition('plan')
  assert(plan.agentType === 'plan', 'plan type')
  assert(plan.permissionMode === 'plan', 'plan mode')
  const planTools = resolveAgentTools(plan, createDefaultTools())
  assert(
    planTools.resolvedTools.every((t) =>
      ['Read', 'Glob', 'Grep'].includes(t.name),
    ),
    'plan only read tools',
  )
  assert(
    !planTools.resolvedTools.some((t) =>
      ['Write', 'Edit', 'Bash', AGENT_TOOL_NAME].includes(t.name),
    ),
    'plan bans write/bash/agent',
  )

  // explore disallowed strips bash even if tools were *
  const exploreTools = resolveAgentTools(EXPLORE_AGENT, createDefaultTools())
  assert(
    !exploreTools.resolvedTools.some((t) => t.name === 'Bash'),
    'explore no Bash via disallowed',
  )

  // countToolUses + finalize
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'x' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: '1', name: 'Read', arguments: '{}' },
        { id: '2', name: 'Grep', arguments: '{}' },
      ],
    },
    { role: 'tool', content: 'ok' },
    { role: 'assistant', content: 'done' },
  ]
  assert(countToolUses(msgs) === 2, 'countToolUses 2')
  const st = finalizeSubagentStats({
    messages: msgs,
    startTimeMs: Date.now() - 1500,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1 },
  })
  assert(st.totalToolUseCount === 2, 'finalize tools')
  assert(st.totalTokens === 15, 'finalize tokens')
  assert(st.totalDurationMs >= 1000, 'finalize duration')

  const out = formatSubagentToolOutput({
    agentType: 'plan',
    agentId: 'agent_x',
    summary: 'PLAN_OK',
    description: 'ship plan',
    totalDurationMs: 1500,
    totalToolUseCount: 2,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1 },
  })
  assert(out.includes('[subagent plan agent_x]'), 'format header')
  assert(out.includes('task: ship plan'), 'format task')
  assert(out.includes('stats:'), 'format stats')
  assert(out.includes('tools 2'), 'format tools count')

  const desc = buildAgentToolDescription()
  assert(desc.includes('plan:'), 'tool desc lists plan')
  assert(desc.includes('explore:'), 'tool desc lists explore')

  // run plan subagent
  const planProvider: LlmProvider = {
    id: 'mock',
    async *completeStream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'text_delta', text: '### Critical Files\n- a.ts\nPLAN_DONE' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'n/a'
    },
  }
  const planDeps: QueryDeps = {
    callModel: async function* ({ messages, signal, tools }) {
      yield* planProvider.completeStream(messages, {
        signal,
        tools: tools as CompleteStreamOptions['tools'],
      })
    },
    prepareMessages: identityPrepareMessages,
    uuid: () => 'uuid_plan_1',
  }
  const ran = await runSubagent({
    def: PLAN_AGENT,
    prompt: 'plan a feature',
    description: 'feature plan',
    parentSessionId: 'sess_plan',
    cwd: process.cwd(),
    hooks: {},
    deps: planDeps,
    permissionMode: 'default',
    askPermission: async () => 'allow',
    allTools: createBuiltinTools(),
    writeTranscript: false,
  })
  assert(!ran.isError, `plan run ok: ${ran.summary}`)
  assert(ran.summary.includes('PLAN_DONE'), 'plan summary')
  assert(ran.description === 'feature plan', 'description echoed')
  assert(ran.totalDurationMs != null && ran.totalDurationMs >= 0, 'duration set')
  assert(ran.totalToolUseCount === 0, 'no tools in text-only plan')

  // Agent tool description + description field
  const tool = createAgentTool()
  assert(tool.description.includes('Available types'), 'rich tool description')
  const tr = await tool.call(
    {
      prompt: 'quick plan',
      subagent_type: 'plan',
      description: 'quick plan',
    },
    {
      cwd: process.cwd(),
      sessionId: 'sess_plan_tool',
      extras: {
        writeTranscript: false,
        subagentParent: {
          parentSessionId: 'sess_plan_tool',
          cwd: process.cwd(),
          hooks: {},
          deps: planDeps,
          permissionMode: 'default' as const,
          askPermission: async () => 'allow' as const,
          allTools: createBuiltinTools(),
        },
      },
    },
  )
  assert(tr.ok, `plan tool: ${tr.output}`)
  assert(tr.output.includes('task: quick plan'), `task line: ${tr.output}`)
  assert(tr.output.includes('stats:'), `stats line: ${tr.output}`)
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** S12：父 2 条历史 → fork 子收到历史 + 新任务；子 tools 无 Agent */
async function testForkSubagent(): Promise<void> {
  const parentHistory: ChatMessage[] = [
    { role: 'user', content: 'PARENT_HISTORY_USER_1' },
    { role: 'assistant', content: 'PARENT_HISTORY_ASSISTANT_1' },
  ]
  let sawChildMessages: ChatMessage[] | undefined
  let sawChildTools: string[] | undefined

  const forkProvider: LlmProvider = {
    id: 'mock',
    async *completeStream(
      messages: ChatMessage[],
      options?: CompleteStreamOptions,
    ): AsyncIterable<ProviderStreamEvent> {
      sawChildMessages = messages.map((m) => ({ ...m }))
      sawChildTools = toolNames(options)
      yield { type: 'text_delta', text: 'FORK_CHILD_OK' }
      yield { type: 'done' }
    },
    async completeText() {
      return 'n/a'
    },
  }
  const forkDeps: QueryDeps = {
    callModel: async function* ({ messages, signal, tools }) {
      yield* forkProvider.completeStream(messages, {
        signal,
        tools: tools as CompleteStreamOptions['tools'],
      })
    },
    prepareMessages: identityPrepareMessages,
    uuid: () => 'uuid_fork_1',
  }

  // 直接 runSubagent fork
  const direct = await runSubagent({
    def: getAgentDefinition('fork'),
    prompt: 'FORK_NEW_TASK_DIRECTIVE',
    parentSessionId: 'sess_fork_parent',
    cwd: process.cwd(),
    hooks: {},
    deps: forkDeps,
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    allTools: createDefaultTools(),
    fork: true,
    parentMessages: parentHistory,
    parentSystemPromptSections: ['parent system section'],
    writeTranscript: false,
  })
  assert(!direct.isError, `fork direct ok: ${direct.summary}`)
  assert(direct.summary.includes('FORK_CHILD_OK'), 'fork summary')
  assert(sawChildMessages, 'fork child saw messages')
  // queryLoop 会把 system sections 前缀进 callModel；会话侧应有 2 历史 + 1 任务
  const conv = sawChildMessages!.filter((m) => m.role !== 'system')
  assert(conv.length === 3, `fork conv count: ${conv.length} (raw ${sawChildMessages!.length})`)
  assert(
    conv[0]!.content === 'PARENT_HISTORY_USER_1',
    'fork keeps parent user',
  )
  assert(
    conv[1]!.content === 'PARENT_HISTORY_ASSISTANT_1',
    'fork keeps parent assistant',
  )
  assert(
    conv[2]!.content === 'FORK_NEW_TASK_DIRECTIVE',
    'fork appends directive',
  )
  assert(sawChildTools, 'fork child tools')
  assert(
    !sawChildTools!.includes(AGENT_TOOL_NAME),
    `fork tools exclude Agent: ${sawChildTools!.join(',')}`,
  )
  assert(
    sawChildTools!.includes('Read') || sawChildTools!.includes('Write'),
    'fork keeps parent-like tools',
  )

  // Agent 工具：subagent_type=fork
  sawChildMessages = undefined
  sawChildTools = undefined
  const tool = createAgentTool()
  const viaType = await tool.call(
    { prompt: 'FORK_VIA_TYPE', subagent_type: 'fork' },
    {
      cwd: process.cwd(),
      sessionId: 'sess_fork_tool',
      extras: {
        writeTranscript: false,
        subagentParent: {
          parentSessionId: 'sess_fork_tool',
          cwd: process.cwd(),
          hooks: {},
          deps: forkDeps,
          permissionMode: 'bypassPermissions' as const,
          askPermission: async () => 'allow' as const,
          allTools: createDefaultTools(),
          parentMessages: parentHistory,
          parentSystemPromptSections: ['parent sys'],
        },
      },
    },
  )
  assert(viaType.ok, `fork tool type: ${viaType.output}`)
  assert(viaType.output.includes('[subagent fork'), `header: ${viaType.output}`)
  const conv2 = (sawChildMessages ?? []).filter((m) => m.role !== 'system')
  assert(conv2.length === 3, 'fork tool inherits 2 + directive')
  assert(conv2[2]!.content === 'FORK_VIA_TYPE', 'fork tool directive')
  assert(!sawChildTools!.includes(AGENT_TOOL_NAME), 'fork tool no Agent')

  // 省略 subagent_type → fork
  sawChildMessages = undefined
  const viaOmit = await tool.call(
    { prompt: 'FORK_VIA_OMIT' },
    {
      cwd: process.cwd(),
      sessionId: 'sess_fork_omit',
      extras: {
        writeTranscript: false,
        subagentParent: {
          parentSessionId: 'sess_fork_omit',
          cwd: process.cwd(),
          hooks: {},
          deps: forkDeps,
          permissionMode: 'bypassPermissions' as const,
          askPermission: async () => 'allow' as const,
          allTools: createDefaultTools(),
          parentMessages: parentHistory,
        },
      },
    },
  )
  assert(viaOmit.ok, `fork omit type: ${viaOmit.output}`)
  assert(viaOmit.output.includes('[subagent fork'), 'omit type is fork')
  const conv3 = (sawChildMessages ?? []).filter((m) => m.role !== 'system')
  assert(conv3[2]?.content === 'FORK_VIA_OMIT', 'omit path directive')

  // 显式 fork: true
  sawChildMessages = undefined
  const viaFlag = await tool.call(
    { prompt: 'FORK_VIA_FLAG', fork: true, subagent_type: 'general' },
    {
      cwd: process.cwd(),
      sessionId: 'sess_fork_flag',
      extras: {
        writeTranscript: false,
        subagentParent: {
          parentSessionId: 'sess_fork_flag',
          cwd: process.cwd(),
          hooks: {},
          deps: forkDeps,
          permissionMode: 'bypassPermissions' as const,
          askPermission: async () => 'allow' as const,
          allTools: createDefaultTools(),
          parentMessages: parentHistory,
        },
      },
    },
  )
  assert(viaFlag.ok, `fork flag: ${viaFlag.output}`)
  assert(viaFlag.output.includes('[subagent fork'), 'fork:true forces fork')
  const conv4 = (sawChildMessages ?? []).filter((m) => m.role !== 'system')
  assert(conv4.length === 3, 'fork:true inherits history')
}

async function testBackgroundSubagent(): Promise<void> {
  const bgTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-bg-agent-'))
  try {
    const bgProvider: LlmProvider = {
      id: 'mock',
      async *completeStream(): AsyncIterable<ProviderStreamEvent> {
        // 微延迟，确保 tool_result 先返回 running
        await new Promise((r) => setTimeout(r, 5))
        yield { type: 'text_delta', text: 'BG_AGENT_DONE' }
        yield { type: 'done' }
      },
      async completeText() {
        return 'n/a'
      },
    }
    const bgDeps: QueryDeps = {
      callModel: async function* ({ messages, signal, tools }) {
        yield* bgProvider.completeStream(messages, {
          signal,
          tools: tools as CompleteStreamOptions['tools'],
        })
      },
      prepareMessages: identityPrepareMessages,
      uuid: () => 'uuid_bg_1',
    }

    const store = createBackgroundAgentStore()
    const parentMessages: ChatMessage[] = []
    const tool = createAgentTool()
    const started = await tool.call(
      {
        prompt: 'background task',
        subagent_type: 'general',
        run_in_background: true,
      },
      {
        cwd: bgTmp,
        sessionId: 'sess_bg',
        extras: {
          writeTranscript: false,
          subagentParent: {
            parentSessionId: 'sess_bg',
            cwd: bgTmp,
            hooks: {},
            deps: bgDeps,
            permissionMode: 'bypassPermissions' as const,
            askPermission: async () => 'allow' as const,
            allTools: createBuiltinTools(),
            backgroundStore: store,
            parentMessages,
          },
        },
      },
    )
    assert(started.ok, `bg start ok: ${started.output}`)
    assert(
      /started agent agent\S+ in background/i.test(started.output),
      `bg start message: ${started.output}`,
    )
    assert(
      started.output.includes('poll with') || started.output.includes('/bg'),
      'poll hint',
    )

    const runningIds = Object.keys(store.pendingAgents)
    assert(runningIds.length === 1, 'one pending agent')
    const agentId = runningIds[0]!
    assert(
      store.pendingAgents[agentId]!.status === 'running',
      'status running right after start',
    )
    assert(
      !store.backgroundAgentResults[agentId],
      'no result yet while running',
    )

    // 轮询直到 done（mock 微任务/定时）
    let done = false
    for (let i = 0; i < 50; i++) {
      await flushMicrotasks(5)
      const row =
        store.backgroundAgentResults[agentId] ?? store.pendingAgents[agentId]
      if (row && (row.status === 'done' || row.status === 'error')) {
        done = true
        assert(row.status === 'done', `bg status done: ${row.status}`)
        assert(
          (row.summary ?? '').includes('BG_AGENT_DONE'),
          `bg summary: ${row.summary}`,
        )
        break
      }
    }
    assert(done, 'background agent finished and pollable')

    const session = await createSession({
      cwd: bgTmp,
      provider: createNestedMockProvider(),
      systemPrompt: false,
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
    })
    session.backgroundAgents = store
    const statusSlash = await dispatchSlashCommand(session, 'agents', 'status')
    assert(statusSlash.ok, 'slash /agents status ok')
    assert(
      statusSlash.message.includes(agentId),
      `/agents status lists id: ${statusSlash.message}`,
    )
    assert(
      statusSlash.message.includes('done') ||
        statusSlash.message.includes('DONE') ||
        statusSlash.message.includes('BG_AGENT_DONE'),
      `/agents status summary: ${statusSlash.message}`,
    )
    assert(
      statusSlash.message.includes('total=') ||
        statusSlash.message.includes('running='),
      `/agents status counts: ${statusSlash.message}`,
    )
    const bgSlash = await dispatchSlashCommand(session, 'bg', '')
    assert(bgSlash.ok, 'slash /bg ok')
    assert(bgSlash.message.includes(agentId), '/bg lists id')

    assert(
      parentMessages.some(
        (m) =>
          m.role === 'system' &&
          m.content.includes(agentId) &&
          m.content.includes('BG_AGENT_DONE'),
      ),
      'parent system notify on finish',
    )
  } finally {
    await fs.rm(bgTmp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})