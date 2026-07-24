/**
 * 读写 JSON 配置文件
 */

import { promises as fs } from 'node:fs'
import type { BoloConfigJson, HooksFileJson, McpFileJson } from './types.ts'
import { DEFAULT_CONFIG } from './types.ts'
import type { BoloLayoutPaths } from './paths.ts'

export async function readJsonFile<T>(
  filePath: string,
): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export async function loadConfigJson(
  layout: BoloLayoutPaths,
): Promise<BoloConfigJson> {
  const file = await readJsonFile<BoloConfigJson>(layout.configJson)
  if (!file) return { ...DEFAULT_CONFIG }
  return { ...DEFAULT_CONFIG, ...file, provider: { ...DEFAULT_CONFIG.provider, ...file.provider } }
}

export async function loadMcpJson(
  layout: BoloLayoutPaths,
): Promise<McpFileJson> {
  return (await readJsonFile<McpFileJson>(layout.mcpJson)) ?? { mcpServers: {} }
}

export async function loadHooksJson(
  layout: BoloLayoutPaths,
): Promise<HooksFileJson> {
  return (await readJsonFile<HooksFileJson>(layout.hooksJson)) ?? {}
}

/** 浅合并 config：后写覆盖前写；provider 字段深度合并；list 字段拼接去重 */
export function mergeConfigJson(
  base: BoloConfigJson,
  over: BoloConfigJson,
): BoloConfigJson {
  const extraSkillRoots = mergeStringListsUnique(
    base.extraSkillRoots,
    over.extraSkillRoots,
  )
  const foreignPluginRoots = mergeStringListsUnique(
    base.foreignPluginRoots,
    over.foreignPluginRoots,
  )
  return {
    ...base,
    ...over,
    provider: {
      ...base.provider,
      ...over.provider,
    },
    ...(extraSkillRoots.length
      ? { extraSkillRoots }
      : { extraSkillRoots: undefined }),
    ...(foreignPluginRoots.length
      ? { foreignPluginRoots }
      : { foreignPluginRoots: undefined }),
  }
}

function mergeStringListsUnique(
  a?: string[],
  b?: string[],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(a ?? []), ...(b ?? [])]) {
    const t = raw?.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * 合并优先级（高 → 低覆盖）：
 * defaults < user file < project file
 * （环境变量在 resolveProvider 另算，最高）
 */
export function mergeConfigs(
  user: BoloConfigJson,
  project: BoloConfigJson,
): BoloConfigJson {
  return mergeConfigJson(user, project)
}