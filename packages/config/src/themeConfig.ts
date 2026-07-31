/**
 * /theme 持久化：把 TUI 主题 id 写入 user config.json（~/.bolo/config.json）。
 * 只写 `theme` 字段，不动其它配置；无 id 时不触碰文件。
 */

import type { BoloConfigJson } from './types.ts'
import path from 'node:path'
import { getUserLayout, type BoloLayoutPaths } from './paths.ts'
import { loadConfigJson, parseJsonc, readJsonFile, stripJsonc, writeJsonFile } from './io.ts'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

export type SetTuiThemeOptions = {
  /** 主题 id（default/amber/neon/dim/plain） */
  theme: string
  /** 覆盖 layout（测试） */
  layout?: BoloLayoutPaths
  cwd?: string
}

export type SetTuiThemeResult =
  | {
      ok: true
      configPath: string
      theme: string
      message: string
    }
  | { ok: false; reason: string }

/**
 * 把 `theme` 写入 user config；保留 JSONC 注释与既有字段。
 * 写失败返回 reason（不抛异常）。
 */
export async function setTuiThemeConfig(
  options: SetTuiThemeOptions,
): Promise<SetTuiThemeResult> {
  const layout = options.layout ?? getUserLayout()
  const configPath = layout.configJson
  try {
    const existing = await readJsonFile<BoloConfigJson | undefined>(
      configPath,
    )
    const current: BoloConfigJson = existing ?? {}
    if (current.theme === options.theme) {
      return {
        ok: true,
        configPath,
        theme: options.theme,
        message: `theme already set to ${options.theme}`,
      }
    }
    const next: BoloConfigJson = { ...current, theme: options.theme }
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeJsonFile(configPath, next)
    return {
      ok: true,
      configPath,
      theme: options.theme,
      message: `theme set to ${options.theme}`,
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 读取 user config 中已持久化的主题 id（缺省 undefined） */
export async function getPersistedTuiTheme(options?: {
  layout?: BoloLayoutPaths
  cwd?: string
}): Promise<string | undefined> {
  const layout = options?.layout ?? getUserLayout()
  const loaded = await loadConfigJson(layout)
  return loaded?.theme
}

/**
 * 同步版（CLI 启动路径）：文件不存在/不可读时返回 undefined，不创建任何目录。
 * 仅用于 controller 创建前的一次性读取；写入仍走异步 setTuiThemeConfig。
 */
export function getPersistedTuiThemeSync(options?: {
  layout?: BoloLayoutPaths
}): string | undefined {
  const layout = options?.layout ?? getUserLayout()
  try {
    const raw = readFileSync(layout.configJson, 'utf8')
    const parsed = parseJsonc<BoloConfigJson>(stripJsonc(raw))
    return typeof parsed?.theme === 'string' ? parsed.theme : undefined
  } catch {
    return undefined
  }
}
