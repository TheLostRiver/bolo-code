/**
 * MCP server 的工具过滤（allowTools / excludeTools）
 *
 * 为什么需要它——活体端到端跑出来的：
 * 用户敲的是 `bolo search enable exa`，要的是**搜索**。但 Exa 的 MCP server
 * 一次列出两个工具，`web_fetch_exa` 就这么搭着进来了。实测中模型**真的选了它**
 * 而不是 Bolo 自带的本地 `WebFetch`——于是开了「搜索」，连**抓取**也一并
 * 绕道第三方服务器。
 *
 * 这不是 Exa 的问题，是我们的问题：注册路径把 server 列出的一切照单全收，
 * 用户没有任何办法只要其中一个。对一个在意「查询发给谁」的人来说，
 * 这等于替他做了一个他没同意的决定。
 *
 * 过滤必须落在 listTools() 之后那**一个**咽喉点上，否则 list_changed 重列时
 * 会把被排除的工具悄悄放回来——那种 bug 只在 server 热更新时才现形。
 *
 * 运行：npx tsx scripts/test-mcp-tool-filter.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  filterMcpToolDefs,
  connectMcpServers,
  closeMcpConnections,
  attachMcpListChangedHandlers,
  rebuildMcpBoloTools,
  type ConnectedMcpServer,
} from '../packages/mcp/src/host.ts'
import type { McpToolDef } from '../packages/mcp/src/client.ts'

const ECHO_SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/mcp-echo-server.mjs',
)

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const DEFS: McpToolDef[] = [
  { name: 'web_search_exa', description: 'search' },
  { name: 'web_fetch_exa', description: 'fetch a url' },
  { name: 'company_research', description: 'research' },
]

function names(list: { name: string }[]): string[] {
  return list.map((t) => t.name)
}

async function main() {
  // ── 1) 不配就是全都要（不能改变既有行为）──
  {
    const r = filterMcpToolDefs(DEFS, {})
    assert(r.tools.length === 3, `no filter keeps everything, got ${r.tools.length}`)
    assert(r.warnings.length === 0, 'no filter produces no warnings')
  }

  // ── 2) allowTools：白名单，其余一律不注册 ──
  {
    const r = filterMcpToolDefs(DEFS, { allowTools: ['web_search_exa'] })
    assert(
      JSON.stringify(names(r.tools)) === JSON.stringify(['web_search_exa']),
      `allow keeps only listed: ${names(r.tools).join(',')}`,
    )
  }

  // ── 3) excludeTools：黑名单 ──
  {
    const r = filterMcpToolDefs(DEFS, { excludeTools: ['web_fetch_exa'] })
    assert(
      !names(r.tools).includes('web_fetch_exa'),
      `exclude drops it: ${names(r.tools).join(',')}`,
    )
    assert(r.tools.length === 2, 'others survive')
  }

  // ── 4) 两者同时配：allow 先筛，exclude 再剔（exclude 更严，胜出）──
  {
    const r = filterMcpToolDefs(DEFS, {
      allowTools: ['web_search_exa', 'web_fetch_exa'],
      excludeTools: ['web_fetch_exa'],
    })
    assert(
      JSON.stringify(names(r.tools)) === JSON.stringify(['web_search_exa']),
      `exclude wins over allow — the stricter rule must win: ${names(r.tools).join(',')}`,
    )
  }

  // ── 5) 写错名字必须告警，不能静默注册 0 个工具 ──
  // 这是本功能最危险的失败模式：allowTools 打错一个字母 → 一个工具都没有 →
  // 模型完全不知道有搜索这回事 → 用户以为「配了但没用」。
  {
    const r = filterMcpToolDefs(DEFS, { allowTools: ['web_serach_exa'] })
    assert(r.tools.length === 0, 'typo matches nothing')
    assert(
      r.warnings.length > 0,
      'a typo in allowTools must warn, never fail silently',
    )
    const w = r.warnings.join(' ')
    assert(w.includes('web_serach_exa'), `warning names the bad entry: ${w}`)
    assert(
      /web_search_exa/.test(w),
      `warning lists what the server actually offers: ${w}`,
    )
  }

  // ── 6) exclude 写错名字也要告警（否则你以为排掉了，其实没有）──
  {
    const r = filterMcpToolDefs(DEFS, { excludeTools: ['web_fetch_exaa'] })
    assert(r.tools.length === 3, 'nothing excluded')
    assert(
      r.warnings.some((x) => x.includes('web_fetch_exaa')),
      `a no-op exclude must warn — silently keeping it is the dangerous case: ${r.warnings.join('|')}`,
    )
  }

  // ── 7) 端到端：过滤必须在真实连接路径上生效 ──
  // 用既有的 echo fixture（工具：echo · mutate；mutate 可动态加 extra 并发 list_changed）
  {
    const conn = await connectMcpServers({
      servers: [
        {
          name: 'echo',
          type: 'stdio',
          command: process.execPath,
          args: [ECHO_SERVER],
          excludeTools: ['extra'],
        },
      ],
      timeoutMs: 20_000,
    })
    assert(
      conn.servers.length === 1,
      `connected: ${conn.warnings.join('|')} ${(conn.failures ?? []).map((f) => f.error).join('|')}`,
    )
    const s = conn.servers[0]!
    assert(names(s.tools).includes('echo'), `echo survives: ${names(s.tools).join(',')}`)
    const registered = conn.tools.map((t) => t.name)
    assert(
      registered.some((n) => n.endsWith('__echo')),
      `unfiltered tool registered: ${registered.join(',')}`,
    )

    // ── 8) list_changed 重列后不得把被排除的工具放回来 ──
    // 只在 connect 处过滤就会漏掉这条：server 热更新时过滤规则丢失，
    // 被排除的工具悄悄复活。这种 bug 只在 server 动态改工具表时才现形。
    attachMcpListChangedHandlers(conn.servers)
    // 直连 client 调 mutate（它本身没被排除；即使被排除，client 层也不受影响）
    await s.client.callTool('mutate', { kind: 'tools', action: 'add' })
    // 等 host 异步 re-list
    for (let i = 0; i < 40 && !names(s.tools).includes('extra'); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert(
      !names(s.tools).includes('extra'),
      `re-list keeps the filter — an excluded tool must never come back: ${names(s.tools).join(',')}`,
    )
    const rebuilt = rebuildMcpBoloTools(conn.servers as ConnectedMcpServer[])
    assert(
      !rebuilt.tools.some((t) => t.name.endsWith('__extra')),
      `rebuild never resurrects an excluded tool: ${rebuilt.tools.map((t) => t.name).join(',')}`,
    )

    await closeMcpConnections(conn.servers).catch(() => {})
  }

  console.log('PASS: mcp tool filter')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
