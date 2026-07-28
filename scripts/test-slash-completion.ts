/**
 * OI-10C/E: slash candidate projection and deterministic prefix matching.
 */
import {
  filterSlashCommandCandidates,
  getSlashCommandCandidates,
} from '../packages/core/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

const candidates = getSlashCommandCandidates({
  effortDialect: {
    id: 'test-effort-hint',
    levels: ['low', 'high'],
    choosable: ['low', 'high'],
    map: {
      low: 'low',
      high: 'high',
    },
    wire: [{ shape: 'none' }],
  },
  pluginCommands: [
    {
      name: 'demo:review',
      id: 'review',
      pluginId: 'demo',
      description: 'Review the current changes',
      body: 'Review these changes.',
    },
    {
      name: 'help',
      id: 'help',
      pluginId: 'shadow',
      description: 'Must not shadow the built-in command',
      body: 'Shadow help.',
    },
  ],
  skills: [
    {
      meta: {
        id: 'fix-build',
        name: 'fix-build',
        description: 'Diagnose and repair build failures',
        userInvocable: true,
      },
      source: 'project',
      path: 'E:\\workspace\\.bolo\\skills\\fix-build\\SKILL.md',
      body: 'Fix the build.',
    },
    {
      meta: {
        id: 'private-audit',
        name: 'private-audit',
        description: 'Model-only audit',
        userInvocable: false,
      },
      source: 'plugin',
      path: 'E:\\workspace\\.bolo\\skills\\private-audit\\SKILL.md',
      body: 'Private audit.',
    },
    {
      meta: {
        id: 'doctor',
        name: 'doctor',
        description: 'Must not shadow the built-in command',
        userInvocable: true,
      },
      source: 'project',
      path: 'E:\\workspace\\.bolo\\skills\\doctor\\SKILL.md',
      body: 'Shadow doctor.',
    },
  ] as never,
})

assert(
  candidates.some(
    (candidate) =>
      candidate.name === 'help' && candidate.source === 'builtin',
  ),
  'built-in command is projected',
)
assert(
  candidates.filter((candidate) => candidate.name === 'help').length === 1,
  'built-in command wins a plugin name collision',
)
assert(
  candidates.some(
    (candidate) =>
      candidate.name === 'demo:review' &&
      candidate.source === 'plugin' &&
      candidate.sourceLabel === 'demo',
  ),
  'plugin command is projected with its source',
)
assert(
  candidates.some(
    (candidate) =>
      candidate.name === 'fix-build' &&
      candidate.source === 'skill' &&
      candidate.sourceLabel === 'project',
  ),
  'user-invocable skill is projected with its source',
)
assert(
  !candidates.some((candidate) => candidate.name === 'private-audit'),
  'non-user-invocable skill is hidden',
)
assert(
  candidates.filter((candidate) => candidate.name === 'doctor').length === 1 &&
    candidates.find((candidate) => candidate.name === 'doctor')?.source ===
      'builtin',
  'built-in command wins a skill id collision',
)
assert(
  candidates.find((candidate) => candidate.name === 'effort')?.argumentHint ===
    '[low|high|auto]',
  'effort argument hint follows the active dialect and keeps auto last',
)
assert(
  candidates.find((candidate) => candidate.name === 'skill')?.argumentHint ===
    '<id>',
  'ordinary built-in argument hints reuse registry usage',
)

const all = filterSlashCommandCandidates(candidates, '/')
assert(all.length > 20, 'bare slash returns the visible command catalog')
assert(
  !all.some((candidate) => candidate.hidden),
  'bare slash does not clutter the menu with hidden aliases',
)

const doctor = filterSlashCommandCandidates(candidates, '/d')
assert(doctor[0]?.name === 'doctor', '/d selects /doctor first')
assert(
  doctor.every((candidate) => candidate.name.startsWith('d')),
  'prefix filtering does not return substring-only matches',
)
assert(
  filterSlashCommandCandidates(candidates, '/doctor')[0]?.name === 'doctor',
  'exact command match is ranked first',
)
assert(
  filterSlashCommandCandidates(candidates, '/st').some(
    (candidate) => candidate.name === 'status' && candidate.hidden,
  ),
  'an explicitly typed hidden alias remains discoverable',
)
assert(
  filterSlashCommandCandidates(candidates, '//').length === 0,
  'double slash is not a command completion context',
)
assert(
  filterSlashCommandCandidates(candidates, '/does-not-exist').length === 0,
  'unknown prefix returns an empty result',
)

console.log('PASS: slash completion catalog')
