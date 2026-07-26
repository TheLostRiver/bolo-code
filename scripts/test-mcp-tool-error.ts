/**
 * MCP 工具错误必须说清「哪个 server、什么类别」
 *
 * 活体验证时真的撞上了这个：Exa 免密层按 IP 限速，偶发连不上，
 * 模型和用户看到的全部信息就两个词——`fetch failed`。
 *
 * 为什么这算 bug 而不是小事：
 * - 会话里可能挂着**多个** MCP server。只说 "fetch failed" 的话，
 *   用户不知道是哪一个坏了，也就无从修。
 * - **模型**也在读这条错误。它据此决定是重试、换工具、还是放弃。
 *   无信息的错误会让它瞎撞（实测就撞了：连着试 WebFetch、Bash，
 *   把 8 轮预算烧光）。
 * - provider 侧同类错误早就有 explainProviderError 给出「检查 baseUrl /
 *   是否在线 / 代理」的可行动提示；MCP 侧却什么都没有。同一类失败，
 *   两套待遇。
 *
 * 运行：npx tsx scripts/test-mcp-tool-error.ts
 */
import { boloToolFromMcp } from '../packages/mcp/src/host.ts'
import type { McpClient } from '../packages/mcp/src/client.ts'
import type { McpToolRegistration } from '../packages/mcp/src/types.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const REG: McpToolRegistration = {
  name: 'mcp__exa-search__web_search_exa',
  server: 'exa-search',
  tool: 'web_search_exa',
  description: 'search the web',
  requiresPermission: true,
}

/** 只实现被测路径需要的那部分；其余存在即可 */
function clientThatThrows(err: unknown, url?: string): McpClient {
  return {
    serverName: 'exa-search',
    transport: 'http',
    isConnected: true,
    capabilities: { tools: true },
    supportsTools: true,
    supportsResources: false,
    supportsPrompts: false,
    ...(url ? { url } : {}),
    connect: async () => {},
    close: async () => {},
    onNotification: () => () => {},
    listTools: async () => [],
    callTool: async () => {
      throw err
    },
    listResources: async () => [],
    readResource: async () => [],
    listPrompts: async () => [],
    getPrompt: async () => ({ messages: [] }),
  } as unknown as McpClient
}

async function callWith(err: unknown, url?: string): Promise<string> {
  const tool = boloToolFromMcp(REG, clientThatThrows(err, url))
  const res = await tool.call({ query: 'x' }, {} as never)
  assert(res.ok === false && res.isError === true, 'a throwing call is an error')
  return String(res.output ?? '')
}

async function main() {
  // ── 1) 网络类：必须指名 server，并给出可行动方向 ──
  // 这就是活体里真实发生的那条（Exa 免密层按 IP 限速）
  {
    const out = await callWith(new TypeError('fetch failed'))
    assert(
      out.includes('exa-search'),
      `names which MCP server failed — a session can have several: ${out}`,
    )
    assert(
      /could not reach|unreachable|network/i.test(out),
      `classifies it as a network failure, not a bare "fetch failed": ${out}`,
    )
    assert(
      out.toLowerCase().includes('fetch failed'),
      `keeps the original text — never swallow the real cause: ${out}`,
    )
    // 模型要靠它决定「重试还是换招」，所以必须说明这是可重试的
    assert(
      /retry|transient|temporar/i.test(out),
      `tells the reader (model included) it is worth retrying: ${out}`,
    )
  }

  // ── 2) 超时同属够不着，但成因不同，不能糊成一句 ──
  {
    const out = await callWith(new Error('The operation timed out'))
    assert(out.includes('exa-search'), `names the server: ${out}`)
    assert(
      /timed? out/i.test(out),
      `keeps the timeout wording rather than calling it a generic network error: ${out}`,
    )
  }

  // ── 3) 非网络错误不得被硬塞进网络叙事 ──
  // 乱贴「检查你的网络」会把人指向完全错误的方向，比不给提示更糟。
  {
    const out = await callWith(new Error('tool "web_search_exa" not found'))
    assert(out.includes('exa-search'), `still names the server: ${out}`)
    assert(
      !/could not reach|check your connection/i.test(out),
      `does not invent a network diagnosis for a non-network error: ${out}`,
    )
    assert(
      out.includes('not found'),
      `surfaces the actual message: ${out}`,
    )
  }

  // ── 4) 非 Error 抛出物也不能把宿主搞崩 ──
  {
    const out = await callWith('plain string failure')
    assert(out.includes('exa-search'), `names the server: ${out}`)
    assert(out.includes('plain string failure'), `keeps the text: ${out}`)
  }

  // ── 5) isError 结果（server 正常应答但报错）保持原样，不加网络叙事 ──
  {
    const tool = boloToolFromMcp(REG, {
      ...clientThatThrows(new Error('unused')),
      callTool: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'query must not be empty' }],
      }),
    } as unknown as McpClient)
    const res = await tool.call({ query: '' }, {} as never)
    assert(res.ok === false, 'server-reported error stays an error')
    const out = String(res.output ?? '')
    assert(
      out.includes('query must not be empty'),
      `server's own message is preserved verbatim: ${out}`,
    )
    assert(
      !/could not reach/i.test(out),
      `a server-side validation error is not a network problem: ${out}`,
    )
  }

  // ── 6) 成功路径一个字都不许多加 ──
  {
    const tool = boloToolFromMcp(REG, {
      ...clientThatThrows(new Error('unused')),
      callTool: async () => ({ content: [{ type: 'text', text: 'RESULT' }] }),
    } as unknown as McpClient)
    const res = await tool.call({ query: 'x' }, {} as never)
    assert(res.ok === true && res.isError !== true, 'success stays success')
    assert(
      String(res.output) === 'RESULT',
      `success output is untouched, got ${JSON.stringify(res.output)}`,
    )
  }

  console.log('PASS: mcp tool error')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
