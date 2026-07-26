/**
 * AR-T3b S6：`mcp-external` 轨的**活体**验证（第 5 条、也是最后一条搜索腿）
 *
 * 前四条腿都活体验过了，这条一直只有契约测试。契约测试证明不了的东西恰恰是
 * 最容易错的：真实端点的传输细节、真实工具名、真实返回形状。
 *
 * 为什么单独放 live 脚本、**不进 `npm test`**：
 * 它依赖公网 + 第三方（Exa）可用性。放进门禁会让 CI 因为别人家的故障变红，
 * 于是所有人开始无视红灯——那比没有这个测试更糟。
 *
 * 运行：npx tsx scripts/live-mcp-search.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  connectMcpServers,
  closeMcpConnections,
  formatMcpCallOutput,
  parseMcpToolName,
} from '../packages/mcp/src/index.ts'
import { loadMcpConfigFileDetailed } from '../packages/mcp/src/config.ts'
import { runSearchCli } from '../packages/cli/src/searchCli.ts'
import { validateAgainstJsonSchema } from '../packages/tools/src/types.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function ok(msg: string) {
  console.log('  ok ·', msg)
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'live-mcp-search')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })
  const mcpJsonPath = path.join(root, 'mcp.json')

  // ── 1) 用**用户真会敲的那条命令**生成配置，而不是手写 fixture ──
  // 状态提示里写着 "bolo search enable exa"；这里就走它，顺带验证它产出的
  // 配置真的能连上——而不只是"写了个 JSON 文件"。
  console.log('1) bolo search enable exa')
  {
    const out: string[] = []
    const code = await runSearchCli(['enable', 'exa'], {
      mcpJsonPath,
      writeOut: (s) => out.push(s),
      writeErr: (s) => out.push(s),
    })
    assert(code === 0, `enable exits 0, got ${code} · ${out.join('')}`)
    ok('preset written by the real CLI command')
  }

  // ── 2) 用产品的加载器读回（不是 JSON.parse），确保这条链路没断 ──
  console.log('2) load mcp.json through the product loader')
  const loaded = await loadMcpConfigFileDetailed(mcpJsonPath)
  const servers = loaded.servers
  // preset 写出来的配置必须**零告警**通过校验。有告警说明 preset 和校验器
  // 对不齐——用户会看到一条自己没写过的配置在报警。
  assert(
    loaded.warnings.length === 0,
    `preset config loads without warnings: ${loaded.warnings.join(' | ')}`,
  )
  assert(servers.length === 1, `one server loaded, got ${servers.length}`)
  assert(servers[0]!.url === 'https://mcp.exa.ai/mcp', `url: ${servers[0]!.url}`)
  ok(`server "${servers[0]!.name}" · transport=${servers[0]!.type ?? '(inferred)'}`)

  // ── 3) 真连 ──
  console.log('3) connect (live network)')
  const t0 = Date.now()
  const conn = await connectMcpServers({ servers, timeoutMs: 45_000 })
  const dt = Date.now() - t0
  for (const f of conn.failures ?? []) {
    console.error(`  connect failure: ${f.name}: ${f.error}`)
  }
  for (const w of conn.warnings) console.error(`  warning: ${w}`)
  assert((conn.failures ?? []).length === 0, 'connected without failures')
  assert(conn.warnings.length === 0, `connected without warnings: ${conn.warnings.join(' | ')}`)
  assert(conn.servers.length === 1, `one live server, got ${conn.servers.length}`)
  const server = conn.servers[0]!
  assert(server.client.isConnected, 'client reports connected')
  ok(`connected in ${dt}ms · transport=${server.client.transport}`)

  try {
    // ── 4) 真列工具 ──
    // 注意区分两个层面：client.listTools() 是 server 真正提供的**全部**工具；
    // server.tools / conn.tools 是经 allowTools 过滤后、模型真正看得见的那部分。
    console.log('4) tools/list')
    const toolDefs = await server.client.listTools()
    assert(toolDefs.length > 0, 'server exposes at least one tool')
    const names = toolDefs.map((t) => t.name)
    ok(`${toolDefs.length} tools: ${names.join(', ')}`)

    // 找一个真的能搜网页的工具，不硬编码名字——第三方随时会改
    const searchDef =
      toolDefs.find((t) => /web_search|web-search/i.test(t.name)) ??
      toolDefs.find((t) => /search/i.test(t.name))
    assert(searchDef, `a search-ish tool exists among: ${names.join(', ')}`)
    ok(`picked "${searchDef!.name}"`)

    // ── 5) 注册成 Bolo 工具：模型看到的是 mcp__ 前缀名 ──
    console.log('5) registration as a model-visible tool')
    const registered = conn.tools.find((t) =>
      t.name.includes(searchDef!.name),
    )
    assert(registered, `search tool registered as a BoloTool: ${conn.tools.map((t) => t.name).join(', ')}`)
    const parsed = parseMcpToolName(registered!.name)
    assert(parsed, `name follows the mcp__ convention: ${registered!.name}`)
    assert(
      parsed!.server === server.name,
      `name carries the server: ${registered!.name}`,
    )
    assert(
      typeof registered!.description === 'string' &&
        registered!.description.length > 0,
      'tool has a description — the model needs it to decide when to call',
    )
    ok(`model sees "${registered!.name}"`)

    // preset 的 allowTools 必须对**真实 server** 生效：Exa 确实提供
    // web_fetch_exa，但 `search enable` 不该把它交给模型——实测中模型会拿它
    // 顶掉本地 WebFetch，于是抓取也一并出了机器。
    assert(
      toolDefs.some((t) => /fetch/i.test(t.name)),
      'sanity: the live server really does offer a fetch tool, so this is a real filter',
    )
    const visible = conn.tools.map((t) => t.name)
    assert(
      !visible.some((n) => /fetch/i.test(n)),
      `allowTools drops the remote fetch tool on the live server: ${visible.join(', ')}`,
    )
    assert(
      !server.tools.some((t) => /fetch/i.test(t.name)),
      `filtered cache excludes it too: ${server.tools.map((t) => t.name).join(', ')}`,
    )
    ok(`remote fetch tool withheld · model-visible: ${visible.join(', ')}`)

    // ── 6) 真调用，真查询 ──
    // 用一个答案会随时间变的查询：如果返回的是模型/缓存里的老东西而不是
    // 真实搜索，这里最容易露馅。
    console.log('6) tools/call (real query, real network)')
    const query = 'Node.js latest LTS version 2026'
    const t1 = Date.now()
    const result = await server.client.callTool(searchDef!.name, {
      query,
      numResults: 3,
    })
    const dt1 = Date.now() - t1
    assert(!result.isError, `call succeeded: ${JSON.stringify(result).slice(0, 300)}`)
    const text = formatMcpCallOutput(result)
    assert(text.length > 0, 'non-empty result body')
    ok(`got ${text.length} chars in ${dt1}ms`)

    // 证明这是**真的网页搜索**而不是空壳：正文里得有真实 URL
    const urls = [...text.matchAll(/https?:\/\/[^\s"'\\)\]]+/g)].map((m) => m[0])
    assert(urls.length > 0, `result carries real URLs; body head: ${text.slice(0, 400)}`)
    ok(`${urls.length} URLs · e.g. ${urls.slice(0, 3).join(' , ')}`)

    // ── 7) 通过模型真正会走的那个入口调一次 ──
    // 上面调的是 client.callTool；模型走的是注册出来的 BoloTool.execute。
    // 这两条路不是同一段代码，只验前者会漏掉包装层的 bug。
    console.log('7) invoke through the registered BoloTool (the path the model takes)')
    {
      const args = { query, numResults: 2 }

      // 7a) 模型的入参先过 schema 校验，再进 call —— 这一段也得对真 schema 成立
      const v = validateAgainstJsonSchema(registered!.inputJSONSchema, args)
      assert(
        (v as { success?: boolean }).success === true,
        `model args validate against the live schema: ${JSON.stringify(v)}`,
      )

      // 7b) MCP 工具必须要权限门控：它把查询发到第三方去
      assert(
        registered!.requiresPermission === true,
        'an MCP tool is permission-gated — it sends the query off-machine',
      )
      assert(
        registered!.isReadOnly(args) === false &&
          registered!.isConcurrencySafe(args) === false,
        'stays fail-closed on read-only / concurrency',
      )

      const res = await registered!.call(args, {} as never)
      assert(res.ok === true, `call ok: ${JSON.stringify(res).slice(0, 300)}`)
      assert(res.isError !== true, 'not flagged as error')
      const s = String(res.output ?? '')
      assert(s.length > 0, 'tool call returned content')
      assert(
        /https?:\/\//.test(s),
        `the model-facing path also returns real URLs; head: ${s.slice(0, 400)}`,
      )
      ok(`call path returned ${s.length} chars with real URLs`)
    }

    // ── 8) 坏参数不能把宿主炸掉 ──
    // 真实第三方的错误形状无法靠 mock 猜准，所以在活体里验一次。
    console.log('8) bad arguments degrade, not crash')
    {
      let threw: unknown
      let r: unknown
      try {
        r = await server.client.callTool(searchDef!.name, {
          query: '',
          numResults: -1,
        })
      } catch (e) {
        threw = e
      }
      // 两种都合法：抛受控错误，或返回 isError。崩溃/挂死才是失败。
      assert(
        threw !== undefined || r !== undefined,
        'bad args produced a controlled outcome',
      )
      ok(
        threw !== undefined
          ? `rejected: ${String((threw as Error).message).slice(0, 120)}`
          : `returned isError=${String((r as { isError?: unknown }).isError)}`,
      )
      // 宿主还得活着
      const still = await server.client.listTools()
      assert(still.length > 0, 'host still usable after a bad call')
      ok('connection still usable afterwards')
    }
  } finally {
    await closeMcpConnections(conn.servers).catch(() => {})
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('\nPASS: mcp-external search (live)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
