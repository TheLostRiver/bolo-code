/**
 * 搜索 preset 必须如实说明「查询去哪」
 *
 * 本测试的直接起因是一条**假承诺**——searxng preset 的 notes 曾写着
 * `Nothing leaves your network if you run SearXNG yourself.`
 *
 * 这是错的。SearXNG 自己**没有索引**，它是元搜索代理：自托管之后，
 * 查询字符串仍然由你的服务器转发给上游引擎（Google / Bing / DuckDuckGo /
 * Brave …）。自托管隐藏的是**你的 IP 和 cookie，不是查询内容**。
 *
 * 这类错误比功能 bug 严重：有人会因为这句话，把本不该外发的查询发出去。
 * 而且它不会以任何形式报错——正是最难自查的那类。
 *
 * 所以「查询去哪」不能只活在散文里，必须是**机器可读的字段**，
 * 并由测试守住散文与字段的一致性。
 *
 * 运行：npx tsx scripts/test-search-preset-privacy.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_SEARCH_PRESETS,
  enableSearchPresetInMcpFile,
  listSearchPresets,
} from '../packages/config/src/index.ts'
import { runSearchCli } from '../packages/cli/src/searchCli.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 绝对化的隐私措辞——只有 local-only 才配这么说 */
const ABSOLUTE_CLAIM =
  /nothing leaves|never leaves|stays on your machine|does not leave your (network|machine)/i

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'preset-privacy-test')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})

  // ── 1) 每个 preset 都必须声明查询去哪 ──
  {
    for (const p of BUILTIN_SEARCH_PRESETS) {
      assert(
        p.privacy === 'vendor' ||
          p.privacy === 'upstream-engines' ||
          p.privacy === 'local-only',
        `preset "${p.id}" declares where queries go, got ${JSON.stringify(p.privacy)}`,
      )
    }
  }

  // ── 2) 散文不得比字段承诺得更多 ──
  // 这是本 bug 的机器化版本：只要 privacy 不是 local-only，
  // 就不许出现「什么都不外发」这类绝对措辞。
  {
    for (const p of BUILTIN_SEARCH_PRESETS) {
      const prose = `${p.label} ${p.notes ?? ''}`
      if (p.privacy !== 'local-only') {
        assert(
          !ABSOLUTE_CLAIM.test(prose),
          `preset "${p.id}" is ${p.privacy} but its text makes an absolute privacy claim: ${prose}`,
        )
      }
    }
  }

  // ── 3) searxng：具体到这条曾经错掉的 preset ──
  {
    const sx = BUILTIN_SEARCH_PRESETS.find((p) => p.id === 'searxng')
    assert(sx, 'searxng preset exists')
    assert(
      sx!.privacy === 'upstream-engines',
      `SearXNG is a metasearch proxy with no index of its own — queries still reach Google/Bing/etc, got privacy=${sx!.privacy}`,
    )
    const prose = `${sx!.label} ${sx!.notes ?? ''}`
    assert(
      /upstream|google|bing|engine/i.test(prose),
      `says queries still reach upstream engines: ${prose}`,
    )
    assert(
      /ip|cookie/i.test(prose),
      `says what self-hosting actually hides (your IP / cookies): ${prose}`,
    )
    // 第二个坑：SearXNG 原生不讲 MCP，直接指向它的端口永远连不上
    assert(
      /bridge|adapter|does not speak mcp|mcp server in front/i.test(prose),
      `warns that SearXNG itself does not speak MCP and needs a bridge: ${prose}`,
    )
  }

  // ── 4) exa：启用「搜索」不得搭售一个远程抓取工具 ──
  // 活体实测：两个工具一起进来后，模型选了 web_fetch_exa 而不是本地 WebFetch，
  // 于是用户的抓取也一并出了机器——他并没要求这个。
  {
    for (const id of ['exa', 'exa-key']) {
      const p = BUILTIN_SEARCH_PRESETS.find((x) => x.id === id)
      assert(p, `${id} preset exists`)
      assert(
        p!.privacy === 'vendor',
        `${id} sends queries to Exa, got ${p!.privacy}`,
      )
      assert(
        Array.isArray(p!.allowTools) && p!.allowTools.length > 0,
        `${id} registers only what the user asked for (search), got ${JSON.stringify(p!.allowTools)}`,
      )
      assert(
        p!.allowTools!.every((t) => !/fetch/i.test(t)),
        `${id} must not register a remote fetch tool by default: ${p!.allowTools!.join(',')}`,
      )
    }
  }

  // ── 5) allowTools 必须真的写进 mcp.json，否则字段等于摆设 ──
  {
    const mcpJsonPath = path.join(root, 'a', 'mcp.json')
    const r = await enableSearchPresetInMcpFile(mcpJsonPath, 'exa')
    assert(r.ok, `enable ok: ${JSON.stringify(r)}`)
    const written = JSON.parse(await fs.readFile(mcpJsonPath, 'utf8')) as {
      mcpServers: Record<string, { allowTools?: string[] }>
    }
    const entry = written.mcpServers['exa-search']
    assert(entry, 'server written')
    assert(
      Array.isArray(entry!.allowTools) && entry!.allowTools.length > 0,
      `allowTools reaches the config the MCP host actually reads: ${JSON.stringify(entry)}`,
    )
    assert(
      !entry!.allowTools!.some((t) => /fetch/i.test(t)),
      `no remote fetch tool in the written config: ${JSON.stringify(entry!.allowTools)}`,
    )
  }

  // ── 6) 用户在启用**之前**就该看到查询去哪 ──
  // 把这条信息只放在文档里等于没有：决策发生在敲命令的那一刻。
  {
    const out: string[] = []
    const code = await runSearchCli(['list'], {
      mcpJsonPath: path.join(root, 'b', 'mcp.json'),
      writeOut: (s) => out.push(s),
      writeErr: (s) => out.push(s),
    })
    assert(code === 0, 'list exits 0')
    const text = out.join('')
    assert(
      /queries|goes to|leaves|upstream/i.test(text),
      `list tells the user where queries go before they enable anything: ${text}`,
    )
    // 三档都要能在列表里区分出来
    assert(
      /exa/i.test(text) && /searxng/i.test(text),
      `lists all presets: ${text}`,
    )
  }

  // ── 7) enable 时也要复述一遍（list 可能没看）──
  {
    const out: string[] = []
    const code = await runSearchCli(['enable', 'exa'], {
      mcpJsonPath: path.join(root, 'c', 'mcp.json'),
      writeOut: (s) => out.push(s),
      writeErr: (s) => out.push(s),
    })
    assert(code === 0, 'enable exits 0')
    const text = out.join('')
    assert(
      /exa/i.test(text) && /(leave|queries|goes to)/i.test(text),
      `enable restates where queries will go: ${text}`,
    )
  }

  // ── 8) listSearchPresets 返回的是副本，改它不能污染内置表 ──
  {
    const a = listSearchPresets()
    a.pop()
    assert(
      listSearchPresets().length === BUILTIN_SEARCH_PRESETS.length,
      'listSearchPresets hands out a copy',
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: search preset privacy')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
