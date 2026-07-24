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
  formatSessionStatusLine,
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
    assert(ctx.message.includes('usage:'), 'context has usage line')
  }

  // /doctor · /status（极简本地诊断）
  const doctor = await submitUserInput(session, '/doctor')
  assert(doctor.type === 'slash', 'doctor slash')
  if (doctor.type === 'slash') {
    assert(doctor.message.includes(session.cwd), 'doctor has cwd')
    assert(
      doctor.message.includes(`permissionMode:  ${session.permissionMode}`) ||
        doctor.message.includes(session.permissionMode),
      'doctor has mode',
    )
    assert(doctor.message.includes(process.version), 'doctor has node')
    assert(doctor.message.includes(process.platform), 'doctor has platform')
    assert(doctor.message.includes(session.id), 'doctor has session id')
    assert(doctor.message.includes('tools:'), 'doctor has tools count')
    assert(doctor.message.includes('skills:'), 'doctor has skills count')
    assert(doctor.message.includes('agent types:'), 'doctor has agent types')
    assert(
      doctor.message.includes('provider:') &&
        doctor.message.includes('mock'),
      'doctor has provider id',
    )
    assert(
      doctor.message.includes('mcp connections:'),
      'doctor always shows mcp line',
    )
    assert(doctor.message.includes('usage:'), 'doctor has usage line')
    assert(doctor.message.includes('autoCompact:'), 'doctor has autoCompact')
    assert(doctor.message.includes('maxPtlRetries:'), 'doctor has maxPtlRetries')
    assert(
      doctor.message.includes('~/.bolo:') || doctor.message.includes('.bolo'),
      'doctor has bolo home path',
    )
  }
  const statusCmd = await submitUserInput(session, '/status')
  assert(statusCmd.type === 'slash', 'status slash')
  if (statusCmd.type === 'slash' && doctor.type === 'slash') {
    assert(statusCmd.message === doctor.message, '/status alias of /doctor')
    assert(statusCmd.message.includes(session.cwd), 'status has cwd')
    assert(
      statusCmd.message.includes(session.permissionMode),
      'status has mode',
    )
  }

  // /mcp 无连接
  const mcpNone = await submitUserInput(session, '/mcp')
  assert(mcpNone.type === 'slash', 'mcp slash')
  if (mcpNone.type === 'slash') {
    assert(
      mcpNone.message.includes('none') || mcpNone.message.includes('mcp'),
      'mcp empty message',
    )
  }
  session.mcpConnections = [
    {
      name: 'echo',
      tools: [{ name: 'ping', description: 'Ping tool' }],
    },
  ]
  const mcpList = await submitUserInput(session, '/mcp')
  assert(mcpList.type === 'slash' && mcpList.message.includes('echo'), 'mcp list server')
  const mcpTools = await submitUserInput(session, '/mcp tools')
  assert(
    mcpTools.type === 'slash' &&
      mcpTools.message.includes('mcp__echo__ping'),
    'mcp tools namespaced',
  )
  session.mcpConnections = []

  // /cost 初始为空
  const cost0 = await submitUserInput(session, '/cost')
  assert(cost0.type === 'slash', 'cost slash')
  if (cost0.type === 'slash') {
    assert(
      cost0.message.toLowerCase().includes('none') ||
        cost0.message.includes('calls:'),
      'cost shows empty or zero',
    )
  }

  // mock 几轮 callModel 后 /cost 非空
  const r1 = await submitUserInput(session, 'hello usage one')
  assert(r1.type === 'prompt', 'prompt 1')
  const r2 = await submitUserInput(session, 'hello usage two')
  assert(r2.type === 'prompt', 'prompt 2')
  assert(session.usage && session.usage.calls >= 1, 'usage calls after mock')
  assert(
    session.usage!.totalTokens > 0 || session.usage!.inputTokens > 0,
    'usage tokens non-zero',
  )
  const cost1 = await submitUserInput(session, '/cost')
  assert(cost1.type === 'slash', 'cost after mock')
  if (cost1.type === 'slash') {
    assert(cost1.message.includes('calls:'), 'cost has calls')
    assert(
      !cost1.message.includes('(none yet'),
      'cost not empty after mock rounds',
    )
  }
  const usageAlias = await submitUserInput(session, '/usage')
  assert(usageAlias.type === 'slash', '/usage alias')
  if (usageAlias.type === 'slash') {
    assert(usageAlias.message.includes('calls:'), '/usage same as cost')
  }
  const ctx2 = await submitUserInput(session, '/context')
  if (ctx2.type === 'slash') {
    assert(
      /usage:\s+\d+ tokens/.test(ctx2.message),
      'context usage line after calls',
    )
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

  // /allow
  const allow0 = await dispatchSlashCommand(session, 'allow', '')
  assert(allow0.ok && allow0.message.includes('always-allow'), 'allow list empty')
  const allow1 = await dispatchSlashCommand(session, 'allow', 'Bash')
  assert(allow1.ok && session.permissionRules?.alwaysAllowToolNames.includes('Bash'), 'allow add Bash')
  const allow2 = await dispatchSlashCommand(session, 'allow', '')
  assert(allow2.message.includes('Bash'), 'allow list has Bash')

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

  // skill 回落：/skill-creator（挂 mock skill）
  session.skills = [
    {
      meta: {
        id: 'skill-creator',
        name: 'skill-creator',
        description: 'mock creator',
        path: '/tmp/skill-creator/SKILL.md',
        userInvocable: true,
      },
      source: 'bundled',
      body: 'CREATE A SKILL STEPS',
      frontmatter: {},
    },
  ]
  const beforeMsgs = session.messages.length
  const sc = await submitUserInput(session, '/skill-creator')
  assert(sc.type === 'slash', 'skill-creator slash')
  if (sc.type === 'slash') {
    assert(sc.message.toLowerCase().includes('skill-creator'), 'loaded msg')
  }
  assert(session.messages.length === beforeMsgs + 1, 'skill injected as msg')
  assert(
    session.messages[session.messages.length - 1]!.content.includes(
      'CREATE A SKILL STEPS',
    ),
    'skill body in message',
  )

  const skillCmd = await submitUserInput(session, '/skill skill-creator')
  assert(skillCmd.type === 'slash', '/skill <id>')
  if (skillCmd.type === 'slash') {
    assert(skillCmd.message.toLowerCase().includes('loaded'), '/skill loaded')
  }

  const skillsList = await submitUserInput(session, '/skills')
  assert(skillsList.type === 'slash', '/skills')
  if (skillsList.type === 'slash') {
    assert(skillsList.message.includes('skill-creator'), '/skills lists id')
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

  // ── T3 status line ──
  const status = formatSessionStatusLine({
    permissionMode: 'plan',
    model: 'm1',
    effortLevel: 'high',
    messages: [{}, {}, {}],
  })
  assert(
    status === 'mode=plan · model=m1 · effort=high · messages=3',
    `status line: ${status}`,
  )
  const statusDefault = formatSessionStatusLine({ messages: [] })
  assert(
    statusDefault ===
      'mode=default · model=(unset) · effort=auto · messages=0',
    `status defaults: ${statusDefault}`,
  )

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