export type CliTuiEngine = 'legacy' | 'retained'

export function resolveCliTuiEngine(options: {
  dynamicTui: boolean
  env?: NodeJS.ProcessEnv
}): CliTuiEngine {
  if (!options.dynamicTui) return 'legacy'
  const requested = (
    options.env ?? process.env
  ).BOLO_TUI_ENGINE?.trim().toLowerCase()
  return requested === 'retained' ? 'retained' : 'legacy'
}
