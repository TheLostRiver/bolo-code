/**
 * CX8 ultrathink — tip/turn · 默认 off
 * 运行：node --import tsx scripts/test-ultrathink.ts
 */
import {
  createSession,
  productionDeps,
  submitPrompt,
  dispatchSlashCommand,
  planUltrathinkTurn,
  resolveUltrathinkMode,
  normalizeUltrathinkMode,
  textHasUltrathink,
  ULTRATHINK_TARGET_EFFORT,
} from '../packages/core/src/index.ts'
import { createMockProvider } from '../packages/providers/src/index.ts'
import type { QueryDeps } from '../packages/core/src/deps.ts'

function assert(c: unknown, m: string): asserts c {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  // ── normalize / resolve ──
  assert(normalizeUltrathinkMode('TIP') === 'tip', 'norm tip')
  assert(normalizeUltrathinkMode('turn') === 'turn', 'norm turn')
  assert(normalizeUltrathinkMode('off') === 'off', 'norm off')
  assert(normalizeUltrathinkMode('1') === 'turn', 'norm 1→turn')
  assert(normalizeUltrathinkMode('nope') === undefined, 'norm junk')

  assert(
    resolveUltrathinkMode({}) === 'off',
    'default off',
  )
  assert(
    resolveUltrathinkMode({ configMode: 'tip' }) === 'tip',
    'config tip',
  )
  assert(
    resolveUltrathinkMode({
      configMode: 'tip',
      env: { BOLO_ULTRATHINK: 'turn' } as NodeJS.ProcessEnv,
    }) === 'turn',
    'env > config',
  )
  assert(
    resolveUltrathinkMode({
      sessionMode: 'off',
      configMode: 'turn',
      env: { BOLO_ULTRATHINK: 'tip' } as NodeJS.ProcessEnv,
    }) === 'off',
    'session > env',
  )

  assert(textHasUltrathink('please ultrathink this'), 'detect word')
  assert(!textHasUltrathink('ultra thinking'), 'no false positive space')
  assert(textHasUltrathink('ULTRATHINK!'), 'case')
  assert(ULTRATHINK_TARGET_EFFORT === 'high', 'target high')

  // ── plan: default off ──
  {
    const session = {
      effortLevel: undefined as string | undefined,
      effortDialect: 'openai-responses',
      model: 'gpt-5',
    }
    const p = planUltrathinkTurn(session, 'please ultrathink hard', {
      mode: 'off',
    })
    assert(p.detected && !p.boosted && !p.notice, 'off ignores')
  }

  // ── plan: tip ──
  {
    const p = planUltrathinkTurn(
      { effortDialect: 'openai-responses', model: 'gpt-5' },
      'ultrathink please',
      { mode: 'tip' },
    )
    assert(p.mode === 'tip' && p.detected && !p.boosted, 'tip no boost')
    assert(p.notice?.includes('/effort high'), 'tip suggests effort')
    assert(p.effectiveEffort === undefined, 'tip no effective')
  }

  // ── plan: turn boost ──
  {
    const session = {
      effortLevel: 'low',
      effortDialect: 'openai-responses' as string | undefined,
      model: 'gpt-5',
    }
    const p = planUltrathinkTurn(session, 'ultrathink now', { mode: 'turn' })
    assert(p.boosted && p.effectiveEffort === 'high', 'turn→high')
    assert(p.notice?.includes('this turn'), 'turn notice')
    assert(session.effortLevel === 'low', 'session effort untouched')
  }

  // ── plan: already high ──
  {
    const p = planUltrathinkTurn(
      {
        effortLevel: 'max',
        effortDialect: 'openai-responses',
        model: 'gpt-5',
      },
      'ultrathink',
      { mode: 'turn' },
    )
    assert(!p.boosted && p.effectiveEffort === 'max', 'keep max')
  }

  // ── plan: no keyword ──
  {
    const p = planUltrathinkTurn(
      { ultrathinkMode: 'turn', effortDialect: 'openai-responses' },
      'normal prompt',
    )
    assert(!p.detected && !p.boosted, 'no keyword')
  }

  // ── slash ──
  {
    const session = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps: productionDeps(createMockProvider()),
      systemPrompt: false,
    })
    const show = await dispatchSlashCommand(session, 'ultrathink', '')
    assert(show.ok && show.message.includes('off'), 'slash show off')

    const setTip = await dispatchSlashCommand(session, 'ultrathink', 'tip')
    assert(setTip.ok && session.ultrathinkMode === 'tip', 'slash tip')

    const setTurn = await dispatchSlashCommand(session, 'ultrathink', 'turn')
    assert(
      setTurn.ok &&
        (session.ultrathinkMode as string | undefined) === 'turn',
      'slash turn',
    )

    const setOff = await dispatchSlashCommand(session, 'ultrathink', 'off')
    assert(setOff.ok && session.ultrathinkMode === undefined, 'slash off clears')

    const bad = await dispatchSlashCommand(session, 'ultrathink', 'rainbow')
    assert(!bad.ok, 'slash bad')
  }

  // ── submitPrompt turn：本轮 effort=high，session 仍 low ──
  {
    let seenEffort: string | undefined
    const callModel: QueryDeps['callModel'] = async function* (req) {
      seenEffort = req.effort
      yield { type: 'text_delta', text: 'done-without-tools\n' }
      yield { type: 'done' }
    }
    const deps: QueryDeps = {
      callModel,
      prepareMessages: async ({ messages }) => ({ messages }),
      uuid: () => 'u1',
    }
    const session = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps,
      systemPrompt: false,
      effortLevel: 'low',
      effortDialect: 'openai-responses',
      model: 'gpt-5',
      ultrathinkMode: 'turn',
      permissionMode: 'bypassPermissions',
    })
    const warnings: string[] = []
    session.onEvent = (e) => {
      if (e.type === 'warning') warnings.push(e.message)
    }

    await submitPrompt(session, 'please ultrathink the design')
    assert(seenEffort === 'high', `callModel effort high, got ${seenEffort}`)
    assert(session.effortLevel === 'low', 'session still low')
    assert(
      warnings.some((w) => /ultrathink → high/i.test(w)),
      'warning notice',
    )
  }

  // ── submitPrompt default off：检测到词也不抬 ──
  {
    let seenEffort: string | undefined
    const deps: QueryDeps = {
      callModel: async function* (req) {
        seenEffort = req.effort
        yield { type: 'text_delta', text: 'x\n' }
        yield { type: 'done' }
      },
      prepareMessages: async ({ messages }) => ({ messages }),
      uuid: () => 'u2',
    }
    const session = await createSession({
      cwd: process.cwd(),
      provider: createMockProvider(),
      deps,
      systemPrompt: false,
      effortLevel: 'medium',
      effortDialect: 'openai-responses',
      model: 'gpt-5',
      // ultrathinkMode unset = off
      permissionMode: 'bypassPermissions',
    })
    await submitPrompt(session, 'ultrathink please')
    assert(seenEffort === 'medium', `off keeps medium, got ${seenEffort}`)
    assert(session.effortLevel === 'medium', 'session medium')
  }

  console.log('ok: ultrathink CX8')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
