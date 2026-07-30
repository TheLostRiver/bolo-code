import {
  getSlashCommandCandidates,
  type SlashCommandCandidate,
  type SlashCommandCandidateSession,
} from '../../core/src/index.ts'

export const CLI_LOCAL_SLASH_COMMANDS: readonly SlashCommandCandidate[] = [
  {
    name: 'exit',
    description: 'Close the interactive session',
    source: 'builtin',
  },
  {
    name: 'quit',
    description: 'Alias of /exit',
    source: 'builtin',
    hidden: true,
  },
  {
    name: 'tools',
    description: 'Browse tool results from this TUI session',
    source: 'builtin',
  },
]

/**
 * Complete interactive catalog: core dispatch plus commands owned by the
 * short-lived CLI editor itself.
 */
export function getCliSlashCommandCandidates(
  session: SlashCommandCandidateSession,
): SlashCommandCandidate[] {
  const localNames = new Set(
    CLI_LOCAL_SLASH_COMMANDS.map((candidate) => candidate.name),
  )
  return [
    ...getSlashCommandCandidates(session).filter(
      (candidate) => !localNames.has(candidate.name),
    ),
    ...CLI_LOCAL_SLASH_COMMANDS,
  ]
}
