/**
 * CX1：把 preset / 自定义 profile 写入 user 或 project config.json。
 * 只写 apiKeyEnv，永不写明文 apiKey。
 */

import type { BoloConfigJson, ProviderConfigJson } from './types.ts'
import {
  getProjectLayout,
  getUserLayout,
  type BoloLayoutPaths,
} from './paths.ts'
import { loadConfigJson, readJsonFile, writeJsonFile } from './io.ts'
import {
  getProviderPreset,
  providerConfigFromPreset,
  type ProviderPreset,
} from './providerPresets.ts'
import { profileFromConfigJson } from './providerRegistry.ts'

export type AddProviderProfileOptions = {
  /** preset id 或别名；与 rawProfile 二选一 */
  presetId?: string
  /** 自定义 profile（测试 / 高级） */
  rawProfile?: ProviderConfigJson
  /** 写入的 providers key；默认 = preset id */
  asId?: string
  /** 默认 user（~/.bolo/config.json） */
  scope?: 'user' | 'project'
  cwd?: string
  /** 覆盖 layout（测试） */
  layout?: BoloLayoutPaths
  /** 已存在同 id 时覆盖；默认 false → 拒绝 */
  overwrite?: boolean
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  label?: string
  /** 设为 defaultProvider */
  setDefault?: boolean
}

export type AddProviderProfileResult =
  | {
      ok: true
      id: string
      configPath: string
      profile: ProviderConfigJson
      preset?: ProviderPreset
      overwritten: boolean
      message: string
    }
  | { ok: false; reason: string }

function isValidProviderId(id: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)
}

/**
 * 向 config.providers 追加命名后端（无密钥明文）。
 */
export async function addProviderProfileToConfigFile(
  opts: AddProviderProfileOptions,
): Promise<AddProviderProfileResult> {
  const scope = opts.scope ?? 'user'
  const layout =
    opts.layout ??
    (scope === 'project'
      ? getProjectLayout(opts.cwd ?? process.cwd())
      : getUserLayout())

  let profileJson: ProviderConfigJson
  let preset: ProviderPreset | undefined

  if (opts.rawProfile) {
    profileJson = { ...opts.rawProfile }
    // 安全：落盘前剥明文 key
    delete profileJson.apiKey
  } else {
    const presetId = opts.presetId?.trim()
    if (!presetId) {
      return {
        ok: false,
        reason:
          'preset id required (e.g. deepseek, openai, anthropic) · /provider add list',
      }
    }
    preset = getProviderPreset(presetId)
    if (!preset) {
      return {
        ok: false,
        reason: `unknown preset "${presetId}" · /provider add list`,
      }
    }
    profileJson = providerConfigFromPreset(preset, {
      model: opts.model,
      baseUrl: opts.baseUrl,
      apiKeyEnv: opts.apiKeyEnv,
      label: opts.label,
    })
  }

  const idRaw =
    opts.asId?.trim() ||
    preset?.id ||
    opts.presetId?.trim() ||
    ''
  if (!idRaw || !isValidProviderId(idRaw)) {
    return {
      ok: false,
      reason:
        'invalid provider id (use letters/digits/_/- , start with letter, max 64)',
    }
  }
  const id = idRaw

  // 读磁盘原文（保留用户其它字段）；失败则从 load 合成
  let disk =
    (await readJsonFile<BoloConfigJson>(layout.configJson)) ??
    (await loadConfigJson(layout))

  const providers = { ...(disk.providers ?? {}) }
  const existed = Boolean(providers[id])
  if (existed && !opts.overwrite) {
    return {
      ok: false,
      reason: `provider id "${id}" already exists (use overwrite or /provider add ${preset?.id ?? id} as <other-id>)`,
    }
  }

  providers[id] = profileJson
  const next: BoloConfigJson = {
    ...disk,
    providers,
    ...(opts.setDefault ? { defaultProvider: id } : {}),
  }

  // 若仅有旧 provider、无 map，保持兼容：providers 为主
  await writeJsonFile(layout.configJson, next)

  const envHint = profileJson.apiKeyEnv
    ? `set ${profileJson.apiKeyEnv}`
    : 'set API key env for this backend'
  const message = [
    `provider "${id}" ${existed ? 'updated' : 'added'} in ${layout.configJson}`,
    `  kind=${profileJson.kind ?? '?'} model=${profileJson.model ?? '(unset)'}`,
    `  ${envHint}`,
    `  then: /provider use ${id}`,
  ].join('\n')

  // 校验可归一
  profileFromConfigJson(id, profileJson)

  return {
    ok: true,
    id,
    configPath: layout.configJson,
    profile: profileJson,
    ...(preset ? { preset } : {}),
    overwritten: existed,
    message,
  }
}