/**
 * AR-T3b S4：openai-compatible 那条腿的搜索 —— 走既有 MCP host
 *
 * Chat Completions 协议上没有 hosted 搜索的位置，而用户把这条线路视为一等公民。
 * Bolo 已经有完整的 MCP client（stdio / http / sse + env 展开），
 * opencode 也正是把 Exa 当 MCP 端点用的——所以这条腿**不写新的 HTTP 客户端**，
 * 只提供 curated preset 把一行配置写进 mcp.json。
 *
 * 额外好处：MCP 搜索结果是 tool-result，**受 truncateMiddle + per-tool 预算治理**。
 * 两条 hosted 线路的结果在 provider 侧就进了上下文，绕过本地截断。
 *
 * 契约（安全 + 可发现性并重）：
 * - preset **绝不**把密钥写进磁盘，只写 `${ENV_VAR}` 引用
 * - 启用是幂等的，且不得破坏用户已有的 mcpServers
 * - **未配置时的措辞必须读起来像「还没开」，不能像「坏了」**
 * - 不承诺 Bolo MCP client 做不到的事（无 OAuth）
 *
 * 运行：npx tsx scripts/test-search-presets.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_SEARCH_PRESETS,
  describeWebSearchStatus,
  enableSearchPresetInMcpFile,
  getSearchPreset,
  listSearchPresets,
} from '../packages/config/src/searchPresets.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'search-preset-test')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  // ── 1) preset 表自洽，且绝不内嵌密钥 ──
  {
    assert(BUILTIN_SEARCH_PRESETS.length > 0, 'presets exist')
    for (const p of BUILTIN_SEARCH_PRESETS) {
      assert(p.id.length > 0, 'preset has an id')
      assert(p.url.startsWith('https://') || p.url.startsWith('http://'), `${p.id} has a url`)
      const serialized = JSON.stringify(p)
      // 任何看起来像真实密钥的东西都不该出现在内置表里
      assert(
        !/sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9]{8,}/.test(serialized),
        `${p.id} must not embed a real credential`,
      )
      if (p.requiresKeyEnv) {
        assert(
          serialized.includes(`\${${p.requiresKeyEnv}}`),
          `${p.id} references its key by env var, not by value`,
        )
      }
    }
    // 至少有一个无需 key 的选项，否则「一步开启」是空话
    assert(
      BUILTIN_SEARCH_PRESETS.some((p) => !p.requiresKeyEnv),
      'at least one keyless preset exists so enabling is genuinely one step',
    )
  }

  // ── 2) 不承诺做不到的事：Bolo MCP client 没有 OAuth ──
  {
    for (const p of BUILTIN_SEARCH_PRESETS) {
      assert(
        p.auth === 'none' || p.auth === 'header',
        `${p.id} uses an auth mode this MCP client actually supports (no OAuth)`,
      )
    }
  }

  // ── 3) 查找 ──
  {
    const first = BUILTIN_SEARCH_PRESETS[0]!
    assert(getSearchPreset(first.id)?.id === first.id, 'lookup by id')
    assert(getSearchPreset('nope') === undefined, 'unknown id → undefined')
    assert(listSearchPresets().length === BUILTIN_SEARCH_PRESETS.length, 'list all')
  }

  // ── 4) 写入 mcp.json：结构正确 ──
  {
    const mcpJson = path.join(root, 'a', 'mcp.json')
    await fs.mkdir(path.dirname(mcpJson), { recursive: true })
    const keyless = BUILTIN_SEARCH_PRESETS.find((p) => !p.requiresKeyEnv)!
    const r = await enableSearchPresetInMcpFile(mcpJson, keyless.id)
    assert(r.ok === true, `enable succeeds: ${JSON.stringify(r)}`)

    const written = JSON.parse(await fs.readFile(mcpJson, 'utf8')) as {
      mcpServers?: Record<string, Record<string, unknown>>
    }
    const entry = written.mcpServers?.[keyless.serverName]
    assert(entry !== undefined, `server entry written under ${keyless.serverName}`)
    assert(entry!.type === 'http', 'uses the http transport')
    assert(typeof entry!.url === 'string', 'carries the endpoint url')
  }

  // ── 5) 幂等：重复启用不产生重复项、不报错 ──
  {
    const mcpJson = path.join(root, 'b', 'mcp.json')
    await fs.mkdir(path.dirname(mcpJson), { recursive: true })
    const keyless = BUILTIN_SEARCH_PRESETS.find((p) => !p.requiresKeyEnv)!
    await enableSearchPresetInMcpFile(mcpJson, keyless.id)
    const again = await enableSearchPresetInMcpFile(mcpJson, keyless.id)
    assert(again.ok === true, 'second enable still succeeds')
    const written = JSON.parse(await fs.readFile(mcpJson, 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    assert(
      Object.keys(written.mcpServers ?? {}).length === 1,
      'no duplicate server entries',
    )
  }

  // ── 6) 绝不破坏用户已有的 mcpServers ──
  {
    const mcpJson = path.join(root, 'c', 'mcp.json')
    await fs.mkdir(path.dirname(mcpJson), { recursive: true })
    await fs.writeFile(
      mcpJson,
      JSON.stringify(
        { mcpServers: { mine: { command: 'my-server', args: ['--x'] } } },
        null,
        2,
      ),
      'utf8',
    )
    const keyless = BUILTIN_SEARCH_PRESETS.find((p) => !p.requiresKeyEnv)!
    await enableSearchPresetInMcpFile(mcpJson, keyless.id)
    const written = JSON.parse(await fs.readFile(mcpJson, 'utf8')) as {
      mcpServers?: Record<string, Record<string, unknown>>
    }
    assert(written.mcpServers?.mine !== undefined, 'existing server preserved')
    assert(
      written.mcpServers?.mine?.command === 'my-server',
      'existing server untouched',
    )
    assert(
      written.mcpServers?.[keyless.serverName] !== undefined,
      'new server added alongside',
    )
  }

  // ── 7) 需要 key 的 preset 只写 env 引用，绝不写值 ──
  {
    const keyed = BUILTIN_SEARCH_PRESETS.find((p) => p.requiresKeyEnv)
    if (keyed) {
      const mcpJson = path.join(root, 'd', 'mcp.json')
      await fs.mkdir(path.dirname(mcpJson), { recursive: true })
      await enableSearchPresetInMcpFile(mcpJson, keyed.id)
      const raw = await fs.readFile(mcpJson, 'utf8')
      assert(
        raw.includes(`\${${keyed.requiresKeyEnv}}`),
        'key stays an env reference on disk',
      )
      assert(
        !new RegExp(`"${keyed.requiresKeyEnv}"\\s*:\\s*"[^$]`).test(raw),
        'no literal key value written',
      )
    }
  }

  // ── 8) 未配置时的措辞：像「还没开」，不能像「坏了」 ──
  {
    const unconfigured = describeWebSearchStatus({
      dialectId: 'off',
      hasSearchMcpServer: false,
    })
    assert(
      unconfigured.configured === false,
      'reports unconfigured',
    )
    assert(
      !/error|fail|broken|unavailable|unsupported/i.test(unconfigured.summary),
      `must not read like a malfunction: ${unconfigured.summary}`,
    )
    assert(
      /bolo search|enable/i.test(unconfigured.summary),
      `tells the user the one step to fix it: ${unconfigured.summary}`,
    )
  }

  // ── 9) 已由 MCP 提供时要说清来源 ──
  {
    const viaMcp = describeWebSearchStatus({
      dialectId: 'off',
      hasSearchMcpServer: true,
    })
    assert(viaMcp.configured === true, 'mcp-provided search counts as configured')
    assert(
      /mcp/i.test(viaMcp.summary),
      `names the source: ${viaMcp.summary}`,
    )
  }

  // ── 10) hosted 线路要说明它是 provider 侧执行的 ──
  {
    const hosted = describeWebSearchStatus({
      dialectId: 'anthropic-hosted',
      hasSearchMcpServer: false,
    })
    assert(hosted.configured === true, 'hosted lane needs no setup')
    assert(
      /provider|hosted|server-side/i.test(hosted.summary),
      `explains it runs at the provider: ${hosted.summary}`,
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: search presets')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
