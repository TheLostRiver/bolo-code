/**
 * `bolo search` 子命令
 *
 * S4 做了 preset 逻辑，但没接 CLI 入口——而状态提示里已经写着
 * 「run 'bolo search enable exa'」。**指着一个不存在的命令比什么都不说更糟**：
 * 用户照做，得到「未知参数」，然后以为整个功能坏了。
 *
 * DeepSeek 官方 API 实测确认了这条腿的必要性：
 * - `tools:[{type:'web_search'}]` → **硬 400**（`unknown variant, expected 'function'`）
 * - body 顶层未知字段 → **静默忽略**
 * 所以普通 compatible 端点既拿不到 hosted 搜索，也不能靠乱塞字段碰运气；
 * MCP 是这条腿唯一的真实路径。
 *
 * 运行：npx tsx scripts/test-search-cli.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runSearchCli } from '../packages/cli/src/searchCli.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function collect() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    writeOut: (s: string) => out.push(s),
    writeErr: (s: string) => err.push(s),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'search-cli-test')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  // ── 1) list 列出可选项，且标明哪个不需要 key ──
  {
    const io = collect()
    const code = await runSearchCli(['list'], {
      mcpJsonPath: path.join(root, 'a', 'mcp.json'),
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    })
    assert(code === 0, `list exits 0, got ${code}`)
    const text = io.stdout()
    assert(text.includes('exa'), `lists exa: ${text}`)
    assert(
      /no key|keyless/i.test(text),
      `marks which option needs no key: ${text}`,
    )
  }

  // ── 2) enable 真的写进 mcp.json ──
  {
    const mcpJsonPath = path.join(root, 'b', 'mcp.json')
    const io = collect()
    const code = await runSearchCli(['enable', 'exa'], {
      mcpJsonPath,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    })
    assert(code === 0, `enable exits 0, got ${code} · ${io.stderr()}`)
    const written = JSON.parse(await fs.readFile(mcpJsonPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    assert(
      Object.keys(written.mcpServers ?? {}).length === 1,
      'server written to mcp.json',
    )
    assert(
      io.stdout().includes(mcpJsonPath),
      `tells the user which file changed: ${io.stdout()}`,
    )
  }

  // ── 3) 需要 key 的 preset 必须说清还要设什么环境变量 ──
  {
    const io = collect()
    const code = await runSearchCli(['enable', 'exa-key'], {
      mcpJsonPath: path.join(root, 'c', 'mcp.json'),
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    })
    assert(code === 0, 'keyed preset enables')
    assert(
      io.stdout().includes('EXA_API_KEY'),
      `names the env var the user still has to set: ${io.stdout()}`,
    )
  }

  // ── 4) 未知 preset：拒绝 + 列出可选，不静默失败 ──
  {
    const io = collect()
    const code = await runSearchCli(['enable', 'nope'], {
      mcpJsonPath: path.join(root, 'd', 'mcp.json'),
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    })
    assert(code !== 0, 'unknown preset exits non-zero')
    const text = io.stderr()
    assert(text.includes('nope'), `names what was wrong: ${text}`)
    assert(text.includes('exa'), `lists the valid options: ${text}`)
  }

  // ── 5) 缺子命令：给用法而不是堆栈 ──
  {
    const io = collect()
    const code = await runSearchCli([], {
      mcpJsonPath: path.join(root, 'e', 'mcp.json'),
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    })
    assert(code !== 0, 'missing subcommand exits non-zero')
    assert(
      /usage|list|enable/i.test(io.stderr()),
      `shows usage: ${io.stderr()}`,
    )
  }

  // ── 6) 状态提示里承诺的命令必须真的存在（本 bug 的根因） ──
  {
    const { describeWebSearchStatus } = await import(
      '../packages/config/src/index.ts'
    )
    const summary = describeWebSearchStatus({
      dialectId: 'off',
      hasSearchMcpServer: false,
    }).summary
    const m = summary.match(/bolo search (\w+)(?:\s+(\w[\w-]*))?/)
    assert(m !== null, `status suggests a bolo search command: ${summary}`)
    const io = collect()
    const argv = [m![1]!, ...(m![2] ? [m![2]] : [])]
    const code = await runSearchCli(argv, {
      mcpJsonPath: path.join(root, 'f', 'mcp.json'),
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    })
    assert(
      code === 0,
      `the command the status text tells users to run must actually work: 'bolo search ${argv.join(' ')}' exited ${code} · ${io.stderr()}`,
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: search cli')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
