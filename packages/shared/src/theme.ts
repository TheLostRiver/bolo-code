/**
 * TUI 主题 id 契约（core 的 /theme 命令与 cli 的 theme.ts 共用，防止漂移）。
 * 完整配色定义在 packages/cli/src/tui/theme.ts（CLI 渲染层）。
 */

export const TUI_THEME_IDS = [
  'default',
  'amber',
  'neon',
  'dim',
  'plain',
] as const

export type TuiThemeId = (typeof TUI_THEME_IDS)[number]

export const TUI_THEME_LABELS: Record<TuiThemeId, string> = {
  default: 'aurora (default)',
  amber: 'amber',
  neon: 'neon',
  dim: 'dim',
  plain: 'plain',
}

export function isTuiThemeId(value: unknown): value is TuiThemeId {
  return (
    typeof value === 'string' &&
    (TUI_THEME_IDS as readonly string[]).includes(value)
  )
}

export function tuiThemeLabel(id: TuiThemeId): string {
  return TUI_THEME_LABELS[id]
}
