/**
 * `bolo search` —— 给 openai-compatible 那条腿配搜索。
 *
 * 存在的直接理由：状态提示里写着「run 'bolo search enable exa'」，
 * 而这个命令原本不存在。**指着一个不存在的命令比什么都不说更糟**——
 * 用户照做得到「未知参数」，然后以为整个功能坏了。
 *
 * 为什么这条腿只能走 MCP（DeepSeek 官方 API 实测确认）：
 * - `tools:[{type:'web_search'}]` → 硬 400（`unknown variant, expected 'function'`）
 * - body 顶层未知字段 → **静默忽略**（所以"碰运气乱塞字段"只会让用户以为开了）
 * 普通 Chat Completions 端点没有 hosted 搜索的位置，MCP 是唯一真实路径。
 */

import path from 'node:path'
import {
  BUILTIN_SEARCH_PRESETS,
  enableSearchPresetInMcpFile,
  getSearchPreset,
  listSearchPresets,
} from '../../config/src/index.ts'
import { getUserLayout } from '../../config/src/paths.ts'

export type SearchCliOptions = {
  /** 覆盖写入路径（测试用）；缺省写用户级 mcp.json */
  mcpJsonPath?: string
  writeOut?: (s: string) => void
  writeErr?: (s: string) => void
}

function usage(): string {
  const ids = BUILTIN_SEARCH_PRESETS.map((p) => p.id).join(' | ')
  return [
    'Usage: bolo search <command>',
    '',
    '  list                 show available search backends',
    `  enable <preset>      add one to mcp.json (${ids})`,
    '',
    'Web search on Anthropic and OpenAI Responses runs at the provider and needs',
    'no setup. This command is for endpoints without hosted search.',
    '',
  ].join('\n')
}

export async function runSearchCli(
  argv: readonly string[],
  options: SearchCliOptions = {},
): Promise<number> {
  const writeOut = options.writeOut ?? ((s: string) => process.stdout.write(s))
  const writeErr = options.writeErr ?? ((s: string) => process.stderr.write(s))

  const sub = (argv[0] ?? '').trim().toLowerCase()
  if (!sub) {
    writeErr(usage())
    return 2
  }

  if (sub === 'list') {
    for (const p of listSearchPresets()) {
      const key = p.requiresKeyEnv
        ? `needs ${p.requiresKeyEnv}`
        : 'no key needed'
      writeOut(`  ${p.id.padEnd(10)} ${p.label}  [${key}]\n`)
      if (p.notes) writeOut(`             ${p.notes}\n`)
    }
    return 0
  }

  if (sub === 'enable') {
    const presetId = (argv[1] ?? '').trim()
    if (!presetId) {
      writeErr(
        `bolo search enable needs a preset (${BUILTIN_SEARCH_PRESETS.map((p) => p.id).join(' | ')})\n`,
      )
      return 2
    }
    const preset = getSearchPreset(presetId)
    if (!preset) {
      writeErr(
        `unknown search preset "${presetId}" — available: ${BUILTIN_SEARCH_PRESETS.map((p) => p.id).join(', ')}\n`,
      )
      return 2
    }

    const mcpJsonPath =
      options.mcpJsonPath ?? path.join(getUserLayout().root, 'mcp.json')
    const r = await enableSearchPresetInMcpFile(mcpJsonPath, preset.id)
    if (!r.ok) {
      writeErr(`${r.error}\n`)
      return 1
    }

    writeOut(
      r.alreadyPresent
        ? `updated "${r.serverName}" in ${mcpJsonPath}\n`
        : `added "${r.serverName}" to ${mcpJsonPath}\n`,
    )
    if (preset.requiresKeyEnv) {
      // 密钥不落盘，所以必须明确告诉用户还差这一步，否则连接时才发现
      writeOut(
        `set ${preset.requiresKeyEnv} in your environment — the key is referenced, never written to the config\n`,
      )
    }
    if (preset.notes) writeOut(`${preset.notes}\n`)
    writeOut('restart bolo (or /plugins reload) to connect it\n')
    return 0
  }

  writeErr(`unknown command "${sub}"\n\n${usage()}`)
  return 2
}
