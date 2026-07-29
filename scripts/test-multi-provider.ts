/**
 * 多 provider 配置 + 热切（P1–P3）
 * 运行：npx tsx scripts/test-multi-provider.ts
 */

import {
  normalizeProviderRegistry,
  mergeConfigs,
  resolveProviderFromConfig,
  type BoloConfigJson,
} from '../packages/config/src/index.ts'
import {
  createProviderFromProfile,
  createMockProvider,
} from '../packages/providers/src/index.ts'
import {
  createSession,
  productionDeps,
  switchSessionProvider,
  switchSessionModel,
  dispatchSlashCommand,
  listSessionProviders,
  buildProviderPickerItems,
  activeProviderPickerIndex,
} from '../packages/core/src/index.ts'
import {
  applyArrowPickerKey,
  formatArrowPickerScreen,
  runNumberedArrowPicker,
} from '../packages/cli/src/tui/arrowPicker.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  // 隔离 env，避免本机 key 干扰
  const prev = {
    BOLO_PROVIDER: process.env.BOLO_PROVIDER,
    BOLO_API_KEY: process.env.BOLO_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  }
  process.env.BOLO_PROVIDER = 'mock'
  delete process.env.BOLO_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.DEEPSEEK_API_KEY

  // ── 1. 旧 provider 合成 default ──
  const legacy: BoloConfigJson = {
    provider: { kind: 'mock', model: 'legacy-m' },
  }
  const reg1 = normalizeProviderRegistry(legacy)
  assert(reg1.defaultId === 'default', 'legacy defaultId')
  assert(reg1.profiles.default?.model === 'legacy-m', 'legacy model')
  assert(reg1.profiles.default?.kind === 'mock', 'legacy kind mock')

  // ── 2. providers map + defaultProvider ──
  const multi: BoloConfigJson = {
    defaultProvider: 'work',
    providers: {
      work: {
        kind: 'mock',
        model: 'work-model',
        label: 'Work',
      },
      deepseek: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
      claude: {
        kind: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
    },
  }
  const reg2 = normalizeProviderRegistry(multi)
  assert(reg2.defaultId === 'work', 'defaultProvider work')
  assert(Object.keys(reg2.profiles).length === 3, '3 profiles')
  assert(reg2.profiles.deepseek?.apiKeyEnv === 'DEEPSEEK_API_KEY', 'apiKeyEnv')

  // ── 3. mergeConfigs 合并 providers ──
  const merged = mergeConfigs(
    {
      providers: {
        work: { kind: 'mock', model: 'a' },
        x: { kind: 'mock', model: 'x1' },
      },
      defaultProvider: 'work',
    },
    {
      providers: {
        work: { model: 'b' },
        y: { kind: 'mock', model: 'y1' },
      },
      defaultProvider: 'y',
    },
  )
  assert(merged.providers?.work?.model === 'b', 'merge profile field')
  assert(merged.providers?.work?.kind === 'mock', 'merge keeps kind')
  assert(merged.providers?.x?.model === 'x1', 'merge keeps base-only')
  assert(merged.providers?.y?.model === 'y1', 'merge adds over')
  assert(merged.defaultProvider === 'y', 'merge defaultProvider')

  // ── 4. resolveProviderFromConfig 走 default ──
  const resolved = resolveProviderFromConfig(multi)
  assert(resolved.profileId === 'work', 'resolve active work')
  assert(resolved.kind === 'mock', 'resolve kind mock')
  assert(resolved.model === 'work-model', 'resolve model')

  // ── 5. createProviderFromProfile 缺 key → missingKey ──
  const miss = createProviderFromProfile({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  })
  assert(miss.missingKey === true, 'missing key flagged')
  assert(miss.kind === 'mock', 'missing key falls to mock instance')

  process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-not-real'
  const okDs = createProviderFromProfile({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  })
  assert(okDs.missingKey !== true, 'key from apiKeyEnv')
  assert(okDs.kind === 'openai-compatible', 'kind openai-compatible')
  assert(okDs.baseUrl?.includes('deepseek'), 'base deepseek')
  delete process.env.DEEPSEEK_API_KEY

  // ── 6. session 热切 ──
  const provider = createMockProvider()
  const session = await createSession({
    cwd: process.cwd(),
    provider,
    deps: productionDeps(provider),
    systemPrompt: false,
    model: 'work-model',
    providerRegistry: reg2,
    providerId: 'work',
    providerProfile: reg2.profiles.work,
    askPermission: async () => 'allow',
  })
  assert(session.providerId === 'work', 'session providerId')
  const callBefore = session.deps.callModel

  // 无 key 的 deepseek 应失败并保留 work
  const bad = switchSessionProvider(session, 'deepseek')
  assert(bad.ok === false, 'switch missing key fails')
  assert(session.providerId === 'work', 'kept work after fail')
  assert(session.deps.callModel === callBefore, 'deps unchanged on fail')

  // mock 之间可切（claude 无 key 也会失败）
  const badClaude = switchSessionProvider(session, 'claude')
  assert(badClaude.ok === false, 'claude missing key fails')

  // 给 deepseek 假 key 后可切
  process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-not-real'
  const good = switchSessionProvider(session, 'deepseek')
  assert(good.ok === true, 'switch deepseek ok')
  if (good.ok) {
    assert(good.providerId === 'deepseek', 'switched id')
    assert(good.kind === 'openai-compatible', 'switched kind')
  }
  assert(session.providerId === 'deepseek', 'session id deepseek')
  assert(session.provider.id === 'openai-compatible', 'provider protocol id')
  assert(session.model === 'deepseek-chat', 'model from profile')
  assert(session.deps.callModel !== callBefore, 'callModel rebound')
  assert(
    session.promptCacheState?.lastBreakReason === 'forced',
    'prompt cache forced break',
  )

  // 再切回 work（mock）
  const back = switchSessionProvider(session, 'work', { model: 'work-2' })
  assert(back.ok === true, 'switch back work')
  assert(session.providerId === 'work', 'back work')
  assert(session.model === 'work-2', 'model override')
  assert(session.provider.id === 'mock', 'kind mock again')

  // switchSessionModel
  const m = switchSessionModel(session, 'work-3')
  assert(m.ok === true, 'model switch')
  assert(session.model === 'work-3', 'model work-3')

  // list
  const listed = listSessionProviders(session)
  assert(listed.length === 3, 'list 3')
  assert(listed.some((p) => p.id === 'work' && p.isActive), 'work active')

  // slash /provider 无参：文本 + renderer-neutral action picker。
  const listSlash = await dispatchSlashCommand(session, 'provider', '')
  assert(listSlash.ok, 'slash provider list ok')
  assert(listSlash.message?.includes('deepseek'), 'slash lists deepseek')
  assert(listSlash.message?.includes('work'), 'slash lists work')
  assert(
    listSlash.overlayView?.kind === 'action-picker' &&
      listSlash.overlayView.action === 'provider',
    'bare /provider exposes structured picker data',
  )

  const listOnly = await dispatchSlashCommand(session, 'provider', 'list')
  assert(listOnly.ok, 'provider list ok')
  assert(
    listOnly.overlayView == null,
    'list subcommand no picker signal',
  )

  // picker items / active index（纯数据，供 CLI）
  const pickItems = buildProviderPickerItems(session)
  assert(pickItems.length === 3, 'picker items 3')
  assert(
    pickItems.every((it) => it.id && it.label),
    'picker labels',
  )
  const aidx = activeProviderPickerIndex(session)
  assert(aidx >= 0 && aidx < pickItems.length, 'active index in range')
  assert(pickItems[aidx]!.id === session.providerId, 'active index matches')

  // shared arrow reducer + plain numbered fallback（不占真 TTY）
  const expectedIndex = (aidx + 1) % pickItems.length
  const ar = await runNumberedArrowPicker({
    items: pickItems,
    writeOut: () => {},
    readLine: async () => String(expectedIndex + 1),
    title: 'Select provider',
    initialIndex: aidx,
  })
  assert(ar.ok === true, 'numbered pick ok')
  if (ar.ok) {
    const expectId = pickItems[expectedIndex]!.id
    assert(ar.id === expectId, `picked ${expectId}`)
  }
  const screen = formatArrowPickerScreen(pickItems, 0, {
    title: 'Select provider',
  })
  assert(screen.includes('Select provider'), 'picker title')
  assert(applyArrowPickerKey(0, 3, 'down').index === 1, 'arrow down')

  process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-not-real'
  const useSlash = await dispatchSlashCommand(
    session,
    'provider',
    'use deepseek',
  )
  assert(useSlash.ok, `slash use: ${useSlash.message}`)
  assert(session.providerId === 'deepseek', 'slash switched')
  assert(useSlash.overlayView == null, 'use has no picker signal')
  // CX4：热切 tip 含 dialect / choosable
  assert(
    /dialect=/i.test(useSlash.message ?? '') ||
      /choosable/i.test(useSlash.message ?? ''),
    'switch tip has dialect or choosable',
  )

  // /model provider/model 糖
  const modelSlash = await dispatchSlashCommand(
    session,
    'model',
    'work/special-m',
  )
  assert(modelSlash.ok, `model sugar: ${modelSlash.message}`)
  assert(session.providerId === 'work', 'sugar provider')
  assert(session.model === 'special-m', 'sugar model')

  const showModel = await dispatchSlashCommand(session, 'model', '')
  assert(showModel.message?.includes('special-m'), 'show model')
  assert(showModel.message?.includes('work'), 'show provider id')
  // CX5：建议列表或 usage
  assert(
    /suggested:|usage:/i.test(showModel.message ?? ''),
    'model bare shows suggested or usage',
  )

  const doctor = await dispatchSlashCommand(session, 'doctor', '')
  assert(doctor.ok, 'doctor ok')
  assert(
    doctor.message?.includes('work') || doctor.message?.includes('provider:'),
    'doctor shows provider',
  )

  // 未知 id
  const unk = switchSessionProvider(session, 'nope')
  assert(unk.ok === false, 'unknown id fails')
  assert(session.providerId === 'work', 'still work after unknown')

  // restore env
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  console.log('ok: multi-provider P1–P4 + picker')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
