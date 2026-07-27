/**
 * 文档里的 SearXNG config.json 片段必须**还能用**
 *
 * [LOCAL_SEARCH_AND_FETCH.md](../docs/LOCAL_SEARCH_AND_FETCH.md) 的配置应能照抄。
 * OI-04 删除了并不存在的 SearXNG MCP 桥，改为内置 WebSearch 直连 JSON API；
 * 因此这里把文档当配置契约的下游，校验字段、解析结果和源码真源引用。
 *
 * 只抽 `search.searxng` 片段，不做通用 md 校验——一个什么都想验的测试
 * 会因为无关文案改动频繁变红。
 *
 * 运行：npx tsx scripts/test-docs-config-snippets.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveSearxngSearchConfig } from '../packages/config/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/**
 * `SearxngSearchConfigJson` 的键。
 *
 * TypeScript 类型在运行时不存在，所以显式维护这份字段白名单；配置契约新增
 * 字段时，测试和文档必须一起作出决定。
 */
const SEARXNG_CONFIG_KEYS = new Set([
  'enabled',
  'baseUrl',
  'timeoutMs',
  'maxResults',
  'language',
  'safeSearch',
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
  const searxngBlocks = blocks.filter((block) => /"searxng"\s*:/.test(block))

  // 裁判自检：文档里必须**真的**有可抄的片段，否则下面的循环零次通过。
  assert(
    searxngBlocks.length > 0,
    `the doc really does carry a search.searxng config.json snippet to check (found ${searxngBlocks.length}); ` +
      `a passing run with zero snippets would prove nothing`,
  )

  for (const raw of searxngBlocks) {
    const text = stripTrailingCommas(stripLineComments(raw))
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (e) {
      assert(
        false,
        `a documented snippet is not valid JSON once comments are stripped ` +
          `(${e instanceof Error ? e.message : String(e)}):\n${text.slice(0, 200)}`,
      )
      return
    }

    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'the snippet is an object')
    const search = (parsed as Record<string, unknown>).search
    assert(search && typeof search === 'object' && !Array.isArray(search), 'the snippet defines search')
    const searxng = (search as Record<string, unknown>).searxng
    assert(
      searxng && typeof searxng === 'object' && !Array.isArray(searxng),
      'the snippet defines search.searxng',
    )

    for (const key of Object.keys(searxng as Record<string, unknown>)) {
      assert(
        SEARXNG_CONFIG_KEYS.has(key),
        `"${key}" in the documented search.searxng config is not a ` +
          `SearxngSearchConfigJson field; copied unknown keys are silently ignored`,
      )
    }

    const resolution = resolveSearxngSearchConfig(searxng)
    assert(
      resolution.status === 'enabled',
      `the documented search.searxng config resolves to an enabled tool: ${JSON.stringify(resolution)}`,
    )
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
  for (const required of [
    'packages/config/src/searxng.ts',
    'packages/tools/src/searxngSearch.ts',
  ]) {
    assert(srcRefs.includes(required), `the doc cites its ${required} source of truth`)
  }

  console.log(
    `PASS: documented config snippets (${searxngBlocks.length} search.searxng block, ` +
      `${new Set(links).size} doc links, ${new Set(srcRefs).size} source refs)`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
