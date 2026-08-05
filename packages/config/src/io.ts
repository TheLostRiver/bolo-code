/**
 * 读写 JSON / JSONC 配置文件
 */

import { promises as fs } from 'node:fs'
import type { BoloConfigJson, HooksFileJson, McpFileJson } from './types.ts'
import { DEFAULT_CONFIG } from './types.ts'
import type { BoloLayoutPaths } from './paths.ts'
import {
  mergeProviderConfigJson,
  mergeProvidersMaps,
} from './providerRegistry.ts'
import { validateBoloConfigModelMetadata } from './modelMetadata.ts'

/**
 * 去掉 JSONC 注释与尾逗号，便于 config.json 写说明。
 * 字符串内的内容按 JSON 规则保留。
 */
export function stripJsonc(raw: string): string {
  let out = ''
  let i = 0
  const s = raw
  let inString = false
  let escape = false
  while (i < s.length) {
    const c = s[i]!
    const n = s[i + 1]

    if (inString) {
      out += c
      if (escape) {
        escape = false
      } else if (c === '\\') {
        escape = true
      } else if (c === '"') {
        inString = false
      }
      i++
      continue
    }

    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }

    // // line comment
    if (c === '/' && n === '/') {
      i += 2
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    // /* block comment */
    if (c === '/' && n === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }

    out += c
    i++
  }

  // trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsonc(raw)) as T
}

export async function readJsonFile<T>(
  filePath: string,
): Promise<T | null> {
  const r = await readJsonFileResult<T>(filePath)
  return r.found && r.ok ? r.value : null
}

export type ReadJsonResult<T> =
  | { found: false }
  | { found: true; ok: true; value: T }
  | { found: true; ok: false; reason: string }

/**
 * 区分「文件不存在」与「文件在但读不了 / 解析不了」。
 *
 * readJsonFile 那个 `catch { return null }` 把两者压成了同一个结果，
 * 于是用户改坏 config 之后毫无提示、直接退回默认值 —— 他会以为自己的配置生效了，
 * 然后去排查一个根本不存在的问题。
 */
export async function readJsonFileResult<T>(
  filePath: string,
): Promise<ReadJsonResult<T>> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { found: false }
    return {
      found: true,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  try {
    // UTF-8 BOM（常见于 PowerShell/记事本保存）会令 JSON.parse 报
    // "Unexpected token"——加载前剥离（业界惯例，防止 BOM 让整个
    // config 静默失效）
    const value = parseJsonc<T>(raw.replace(/^\uFEFF/, ''))
    if (value == null) {
      return { found: true, ok: false, reason: 'not a JSON object' }
    }
    return { found: true, ok: true, value }
  } catch (err) {
    return {
      found: true,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export async function writeTextIfMissing(
  filePath: string,
  text: string,
): Promise<boolean> {
  try {
    await fs.access(filePath)
    return false
  } catch {
    await fs.writeFile(filePath, text, 'utf8')
    return true
  }
}

export async function loadConfigJson(
  layout: BoloLayoutPaths,
): Promise<BoloConfigJson> {
  return (await loadConfigJsonWithWarnings(layout)).config
}

/**
 * 同 loadConfigJson，但把「文件在却读不了」变成可见 warning。
 * 坏配置不阻断启动——进不去 CLI 就更难修了——但必须说出来。
 */
/**
 * apiKeyEnv 语义 = 环境变量**名**（运行时 env(name) 读取）。
 * 常见误用：把密钥本身（sk-...）填进 apiKeyEnv——运行时查不到该 env，
 * 回落也失败 → provider 静默无 key。这里给出可诊断的 warning。
 */
export function validateProviderKeyFieldWarnings(
  config: BoloConfigJson,
): string[] {
  const out: string[] = []
  for (const [id, p] of Object.entries(config.providers ?? {})) {
    // 手改配置可能出现 null 条目（删除 provider 时残留）——跳过不崩溃
    if (!isRecord(p)) continue
    const name = p.apiKeyEnv?.trim()
    if (!name) continue
    if (/^sk-/i.test(name)) {
      out.push(
        `provider "${id}": apiKeyEnv value looks like a key ("sk-…" prefix) — ` +
          'apiKeyEnv must be an ENVIRONMENT VARIABLE NAME; ' +
          'move the key into that env var or use "apiKey" instead',
      )
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      // 非法字符形态也可能含密钥片段——不回显值（零泄露）
      out.push(
        `provider "${id}": apiKeyEnv value is not a valid environment ` +
          'variable name (letters/digits/underscore only)',
      )
    }
  }
  return out
}

export async function loadConfigJsonWithWarnings(
  layout: BoloLayoutPaths,
): Promise<{
  config: BoloConfigJson
  warnings: string[]
  /** 文件中实际声明的配置；缺失/损坏时为空，不含 DEFAULT_CONFIG。 */
  sourceConfig?: BoloConfigJson
}> {
  const r = await readJsonFileResult<BoloConfigJson>(layout.configJson)
  if (!r.found) return { config: { ...DEFAULT_CONFIG }, warnings: [] }
  if (!r.ok) {
    return {
      config: { ...DEFAULT_CONFIG },
      warnings: [
        `${layout.configJson}: could not be parsed (${r.reason}); using defaults — the settings in this file are NOT in effect`,
      ],
    }
  }
  return {
    config: mergeConfigJson({ ...DEFAULT_CONFIG }, r.value),
    warnings: [
      ...validateBoloConfigModelMetadata(r.value, layout.configJson),
      ...validateProviderKeyFieldWarnings(r.value),
    ],
    sourceConfig: r.value,
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mergeSearchConfig(
  base: unknown,
  over: unknown,
): BoloConfigJson['search'] {
  if (over === undefined) return base as BoloConfigJson['search']
  if (!isRecord(over)) return over as BoloConfigJson['search']
  if (!isRecord(base)) return over as BoloConfigJson['search']

  const merged: Record<string, unknown> = { ...base, ...over }
  if (Object.prototype.hasOwnProperty.call(over, 'searxng')) {
    const baseSearxng = base.searxng
    const overSearxng = over.searxng
    merged.searxng =
      isRecord(baseSearxng) && isRecord(overSearxng)
        ? { ...baseSearxng, ...overSearxng }
        : overSearxng
  }
  return merged as BoloConfigJson['search']
}

/** 浅合并 config：后写覆盖前写；provider / providers / agents / search 深度合并；list 字段拼接去重 */
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
  const agents =
    base.agents || over.agents
      ? { ...(base.agents ?? {}), ...(over.agents ?? {}) }
      : undefined
  const search = mergeSearchConfig(base.search, over.search)
  const provider = mergeProviderConfigJson(base.provider, over.provider)
  const providers = mergeProvidersMaps(base.providers, over.providers)
  const defaultProvider =
    over.defaultProvider?.trim() ||
    base.defaultProvider?.trim() ||
    undefined
  return {
    ...base,
    ...over,
    ...(provider ? { provider } : { provider: undefined }),
    ...(providers && Object.keys(providers).length
      ? { providers }
      : { providers: undefined }),
    ...(defaultProvider ? { defaultProvider } : { defaultProvider: undefined }),
    ...(agents ? { agents } : {}),
    ...(search !== undefined ? { search } : { search: undefined }),
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
