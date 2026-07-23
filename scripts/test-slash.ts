/**
 * 斜杠命令测试（无 LLM）
 * 运行：npx tsx scripts/test-slash.ts
 */
import {
  createSession,
  parseSlashLine,
  submitUserInput,
  dispatchSlashCommand,
  type BoloSession,
} from '../packages/core/src/index.ts'
import {
  parseArgs,
  renderWelcomeBanner,
  shouldUsePlainBanner,
} from '../packages/cli/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // ── parseSlashLine ──
  assert(parseSlashLine('').kind === 'empty', 'empty')
  assert(parseSlashLine('   ').kind === 'empty', 'whitespace empty')

  const p1 = parseSlashLine('/help')
  assert(p1.kind === 'command' && p1.name === 'help' && p1.args === '', '/help')

  const p2 = parseSlashLine('/model gpt-4o')
  assert(
    p2.kind === 'command' && p2.name === 'model' && p2.args === 'gpt-4o',
    '/model args',
  )

  const p3 = parseSlashLine('// not a command')
  assert(p3.kind === 'prompt', '// is prompt')

  const p4 = parseSlashLine('hello world')
  assert(p4.kind === 'prompt' && p4.text === 'hello world', 'plain prompt')

  const p5 = parseSlashLine('  /EFFORT high  ')
  assert(
    p5.kind === 'command' && p5.name === 'effort' && p5.args === 'high',
    'case + trim',
  )

  // ── session commands（无 LLM）──
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    permissionMode: 'default',
    model: 'mock-a',
  })
  session.messages.push(
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  )
  const sysKeep = [...session.systemPromptSections]

  // /help
  const help = await submitUserInput(session, '/help')
  assert(help.type === 'slash', 'help is slash')
  if (help.type === 'slash') {
    assert(help.message.includes('/clear'), 'help lists clear')
    assert(help.message.includes('/effort'), 'help lists effort')
  }

  // /context
  const ctx = await submitUserInput(session, '/context')
  assert(ctx.type === 'slash', 'context slash')
  if (ctx.type === 'slash') {
    assert(ctx.message.includes(session.id), 'context id')
    assert(ctx.message.includes('messages:'), 'context msgs')
    assert(ctx.message.includes('mock-a'), 'context model')
  }

  // /model
  const m0 = await dispatchSlashCommand(session, 'model', '')
  assert(m0.message.includes('mock-a'), 'model show')
  const m1 = await dispatchSlashCommand(session, 'model', 'mock-b')
  assert(m1.ok && session.model === 'mock-b', 'model set')

  // /effort
  const e0 = await dispatchSlashCommand(session, 'effort', '')
  assert(e0.message.includes('auto') || e0.message.includes('effort'), 'effort show')
  const e1 = await dispatchSlashCommand(session, 'effort', 'high')
  assert(e1.ok && session.effortLevel === 'high', 'effort high')
  const e2 = await dispatchSlashCommand(session, 'effort', 'auto')
  assert(e2.ok && session.effortLevel === undefined, 'effort auto clears')

  // /plan
  const plan = await dispatchSlashCommand(session, 'plan', '')
  assert(plan.ok && session.permissionMode === 'plan', 'plan mode')

  // /permissions
  const perm = await dispatchSlashCommand(session, 'permissions', 'default')
  assert(perm.ok && session.permissionMode === 'default', 'permissions set')

  // /clear — 保留 system
  const sysBefore = session.systemPromptSections.length
  const clear = await submitUserInput(session, '/clear')
  assert(clear.type === 'slash', 'clear slash')
  assert(session.messages.length === 0, 'messages cleared')
  assert(
    session.systemPromptSections.length === sysBefore,
    'system sections kept',
  )
  assert(
    JSON.stringify(session.systemPromptSections) === JSON.stringify(sysKeep),
    'system content same',
  )

  // /compact 无 summarizer
  const compact = await submitUserInput(session, '/compact')
  assert(compact.type === 'slash', 'compact slash')
  if (compact.type === 'slash') {
    assert(
      compact.message.toLowerCase().includes('summarizer') ||
        compact.message.toLowerCase().includes('compact failed'),
      'compact no summarizer message',
    )
  }

  // 未知命令
  const unk = await submitUserInput(session, '/nope')
  assert(unk.type === 'slash', 'unknown is slash not LLM')
  if (unk.type === 'slash') {
    assert(unk.message.toLowerCase().includes('unknown'), 'unknown msg')
  }

  // empty
  const empty = await submitUserInput(session, '   ')
  assert(empty.type === 'empty', 'empty input')

  // ── banner plain ──
  assert(shouldUsePlainBanner({ plain: true }) === true, 'plain opt')
  assert(
    shouldUsePlainBanner({ env: { NO_COLOR: '1' } as NodeJS.ProcessEnv }) ===
      true,
    'NO_COLOR',
  )
  const plain = renderWelcomeBanner({ plain: true, version: '0.0.1' })
  assert(plain.includes('BOLO'), 'plain contains BOLO')
  assert(!plain.includes('Bolot') || plain === 'BOLO · v0.0.1' || plain.startsWith('BOLO'), 'plain short')

  const full = renderWelcomeBanner({
    plain: false,
    version: '0.0.1',
    cwd: '/tmp/proj',
    model: 'm1',
  })
  assert(full.includes('BOLO') || full.includes('| __ )'), 'full art has BOLO shape')
  assert(full.includes('Bolot'), 'full has Bolot')
  assert(full.includes('0.0.1'), 'version')
  assert(full.includes('/tmp/proj'), 'cwd')

  const condensed = renderWelcomeBanner({
    condensed: true,
    sessionId: 'sess_x',
  })
  assert(condensed.includes('BOLO'), 'condensed BOLO')
  assert(condensed.includes('sess_x'), 'condensed id')

  // ── parseArgs 无参不崩 ──
  const bare = parseArgs([])
  assert(bare.help === false && bare.resume === undefined, 'bare parse')
  const helpArgs = parseArgs(['--help'])
  assert(helpArgs.help === true, 'help flag')

  console.log('ok: test-slash')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})