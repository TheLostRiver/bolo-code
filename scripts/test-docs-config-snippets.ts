/**
 * 文档里的 mcp.json 片段必须**还能用**
 *
 * [LOCAL_SEARCH_AND_FETCH.md](../docs/LOCAL_SEARCH_AND_FETCH.md) 的卖点是
 * 「可照抄」。可照抄的配置一旦漂了，比没有文档更糟——用户会照着抄，
 * 然后得到一个静默不生效的 server（拼错的键就是被忽略的键），
 * 而他手里握着的是我们自己写的文档。
 *
 * 所以这里把文档当**契约的下游**来测：从 md 里抽出 jsonc 片段，
 * 逐个字段核对 `McpServerConfig` 真的有这个键。
 *
 * 只抽 `mcpServers` 片段，不做通用 md 校验——一个什么都想验的测试
 * 会因为文案改动天天变红，然后被人加进忽略名单。
 *
 * 运行：npx tsx scripts/test-docs-config-snippets.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveMcpTransport } from '../packages/mcp/src/types.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/**
 * `McpServerConfig` 的键。
 *
 * 手写一份而不是从类型反射：TypeScript 类型在运行时不存在，
 * 而这份清单本身就是断言的一半——它与 `packages/mcp/src/types.ts` 不一致时
 * 应该有人来改这里，那正是我们想要的提醒。
 */
const MCP_SERVER_KEYS = new Set([
  'name',
  'type',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'reconnectAttempts',
  'reconnectDelayMs',
  'tools',
  'allowTools',
  'excludeTools',
  'scope',
])

/** 去掉 // 行注释（文档里用 jsonc 便于讲解），保留字符串里的 // */
function stripLineComments(src: string): string {
  const out: string[] = []
  for (const line of src.split(/\r?\n/)) {
    let inStr = false
    let escaped = false
    let cut = -1
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (escaped) {
        escaped = false
        continue
      }
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === '"') {
        inStr = !inStr
        continue
      }
      if (!inStr && c === '/' && line[i + 1] === '/') {
        cut = i
        break
      }
    }
    out.push(cut >= 0 ? line.slice(0, cut) : line)
  }
  return out.join('\n')
}

/** 去掉尾逗号（注释删掉后可能留下） */
function stripTrailingCommas(src: string): string {
  return src.replace(/,(\s*[}\]])/g, '$1')
}

async function main() {
  const docPath = path.join(process.cwd(), 'docs', 'LOCAL_SEARCH_AND_FETCH.md')
  const md = await fs.readFile(docPath, 'utf8')

  const blocks = [...md.matchAll(/```jsonc?\n([\s\S]*?)```/g)].map((m) => m[1]!)
  const mcpBlocks = blocks.filter((b) => b.includes('mcpServers'))

  // 裁判自检：文档里必须**真的**有可抄的片段，否则下面的循环零次通过
  assert(
    mcpBlocks.length >= 2,
    `the doc really does carry mcp.json snippets to check (found ${mcpBlocks.length}); ` +
      `a passing run with zero snippets would prove nothing`,
  )

  for (const raw of mcpBlocks) {
    const text = stripTrailingCommas(stripLineComments(raw))
    let parsed: { mcpServers?: Record<string, Record<string, unknown>> }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch (e) {
      assert(
        false,
        `a documented snippet is not valid JSON once comments are stripped ` +
          `(${e instanceof Error ? e.message : String(e)}):\n${text.slice(0, 200)}`,
      )
      return
    }

    const servers = parsed.mcpServers
    assert(servers && Object.keys(servers).length > 0, 'the snippet defines a server')

    for (const [name, cfg] of Object.entries(servers!)) {
      for (const key of Object.keys(cfg)) {
        assert(
          MCP_SERVER_KEYS.has(key),
          `"${key}" in the documented "${name}" server is not a McpServerConfig field — ` +
            `a key that does not exist is silently ignored, so anyone copying this doc ` +
            `gets a server that quietly does not do what the doc says`,
        )
      }

      // 传输方式必须解得出来，且**该传输真正需要的字段要在**。
      //
      // 只断言 `transport !== null` 是不够的：显式写了 `type` 时
      // `resolveMcpTransport` 直接返回它，哪怕 command / url 一个都没有。
      // 而真正会出事的正是那种——连得上的判断在 host 里，标准是
      // 「stdio 要有 command，http/sse 要有 url」。
      const transport = resolveMcpTransport({ name, ...cfg } as never)
      assert(
        transport !== null,
        `the documented "${name}" server resolves to a transport; ` +
          `without type, command or url the host skips it entirely`,
      )
      const needs = transport === 'stdio' ? 'command' : 'url'
      const value = (cfg as Record<string, unknown>)[needs]
      assert(
        typeof value === 'string' && value.trim().length > 0,
        `the documented "${name}" server is ${transport}, so it needs a non-empty ` +
          `"${needs}" — otherwise the host skips it with ` +
          `"need command (stdio) or url (http/sse)" and the reader sees no tools`,
      )
    }
  }

  // 文档里的相对链接必须指到真实文件——死链会把人送进死胡同
  const links = [...md.matchAll(/\]\(\.\/([A-Za-z0-9_.-]+\.md)\)/g)].map((m) => m[1]!)
  assert(links.length > 0, 'the doc really does link to sibling docs')
  for (const rel of new Set(links)) {
    const target = path.join(process.cwd(), 'docs', rel)
    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false)
    assert(exists, `docs/LOCAL_SEARCH_AND_FETCH.md links to docs/${rel}, which exists`)
  }

  // 引用的源码路径同理
  const srcRefs = [...md.matchAll(/`(packages\/[A-Za-z0-9_/.-]+\.ts)`/g)].map((m) => m[1]!)
  assert(srcRefs.length > 0, 'the doc really does cite source files')
  for (const rel of new Set(srcRefs)) {
    const exists = await fs
      .access(path.join(process.cwd(), rel))
      .then(() => true)
      .catch(() => false)
    assert(exists, `the doc cites ${rel}, which exists`)
  }

  console.log(
    `PASS: documented config snippets (${mcpBlocks.length} mcp.json blocks, ` +
      `${new Set(links).size} doc links, ${new Set(srcRefs).size} source refs)`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
