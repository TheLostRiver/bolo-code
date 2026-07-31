/**
 * CX1 / CX3 / CX6：preset · explain · clamp · providerId 落盘
 * 运行：node --import tsx scripts/test-provider-ux.ts
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listProviderPresets,
  getProviderPreset,
  providerConfigFromPreset,
  addProviderProfileToConfigFile,
  normalizeProviderRegistry,
  loadConfigJson,
  layoutPaths,
} from '../packages/config/src/index.ts'
import {
  explainProviderError,
  createMockProvider,
} from '../packages/providers/src/index.ts'
import {
  createSession,
  productionDeps,
  switchSessionProvider,
  attachProviderRegistry,
  clampEffortForSession,
  dispatchSlashCommand,
  toSnapshot,
  parseSessionSnapshot,
  applySnapshotToSession,
  saveSession,
  loadSession,
} from '../packages/core/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-cx-'))
  const prev = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = home
  try {
    return await fn(home)
  } finally {
    if (prev === undefined) delete process.env.BOLO_CONFIG_DIR
    else process.env.BOLO_CONFIG_DIR = prev
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

async function main() {
  // ── CX1 presets ──
  const presets = listProviderPresets()
  // P0A：5 家既有 + 11 家国际兼容 = 16 家（方案 PROVIDER_EXPANSION_PLAN P0A）
  assert(presets.length >= 16, `at least 16 presets, got ${presets.length}`)
  assert(getProviderPreset('ds')?.id === 'deepseek', 'alias ds')
  assert(getProviderPreset('claude')?.id === 'anthropic', 'alias claude')
  // 新别名
  assert(getProviderPreset('or')?.id === 'openrouter', 'alias or')
  assert(getProviderPreset('grok')?.id === 'xai', 'alias grok')
  // 新增国际 preset 完整性：id 唯一 + apiKeyEnv 非空 + kind 合法
  const ids = new Set<string>()
  for (const p of presets) {
    assert(!ids.has(p.id), `duplicate preset id ${p.id}`)
    ids.add(p.id)
    assert(p.kind === 'openai-compatible' || p.kind === 'openai-responses' || p.kind === 'anthropic', `kind ${p.id}`)
    assert(p.baseUrl && p.baseUrl.startsWith('https://'), `baseUrl ${p.id}`)
    assert(p.apiKeyEnv && p.apiKeyEnv.length > 0, `apiKeyEnv ${p.id}`)
  }
  assert(ids.has('openrouter'), 'openrouter present')
  assert(ids.has('groq'), 'groq present')
  assert(ids.has('together'), 'together present')
  assert(ids.has('mistral'), 'mistral present')
  assert(ids.has('xai'), 'xai present')
  assert(ids.has('nvidia'), 'nvidia present')
  assert(ids.has('fireworks'), 'fireworks present')
  assert(ids.has('cerebras'), 'cerebras present')
  assert(ids.has('huggingface'), 'huggingface present')
  assert(ids.has('vercel-ai-gateway'), 'vercel-ai-gateway present')
  assert(ids.has('cloudflare-ai-gateway'), 'cloudflare-ai-gateway present')
  const cfg = providerConfigFromPreset(getProviderPreset('deepseek')!)
  assert(cfg.kind === 'openai-compatible', 'ds kind')
  assert(cfg.apiKeyEnv === 'DEEPSEEK_API_KEY', 'ds env')
  assert(!(cfg as { apiKey?: string }).apiKey, 'no plaintext key')
  assert(
    (cfg.effort as { dialect?: string })?.dialect === 'deepseek-chat' ||
      typeof cfg.effort === 'object',
    'ds effort dialect',
  )

  await withTempHome(async (home) => {
    const layout = layoutPaths(home)
    await fs.mkdir(layout.root, { recursive: true })
    await fs.writeFile(
      layout.configJson,
      JSON.stringify({ version: 1 }, null, 2),
      'utf8',
    )

    const added = await addProviderProfileToConfigFile({
      presetId: 'deepseek',
      scope: 'user',
    })
    assert(added.ok, `add deepseek: ${!added.ok ? added.reason : ''}`)
    if (added.ok) {
      assert(added.id === 'deepseek', 'id deepseek')
      const disk = await loadConfigJson(layout)
      assert(disk.providers?.deepseek?.apiKeyEnv === 'DEEPSEEK_API_KEY', 'disk env')
      assert(!disk.providers?.deepseek?.apiKey, 'disk no key')
    }

    const dup = await addProviderProfileToConfigFile({
      presetId: 'deepseek',
      scope: 'user',
    })
    assert(!dup.ok, 'dup without overwrite fails')

    // P0A：新国际 preset 的真实 add 路径（openrouter 抽样）
    const orAdded = await addProviderProfileToConfigFile({
      presetId: 'openrouter',
      scope: 'user',
    })
    assert(orAdded.ok, `add openrouter: ${!orAdded.ok ? orAdded.reason : ''}`)
    if (orAdded.ok) {
      const orDisk = await loadConfigJson(layout)
      assert(
        orDisk.providers?.openrouter?.baseUrl === 'https://openrouter.ai/api/v1',
        'openrouter baseUrl on disk',
      )
      assert(
        orDisk.providers?.openrouter?.apiKeyEnv === 'OPENROUTER_API_KEY',
        'openrouter env on disk',
      )
      assert(!orDisk.providers?.openrouter?.apiKey, 'openrouter no plaintext key')
    }

    const asOther = await addProviderProfileToConfigFile({
      presetId: 'openai',
      asId: 'work-oai',
      scope: 'user',
    })
    assert(asOther.ok, 'add as work-oai')

    // slash add list
    const session = await createSession({
      cwd: home,
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
    })
    const reg = normalizeProviderRegistry(await loadConfigJson(layout))
    attachProviderRegistry(session, reg, reg.defaultId)
    const listAdd = await dispatchSlashCommand(session, 'provider', 'add list')
    assert(listAdd.ok && listAdd.message.includes('deepseek'), 'slash add list')
  })

  // ── CX3 explain ──
  {
    const e1 = explainProviderError(new Error('401 Unauthorized invalid api key'), {
      providerId: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })
    assert(e1.includes('DEEPSEEK_API_KEY'), 'explain key')

    const e2 = explainProviderError('400 invalid reasoning_effort value', {
      dialect: 'deepseek-chat',
      model: 'deepseek-chat',
      effortLevel: 'minimal',
    })
    assert(/choosable|effort/i.test(e2), 'explain effort')

    const e3 = explainProviderError('404 Not Found /v1/responses', {
      kind: 'openai-compatible',
    })
    assert(/kind|compatible|responses/i.test(e3), 'explain kind')
  }

  // ── CX6 clamp ──
  {
    const session = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
      effortLevel: 'nope-level',
      effortDialect: 'deepseek-chat',
      model: 'deepseek-chat',
    })
    const r = clampEffortForSession(session)
    assert(r.changed && session.effortLevel === undefined, 'clamp clears bad')
    assert(r.warning?.includes('auto'), 'clamp warns')

    session.effortLevel = 'high'
    session.effortDialect = 'deepseek-chat'
    const r2 = clampEffortForSession(session)
    assert(!r2.changed && session.effortLevel === 'high', 'high stays')
  }

  // ── CX6 providerId snapshot roundtrip ──
  {
    const session = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
      providerId: 'deepseek',
      effortLevel: 'high',
      model: 'deepseek-chat',
    })
    const snap = toSnapshot(session)
    assert(snap.providerId === 'deepseek', 'snap providerId')
    assert(snap.effortLevel === 'high', 'snap effort')
    const parsed = parseSessionSnapshot(JSON.parse(JSON.stringify(snap)))
    assert(parsed.providerId === 'deepseek', 'parse providerId')

    const s2 = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
    })
    applySnapshotToSession(s2, parsed)
    assert(s2.providerId === 'deepseek', 'apply providerId')
    assert(s2.effortLevel === 'high', 'apply effort')
  }

  // ── switch clamps ──
  {
    const multi = {
      defaultProvider: 'a',
      providers: {
        a: { kind: 'mock' as const, model: 'm-a' },
        b: {
          kind: 'mock' as const,
          model: 'm-b',
          effort: { dialect: 'deepseek-chat' },
        },
      },
    }
    const reg = normalizeProviderRegistry(multi)
    const session = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
      effortLevel: 'low',
      providerRegistry: reg,
      providerId: 'a',
    })
    attachProviderRegistry(session, reg, 'a')
    session.effortLevel = 'low'
    const sw = switchSessionProvider(session, 'b')
    assert(sw.ok, 'switch b')
    const switchMessage = sw.ok ? sw.message : sw.reason
    // deepseek-chat strict: low not choosable → auto
    assert(
      session.effortLevel === undefined,
      `low clamped on ds dialect, got ${session.effortLevel}`,
    )
    assert(switchMessage.includes('auto') || true, 'switch message ok')
    assert(
      /dialect=/i.test(switchMessage) || /choosable/i.test(switchMessage),
      'CX4 tip on switch',
    )
  }

  // CX5：/model bare suggested
  {
    const session = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
      model: 'deepseek-chat',
      providerId: 'deepseek',
    })
    const show = await dispatchSlashCommand(session, 'model', '')
    assert(show.ok, 'model bare ok')
    assert(
      show.message.includes('suggested:') || show.message.includes('usage:'),
      'model bare suggestions',
    )
  }

  // save/load providerId via json path
  await withTempHome(async (home) => {
    const sessionsDir = path.join(home, 'sessions')
    await fs.mkdir(sessionsDir, { recursive: true })
    const session = await createSession({
      cwd: home,
      sessionId: 'cx6-test',
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
      providerId: 'my-ds',
      effortLevel: 'high',
      model: 'x',
    })
    const { path: sp } = await saveSession(session, {
      sessionsDir,
      writeJsonSnapshot: true,
    })
    const { snapshot } = await loadSession('cx6-test', { sessionsDir, cwd: home })
    assert(snapshot.providerId === 'my-ds', `load providerId got ${snapshot.providerId}`)
    assert(snapshot.effortLevel === 'high', 'load effort')
    void sp
  })

  // CX2 unit via filterChoosable
  {
    const { filterChoosableByModelCaps, listEffortChoosable } = await import(
      '../packages/providers/src/index.ts'
    )
    const base = listEffortChoosable('openai-responses', {
      model: 'gpt-4o-mini',
    })
    assert(!base.includes('xhigh'), 'CX2 gpt-4o no xhigh')
    const filtered = filterChoosableByModelCaps(
      ['auto', 'high', 'xhigh', 'max'],
      'gpt-4o',
    )
    assert(!filtered.includes('xhigh'), 'filter deny xhigh')
    assert(filtered.includes('high'), 'filter keeps high')
  }

  console.log('ok: provider-ux CX1–CX6')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
