/**
 * OI-15A: slash result display policy contract.
 */
import {
  createSession,
  dispatchSlashCommand,
  isSlashDisplayPolicy,
  normalizeSlashDisplayPolicy,
  resolveSlashCommandDisplay,
  SLASH_COMMANDS,
  submitUserInput,
} from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

const validPolicies = [
  {
    surface: 'history',
    tone: 'info',
    persistence: 'visual-only',
  },
  {
    surface: 'panel',
    key: 'slash:context',
    placement: 'below-composer',
    dismissOnInput: true,
    dismissOnEscape: true,
    ttlMs: 12_000,
    overflow: 'compact',
  },
  {
    surface: 'toast',
    key: 'slash:plugins:reload',
    tone: 'success',
    ttlMs: 5_000,
  },
  {
    surface: 'overlay',
    key: 'slash:diff',
    view: 'diff',
  },
] as const

for (const policy of validPolicies) {
  assert(isSlashDisplayPolicy(policy), `valid ${policy.surface} policy`)
}

const invalidPolicies: unknown[] = [
  null,
  { surface: 'unknown' },
  { surface: 'history', tone: 'info', persistence: 'session' },
  {
    surface: 'panel',
    key: '',
    placement: 'below-composer',
    dismissOnInput: true,
    dismissOnEscape: true,
    overflow: 'compact',
  },
  {
    surface: 'panel',
    key: 'slash:bad ttl',
    placement: 'below-composer',
    dismissOnInput: true,
    dismissOnEscape: true,
    ttlMs: Number.NaN,
    overflow: 'compact',
  },
  {
    surface: 'toast',
    key: 'slash:toast',
    tone: 'success',
    ttlMs: 0,
  },
  {
    surface: 'overlay',
    key: 'slash:overlay',
    view: 'terminal-owner',
  },
]

for (const policy of invalidPolicies) {
  assert(!isSlashDisplayPolicy(policy), 'invalid policy is rejected')
}

const fallback = normalizeSlashDisplayPolicy(
  {
    surface: 'toast',
    key: '',
    tone: 'success',
    ttlMs: -1,
  },
  'error',
)
assert(
  fallback.surface === 'history' &&
    fallback.tone === 'error' &&
    fallback.persistence === 'visual-only',
  'invalid policy fails closed to visual-only error history',
)

assert(SLASH_COMMANDS.length > 30, 'built-in command registry is populated')
for (const command of SLASH_COMMANDS) {
  assert(command.display !== undefined, `/${command.name} declares display`)
  const display = resolveSlashCommandDisplay(command, '', {
    ok: true,
    message: 'fixture',
  })
  assert(isSlashDisplayPolicy(display), `/${command.name} resolves valid display`)
}

const session = await createSession({
  cwd: process.cwd(),
  systemPrompt: false,
  permissionMode: 'default',
  model: 'mock-display-policy',
})

const doctorCommand = SLASH_COMMANDS.find(
  (command) => command.name === 'doctor',
)
assert(doctorCommand, 'doctor command exists')
const rawDoctor = await doctorCommand.run(session, '')
const doctor = await dispatchSlashCommand(session, 'doctor', '')
assert(doctor.message === rawDoctor.message, 'display policy preserves message bytes')
assert(
  doctor.display.surface === 'panel' &&
    doctor.display.key === 'slash:doctor' &&
    doctor.display.overflow === 'pager',
  'doctor uses a replaceable panel that promotes long diagnostics',
)

const status = await dispatchSlashCommand(session, 'status', '')
assert(
  status.display.surface === 'panel' &&
    status.display.key === 'slash:doctor' &&
    status.display.overflow === 'pager',
  'status alias shares the doctor overflow policy',
)

const context = await dispatchSlashCommand(session, 'context', '')
assert(
  context.display.surface === 'panel' &&
    context.display.key === 'slash:context' &&
    context.display.ttlMs === 12_000,
  'context uses the timed compact panel',
)
assert(context.contextView, 'context structured payload is preserved')

const contextDetails = await dispatchSlashCommand(
  session,
  'context',
  'details',
)
assert(
  contextDetails.display.surface === 'overlay' &&
    contextDetails.display.view === 'pager',
  'context details uses the pager overlay',
)

for (const alias of ['detail', '--details']) {
  const detailAlias = await dispatchSlashCommand(
    session,
    'context',
    alias,
  )
  assert(
    detailAlias.ok &&
      detailAlias.display.surface === 'overlay' &&
      detailAlias.display.view === 'pager',
    `context ${alias} shares the details pager policy`,
  )
}

for (const name of ['help', 'memory']) {
  const command = await dispatchSlashCommand(session, name, '')
  assert(
    command.display.surface === 'panel' &&
      command.display.overflow === 'pager',
    `${name} promotes overflow to a pager`,
  )
}

for (const name of ['mcp', 'hooks']) {
  const command = await dispatchSlashCommand(session, name, '')
  assert(
    command.display.surface === 'overlay' &&
      command.display.view === 'pager',
    `${name} uses the pager overlay`,
  )
}

const invalidContext = await dispatchSlashCommand(
  session,
  'context',
  'invalid',
)
assert(
  !invalidContext.ok &&
    invalidContext.display.surface === 'toast' &&
    invalidContext.display.tone === 'error',
  'validation failures use an explicit error toast',
)

const skills = await dispatchSlashCommand(session, 'skills', '')
assert(
  skills.display.surface === 'overlay' &&
    skills.display.key === 'slash:skills' &&
    skills.display.view === 'picker',
  'skills uses a replaceable picker overlay',
)

session.pluginCommands = [
  {
    name: 'demo:review',
    id: 'review',
    pluginId: 'demo',
    body: 'Review the current changes.',
    path: 'E:\\workspace\\.bolo\\plugins\\demo\\commands\\review.md',
    scope: 'project',
  },
]
const plugin = await dispatchSlashCommand(session, 'demo:review', '')
assert(
  plugin.display.surface === 'history' &&
    plugin.display.persistence === 'visual-only',
  'unclassified plugin commands use explicit bounded history fallback',
)

session.skills = [
  {
    meta: {
      id: 'fix-build',
      name: 'fix-build',
      description: 'Fix build failures',
      userInvocable: true,
      path: 'E:\\workspace\\.bolo\\skills\\fix-build\\SKILL.md',
    },
    source: 'project',
    body: 'Fix the build.',
    frontmatter: {},
  },
]
const skill = await dispatchSlashCommand(session, 'fix-build', '')
assert(
  skill.display.surface === 'history' &&
    skill.display.persistence === 'visual-only',
  'unclassified skill commands use explicit bounded history fallback',
)

const unknown = await dispatchSlashCommand(session, 'not-a-command', '')
assert(
  !unknown.ok &&
    unknown.display.surface === 'toast' &&
    unknown.display.tone === 'error',
  'unknown commands use an error toast',
)

const contextBeforeSubmit = await dispatchSlashCommand(session, 'context', '')
const submitted = await submitUserInput(session, '/context')
assert(
  submitted.type === 'slash' &&
    submitted.display.surface === 'panel' &&
    submitted.message === contextBeforeSubmit.message &&
    submitted.contextView !== undefined,
  'submitUserInput projects display without changing existing payloads',
)

console.log('PASS: slash display policy')
