/**
 * CTX-2: resolved model metadata runtime consumers and persistence.
 *
 * Run: npm run test:model-metadata-runtime
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  loadWorkspace,
  normalizeProviderRegistry,
  type ResolvedModelMetadata,
} from '../packages/config/src/index.ts'
import {
  buildContextUsageViewModel,
  createAutoCompactPrepare,
  createSession,
  createSessionFromWorkspace,
  parseSessionSnapshot,
  resumeSessionFromWorkspace,
  saveSession,
  switchSessionModel,
  switchSessionProvider,
  writeTranscriptAfterCompact,
} from '../packages/core/src/index.ts'
import { createMockProvider } from '../packages/providers/src/index.ts'
import {
  formatSkillCatalog,
  type LoadedSkill,
} from '../packages/skills/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

async function writeConfig(
  configDir: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  )
}

function metadata(
  providerId: string,
  model: string,
  contextWindowTokens: number,
  maxOutputTokens: number,
): ResolvedModelMetadata {
  return {
    providerId,
    model,
    contextWindowTokens,
    maxOutputTokens,
    sources: {
      contextWindow: 'model',
      maxOutput: 'model',
    },
    usedFallback: false,
    warnings: [],
  }
}

function fixtureSkills(count = 24): LoadedSkill[] {
  return Array.from({ length: count }, (_, index) => ({
    meta: {
      id: `ctx-skill-${index}`,
      name: `CTX Skill ${index}`,
      description: `Runtime metadata budget fixture ${index} ${'x'.repeat(220)}`,
      path: `/virtual/ctx-skill-${index}/SKILL.md`,
    },
    source: 'project' as const,
    body: 'fixture',
    frontmatter: {},
  }))
}

async function drainCall(
  session: Awaited<ReturnType<typeof createSession>>,
): Promise<void> {
  for await (const _event of session.deps.callModel({
    messages: [{ role: 'user', content: 'runtime metadata request' }],
    model: session.model,
  })) {
    // Drain the provider stream so the captured request body is complete.
  }
}

async function main(): Promise<void> {
  const root = path.join(process.cwd(), '.bolo-tmp', 'model-metadata-runtime')
  const userDir = path.join(root, 'user')
  const cwd = path.join(root, 'workspace')
  const sessionsDir = path.join(root, 'sessions')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(path.join(cwd, '.bolo'), { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = userDir

  try {
    const defaultWorkspace = await loadWorkspace({
      cwd,
      materializeUserState: false,
      loadPlugins: false,
    })
    assert(
      defaultWorkspace.resolvedModel.contextWindowTokens === 128_000 &&
        defaultWorkspace.resolvedModel.sources.contextWindow === 'catalog' &&
        defaultWorkspace.legacyContextWindowTokens === undefined,
      'built-in default model uses catalog rather than explicit legacy metadata',
    )

    await writeConfig(userDir, {
      defaultProvider: 'unknown',
      providers: {
        unknown: {
          kind: 'mock',
          model: 'uncatalogued-v1',
        },
      },
    })
    const fallbackWorkspace = await loadWorkspace({
      cwd,
      materializeUserState: false,
      loadPlugins: false,
    })
    assert(
      fallbackWorkspace.resolvedModel.contextWindowTokens === 128_000 &&
        fallbackWorkspace.resolvedModel.sources.contextWindow === 'fallback' &&
        fallbackWorkspace.legacyContextWindowTokens === undefined,
      'injected top-level default remains fallback for an unknown model',
    )

    await writeConfig(userDir, {
      defaultProvider: 'small',
      contextWindowTokens: 64_000,
      providers: {
        small: {
          kind: 'mock',
          model: 'small-v1',
          contextWindowTokens: 32_000,
          maxTokens: 4_096,
          models: {
            'small-v2': {
              contextWindowTokens: 128_000,
              maxTokens: 12_000,
            },
          },
        },
        huge: {
          kind: 'mock',
          model: 'huge-v1',
          contextWindowTokens: 1_000_000,
          maxTokens: 64_000,
        },
      },
    })

    const workspace = await loadWorkspace({
      cwd,
      materializeUserState: false,
      loadPlugins: false,
    })
    assert(
      workspace.resolvedModel.contextWindowTokens === 32_000,
      'workspace resolves active provider context',
    )
    assert(
      workspace.resolvedModel.maxOutputTokens === 4_096,
      'workspace resolves active provider output',
    )

    const created = await createSessionFromWorkspace({
      cwd,
      materializeUserState: false,
      connectMcp: false,
      systemPrompt: false,
    })
    assert(
      created.session.resolvedModel.contextWindowTokens === 32_000,
      'workspace create stores resolved metadata',
    )
    assert(
      created.session.contextWindowTokens === 32_000 &&
        created.session.maxOutputTokens === 4_096,
      'workspace create keeps compatibility projections in sync',
    )

    let dynamicWindow = 32_000
    let compactRuns = 0
    const dynamicPrepare = createAutoCompactPrepare({
      enabled: true,
      getContextWindowTokens: () => dynamicWindow,
      runAutoCompact: async (messages) => {
        compactRuns += 1
        return messages
      },
    })
    const longMessages: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(120_000) },
    ]
    const firstPrepared = await dynamicPrepare({
      messages: longMessages,
      querySource: 'repl_main_thread',
      tokenCount: 0,
    })
    assert(
      firstPrepared.didCompact === true && compactRuns === 1,
      'small dynamic window triggers auto compact',
    )
    dynamicWindow = 1_000_000
    const secondPrepared = await dynamicPrepare({
      messages: longMessages,
      querySource: 'repl_main_thread',
      tokenCount: 0,
    })
    assert(
      secondPrepared.didCompact !== true && compactRuns === 1,
      'same prepare closure reads the new dynamic window',
    )

    const skills = fixtureSkills()
    const requestBodies: Array<Record<string, unknown>> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      )
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
          'data: [DONE]\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    }) as typeof fetch

    try {
      const registry = normalizeProviderRegistry({
        defaultProvider: 'local',
        providers: {
          local: {
            kind: 'mock',
            model: 'local-v1',
            contextWindowTokens: 32_000,
            maxTokens: 4_096,
          },
          net: {
            kind: 'openai-compatible',
            baseUrl: 'https://ctx-runtime.invalid/v1',
            apiKey: 'test-only-key',
            model: 'net-v1',
            models: {
              'net-v1': {
                contextWindowTokens: 32_000,
                maxTokens: 4_096,
              },
              'net-v2': {
                contextWindowTokens: 128_000,
                maxTokens: 12_000,
              },
            },
          },
          huge: {
            kind: 'mock',
            model: 'huge-v1',
            contextWindowTokens: 1_000_000,
            maxTokens: 64_000,
          },
          locked: {
            kind: 'openai-compatible',
            apiKeyEnv: 'BOLO_CTX2_KEY_THAT_DOES_NOT_EXIST',
            model: 'locked-v1',
            contextWindowTokens: 200_000,
            maxTokens: 16_000,
          },
        },
      })
      const runtime = await createSession({
        cwd,
        provider: createMockProvider(),
        providerRegistry: registry,
        providerId: 'local',
        providerProfile: registry.profiles.local,
        resolvedModel: metadata('local', 'local-v1', 32_000, 4_096),
        skills,
        systemPrompt: {
          skills,
          loadInstructions: false,
          loadRules: false,
        },
        compactSummarizer: async ({ compactPrompt }) => {
          if (compactPrompt.includes('memory daily log')) return { text: '' }
          return { text: 'compact fixture' }
        },
        microcompact: false,
        snip: false,
      })
      const prepareBeforeSwitch = runtime.deps.prepareMessages
      const initialView = buildContextUsageViewModel(runtime)
      assert(
        initialView.usage.windowTokens === 32_000 &&
          initialView.skills.budgetChars === 1_280,
        'dashboard and skills start from resolved 32k window',
      )

      const toNet = switchSessionProvider(runtime, 'net')
      assert(toNet.ok, 'provider switch to net succeeds')
      assert(
        runtime.resolvedModel.model === 'net-v1' &&
          runtime.contextWindowTokens === 32_000 &&
          runtime.maxOutputTokens === 4_096,
        'provider switch commits metadata projections',
      )
      assert(
        runtime.deps.prepareMessages === prepareBeforeSwitch,
        'provider switch does not rebuild the dynamic prepare chain',
      )
      await drainCall(runtime)
      assert(
        Number(requestBodies.at(-1)?.max_tokens) === 4_096,
        'provider request uses resolved net-v1 output baseline',
      )

      const toNetV2 = switchSessionModel(runtime, 'net-v2')
      assert(toNetV2.ok, 'model switch to net-v2 succeeds')
      assert(
        runtime.resolvedModel.contextWindowTokens === 128_000 &&
          Number(runtime.maxOutputTokens) === 12_000,
        'model switch resolves exact model metadata',
      )
      await drainCall(runtime)
      assert(
        Number(requestBodies.at(-1)?.max_tokens) === 12_000,
        'model switch rebuilds provider output baseline',
      )

      const toHuge = switchSessionProvider(runtime, 'huge')
      assert(toHuge.ok, 'provider switch to 1m model succeeds')
      const hugeView = buildContextUsageViewModel(runtime)
      assert(
        hugeView.usage.windowTokens === 1_000_000 &&
          hugeView.skills.budgetChars === 12_000,
        'dashboard and skills switch to the same 1m window',
      )
      const expectedHugeCatalog = formatSkillCatalog(skills, {
        contextWindowTokens: 1_000_000,
      })
      assert(
        runtime.systemPromptSections.includes(expectedHugeCatalog),
        'hot switch refreshes the skill catalog with the target budget',
      )

      const rollback = {
        provider: runtime.provider,
        callModel: runtime.deps.callModel,
        model: runtime.model,
        providerId: runtime.providerId,
        resolved: runtime.resolvedModel,
        context: runtime.contextWindowTokens,
        output: runtime.maxOutputTokens,
        sections: [...runtime.systemPromptSections],
      }
      const failed = switchSessionProvider(runtime, 'locked')
      assert(!failed.ok, 'missing-key provider switch fails')
      assert(
        runtime.provider === rollback.provider &&
          runtime.deps.callModel === rollback.callModel &&
          runtime.model === rollback.model &&
          runtime.providerId === rollback.providerId &&
          runtime.resolvedModel === rollback.resolved &&
          runtime.contextWindowTokens === rollback.context &&
          runtime.maxOutputTokens === rollback.output &&
          JSON.stringify(runtime.systemPromptSections) ===
            JSON.stringify(rollback.sections),
        'failed provider switch rolls back every runtime projection',
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    await writeConfig(userDir, {
      defaultProvider: 'resume',
      providers: {
        resume: {
          kind: 'mock',
          model: 'resume-a',
          models: {
            'resume-a': {
              contextWindowTokens: 32_000,
              maxTokens: 4_096,
            },
            'resume-b': {
              contextWindowTokens: 200_000,
              maxTokens: 16_000,
            },
          },
        },
      },
    })
    const persisted = await createSessionFromWorkspace({
      cwd,
      materializeUserState: false,
      connectMcp: false,
      systemPrompt: false,
    })
    persisted.session.messages.push({ role: 'user', content: 'before switch' })
    await saveSession(persisted.session, { sessionsDir })
    const switched = switchSessionModel(persisted.session, 'resume-b')
    assert(switched.ok, 'persisted session switches to resume-b')
    persisted.session.messages.push({ role: 'assistant', content: 'after switch' })
    const saved = await saveSession(persisted.session, { sessionsDir })
    assert(saved.transcriptPath, 'default save returns the JSONL path')
    const transcriptEntries = (
      await fs.readFile(saved.transcriptPath, 'utf8')
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    assert(
      transcriptEntries[0]?.type === 'meta',
      'JSONL keeps meta as the first line',
    )
    const runtimeStates = transcriptEntries.filter(
      (entry) => entry.type === 'session_state',
    )
    assert(
      runtimeStates.length === 1 &&
        (
          runtimeStates[0]?.resolvedModel as
            | ResolvedModelMetadata
            | undefined
        )?.model === 'resume-b',
      'JSONL appends exactly one runtime state when model metadata changes',
    )
    await saveSession(persisted.session, { sessionsDir })
    const unchangedEntries = (
      await fs.readFile(saved.transcriptPath, 'utf8')
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    assert(
      unchangedEntries.filter((entry) => entry.type === 'session_state')
        .length === 1,
      'unchanged runtime metadata does not append a duplicate session_state',
    )
    await writeTranscriptAfterCompact(persisted.session, {
      filePath: saved.transcriptPath,
      createdAt: saved.snapshot.createdAt,
    })
    await saveSession(persisted.session, { sessionsDir })
    const rewrittenEntries = (
      await fs.readFile(saved.transcriptPath, 'utf8')
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    assert(
      rewrittenEntries.filter((entry) => entry.type === 'session_state')
        .length === 0 &&
        (
          rewrittenEntries[0]?.resolvedModel as
            | ResolvedModelMetadata
            | undefined
        )?.model === 'resume-b',
      'compact rewrite folds runtime metadata into meta without a redundant state',
    )
    const parsed = parseSessionSnapshot(
      JSON.parse(JSON.stringify(saved.snapshot)),
    )
    assert(
      parsed.resolvedModel?.model === 'resume-b' &&
        parsed.resolvedModel.contextWindowTokens === 200_000,
      'JSON snapshot roundtrips resolved model metadata',
    )
    const rejectedMetadata = parseSessionSnapshot({
      ...saved.snapshot,
      contextWindowTokens: 32_000,
      maxOutputTokens: 64_000,
      resolvedModel: {
        ...metadata('resume', 'resume-b', 32_000, 4_096),
        maxOutputTokens: 64_000,
      },
    })
    assert(
      rejectedMetadata.resolvedModel === undefined &&
        rejectedMetadata.contextWindowTokens === 32_000 &&
        rejectedMetadata.maxOutputTokens === undefined,
      'persisted metadata parser rejects output limits larger than context',
    )
    await fs.writeFile(
      path.join(sessionsDir, `${persisted.session.id}.json`),
      `${JSON.stringify(
        {
          ...saved.snapshot,
          model: 'resume-a',
          providerId: 'resume',
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
          resolvedModel: metadata(
            'resume',
            'resume-a',
            32_000,
            4_096,
          ),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    await writeConfig(userDir, {
      defaultProvider: 'resume',
      providers: {
        resume: {
          kind: 'mock',
          model: 'resume-a',
          models: {
            'resume-b': {
              contextWindowTokens: 1_000_000,
              maxTokens: 64_000,
            },
          },
        },
      },
    })
    const currentConfig = await resumeSessionFromWorkspace({
      idOrPath: persisted.session.id,
      cwd,
      sessionsDir,
      materializeUserState: false,
      connectMcp: false,
      systemPrompt: false,
      reassembleSystem: false,
    })
    assert(
      currentConfig.session.model === 'resume-b' &&
        currentConfig.session.resolvedModel.contextWindowTokens === 1_000_000 &&
        currentConfig.session.resolvedModel.sources.contextWindow === 'model',
      'resume prefers current config for the snapshot provider/model identity',
    )

    await writeConfig(userDir, {
      defaultProvider: 'resume',
      providers: {
        resume: {
          kind: 'mock',
          model: 'resume-a',
        },
      },
    })
    const snapshotFallback = await resumeSessionFromWorkspace({
      idOrPath: persisted.session.id,
      cwd,
      sessionsDir,
      materializeUserState: false,
      connectMcp: false,
      systemPrompt: false,
      reassembleSystem: false,
    })
    assert(
      snapshotFallback.session.model === 'resume-b' &&
        snapshotFallback.session.resolvedModel.contextWindowTokens ===
          200_000 &&
        snapshotFallback.session.resolvedModel.maxOutputTokens === 16_000 &&
        snapshotFallback.session.resolvedModel.sources.contextWindow ===
          'snapshot',
      'JSONL session_state restores matching snapshot metadata as fallback',
    )

    await writeConfig(userDir, {
      defaultProvider: 'resume',
      contextWindowTokens: 96_000,
      providers: {
        resume: {
          kind: 'mock',
          model: 'resume-a',
        },
      },
    })
    const explicitLegacy = await resumeSessionFromWorkspace({
      idOrPath: persisted.session.id,
      cwd,
      sessionsDir,
      materializeUserState: false,
      connectMcp: false,
      systemPrompt: false,
      reassembleSystem: false,
    })
    assert(
      explicitLegacy.session.model === 'resume-b' &&
        explicitLegacy.session.resolvedModel.contextWindowTokens === 96_000 &&
        explicitLegacy.session.resolvedModel.sources.contextWindow === 'legacy',
      'explicit current legacy config takes precedence over snapshot fallback',
    )
  } finally {
    if (previousConfigDir === undefined) delete process.env.BOLO_CONFIG_DIR
    else process.env.BOLO_CONFIG_DIR = previousConfigDir
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log('PASS: CTX-2 model metadata runtime consumers')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
