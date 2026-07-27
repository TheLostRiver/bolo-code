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
  describeSearchPresetPrivacy,
  enableSearchPresetInMcpFile,
  getSearchPreset,
  loadWorkspace,
  listSearchPresets,
} from '../../config/src/index.ts'
import { getUserLayout } from '../../config/src/paths.ts'
import {
  detectWebSearchDialectId,
} from '../../providers/src/index.ts'
import { describeWebSearchStatus } from '../../config/src/searchPresets.ts'
import {
  probeSearxng,
  type SearxngDoctorReport,
  type SearxngDoctorStage,
  type SearxngUpstreamFailure,
} from '../../tools/src/index.ts'
import {
  runSearxngSetupCli,
  type SearxngSetupCliOptions,
} from './searxngSetupCli.ts'

export type SearchCliOptions = {
  /** 覆盖写入路径（测试用）；缺省写用户级 mcp.json */
  mcpJsonPath?: string
  /** Workspace used by `status`; defaults to process.cwd(). */
  cwd?: string
  writeOut?: (s: string) => void
  writeErr?: (s: string) => void
  /** Probe transport override for deterministic callers/tests. */
  fetchImpl?: typeof fetch
  /** Explicit SearXNG Docker management overrides for deterministic tests. */
  searxngSetup?: Omit<SearxngSetupCliOptions, 'writeOut' | 'writeErr'>
}

function usage(): string {
  const ids = BUILTIN_SEARCH_PRESETS.map((p) => p.id).join(' | ')
  return [
    'Usage: bolo search <command>',
    '',
    '  status               show the active hosted/direct/MCP lane',
    '  doctor [--json]      probe configured SearXNG and run a non-empty smoke',
    '  searxng <command>    explicitly manage the optional local Docker setup',
    '  list                 show available search backends',
    `  enable <preset>      add one to mcp.json (${ids})`,
    '',
    'Web search on Anthropic and OpenAI Responses runs at the provider and needs',
    'no setup. This command is for endpoints without hosted search.',
    '',
  ].join('\n')
}

type SearchDoctorCliReport = {
  ok: boolean
  code: string
  stage: SearxngDoctorStage
  endpointUrl?: string
  query?: string
  version?: string
  instanceName?: string
  capabilities: {
    configJson: boolean
    searchJson: boolean
  }
  configuredEngineCount?: number
  resultCount: number
  workingEngines: string[]
  unresponsiveEngines: SearxngUpstreamFailure[]
  detail?: string
}

function doctorCliFailure(
  code: 'not_configured' | 'invalid_config' | 'usage_error',
  detail: string,
): SearchDoctorCliReport {
  return {
    ok: false,
    code,
    stage: 'config',
    capabilities: { configJson: false, searchJson: false },
    resultCount: 0,
    workingEngines: [],
    unresponsiveEngines: [],
    detail:
      detail.length <= 2_000 ? detail : `${detail.slice(0, 1_999)}…`,
  }
}

function formatDoctorReport(report: SearchDoctorCliReport): string {
  const capabilities = [
    report.capabilities.configJson ? 'config-json' : '',
    report.capabilities.searchJson ? 'search-json' : '',
  ].filter(Boolean)
  const lines = [
    `SearXNG doctor: ${report.ok ? 'PASS' : 'FAIL'} (${report.code})`,
    `stage: ${report.stage}`,
    ...(report.endpointUrl ? [`endpoint: ${report.endpointUrl}`] : []),
    ...(report.version ? [`version: ${report.version}`] : []),
    ...(report.instanceName ? [`instance: ${report.instanceName}`] : []),
    `capabilities: ${capabilities.length ? capabilities.join(', ') : 'none'}`,
    ...(report.configuredEngineCount === undefined
      ? []
      : [`configured engines: ${report.configuredEngineCount}`]),
    ...(report.query ? [`smoke query: ${report.query}`] : []),
    `valid results: ${report.resultCount}`,
    `working engines: ${
      report.workingEngines.length ? report.workingEngines.join(', ') : 'none reported'
    }`,
    `unresponsive engines: ${
      report.unresponsiveEngines.length
        ? report.unresponsiveEngines
            .map(({ engine, reason }) => `${engine} (${reason})`)
            .join(', ')
        : 'none reported'
    }`,
    ...(report.detail ? [`detail: ${report.detail}`] : []),
    '',
  ]
  return lines.join('\n')
}

function writeDoctorReport(
  report: SearchDoctorCliReport,
  json: boolean,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): number {
  if (json) {
    writeOut(`${JSON.stringify(report)}\n`)
  } else {
    const write = report.ok ? writeOut : writeErr
    write(formatDoctorReport(report))
  }
  if (report.ok) return 0
  return (
    report.code === 'not_configured' ||
    report.code === 'invalid_config' ||
    report.code === 'usage_error'
  )
    ? 2
    : 1
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

  if (sub === 'status') {
    const workspace = await loadWorkspace({
      cwd: options.cwd ?? process.cwd(),
      ensureDefaults: false,
    })
    for (const warning of workspace.configWarnings ?? []) {
      writeErr(`warn: ${warning}\n`)
    }
    const hasSearchMcpServer = workspace.mcpServers.some(
      (server) =>
        /search|exa/i.test(server.name) ||
        server.allowTools?.some((tool) => /search/i.test(tool)) === true ||
        server.tools?.some((tool) => /search/i.test(tool.name)) === true,
    )
    const dialectId = detectWebSearchDialectId({
      kind: workspace.providerProfile?.kind ?? workspace.providerKind,
      baseUrl:
        workspace.providerProfile?.baseUrl ?? workspace.providerBaseUrl,
      model: workspace.providerModel,
    })
    const status = describeWebSearchStatus({
      dialectId,
      hasSearchMcpServer,
      hasSearxngSearchTool: !!workspace.searxngSearch,
    })
    writeOut(`${status.summary}\n`)
    if (workspace.searxngSearch) {
      writeOut(`endpoint: ${workspace.searxngSearch.endpointUrl}\n`)
      writeOut(
        'privacy: SearXNG may forward the query to configured upstream engines\n',
      )
    }
    return 0
  }

  if (sub === 'doctor') {
    const doctorArgs = argv.slice(1)
    const json = doctorArgs.includes('--json')
    if (
      doctorArgs.length > 1 ||
      (doctorArgs.length === 1 && doctorArgs[0] !== '--json')
    ) {
      return writeDoctorReport(
        doctorCliFailure(
          'usage_error',
          'Usage: bolo search doctor [--json]',
        ),
        json,
        writeOut,
        writeErr,
      )
    }

    const workspace = await loadWorkspace({
      cwd: options.cwd ?? process.cwd(),
      ensureDefaults: false,
    })
    if (!workspace.searxngSearch) {
      const warnings = workspace.configWarnings ?? []
      const report = warnings.length
        ? doctorCliFailure('invalid_config', warnings.join('; '))
        : doctorCliFailure(
            'not_configured',
            'No valid search.searxng configuration is active. Configure it first, then retry.',
          )
      return writeDoctorReport(report, json, writeOut, writeErr)
    }

    const report: SearxngDoctorReport = await probeSearxng(
      workspace.searxngSearch,
      {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
    )
    return writeDoctorReport(report, json, writeOut, writeErr)
  }

  if (sub === 'searxng') {
    return await runSearxngSetupCli(argv.slice(1), {
      ...(options.searxngSetup ?? {}),
      writeOut,
      writeErr,
    })
  }

  if (sub === 'list') {
    for (const p of listSearchPresets()) {
      const key = p.requiresKeyEnv
        ? `needs ${p.requiresKeyEnv}`
        : 'no key needed'
      writeOut(`  ${p.id.padEnd(10)} ${p.label}  [${key}]\n`)
      // 「查询去哪」必须在**启用之前**就看得到——决策发生在敲命令那一刻，
      // 只写在文档里等于没写。
      writeOut(`             ${describeSearchPresetPrivacy(p)}\n`)
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
    // 即使 list 没看过，启用这一刻也要知道查询会去哪
    writeOut(`${describeSearchPresetPrivacy(preset)}\n`)
    if (preset.requiresKeyEnv) {
      // 密钥不落盘，所以必须明确告诉用户还差这一步，否则连接时才发现
      writeOut(
        `set ${preset.requiresKeyEnv} in your environment — the key is referenced, never written to the config\n`,
      )
    }
    if (preset.allowTools?.length) {
      // 少注册工具是个静默的决定，必须说出来，否则用户会以为 server 只有这些
      writeOut(
        `registering only: ${preset.allowTools.join(', ')} — edit mcp.json if you want this server's other tools\n`,
      )
    }
    if (preset.notes) writeOut(`${preset.notes}\n`)
    writeOut('restart bolo (or /plugins reload) to connect it\n')
    return 0
  }

  writeErr(`unknown command "${sub}"\n\n${usage()}`)
  return 2
}
