# 本地搜索与本地抓取

> 面向的问题：**「这些第三方工具是闭源的，我不放心。」**
>
> 本文给出可照抄的配置，并把每条路径「查询/URL 到底去了哪里」说清楚。
> 没有营销措辞——凡是会离开你机器的，这里都写明白。

ROADMAP §14.5 记着两条相关待办：**真·本地搜索路径**（"缺一份可照抄的
compose 文档"）与**本地抓取 preset**。本文交付前者，并解释后者为什么
**不做成 preset**。

---

## 0. 先确认你是不是真的需要它

`bolo search enable` 的那些 preset 会把查询发给服务商。但**抓取不会**：

| 能力 | 谁在做 | 出不出机器 |
|------|--------|-----------|
| `WebFetch`（读某个 URL） | **Bolo 自己**，直接 HTTP | 只连你给的那个站点 |
| `WebSearch`（找 URL） | hosted provider 或 MCP server | 出 |

也就是说**抓取本来就是本地的**。`search enable` 装 Exa preset 时刻意
只注册 `web_search_exa` 一个工具，把它的远程抓取工具挡在外面——否则模型会
拿远程抓取顶掉本地 `WebFetch`，连「你在读哪个 URL」也一并出了机器
（见 [PROVIDER_UX.md](./PROVIDER_UX.md) 与 `searchPresets.ts` 的 `allowTools`）。

**所以在动手之前先问：你缺的是搜索，还是渲染 JS 的抓取？** 前者往下看；
后者见 §4。

---

## 1. 三条路径的真实去向

| 路径 | 查询去哪 | 需要 |
|------|---------|------|
| hosted / Exa 等 preset | 服务商 | 一行配置 |
| **SearXNG 自托管** | **仍然到达 Google/Bing/DuckDuckGo 等上游引擎** | docker + 一个 MCP 桥 |
| **YaCy（自有索引）** | 不出你掌控的范围 | 自己爬、自己建索引 |

**SearXNG 不是 local-only，这点必须说清。** 它是**元搜索代理**，自己没有索引：
你自托管后，查询字符串仍由你的服务器转发给上游引擎。自托管隐藏的是
**你的 IP 与 cookie，不是查询内容**。

代码里这件事是**机器可读**的，不是靠注释守着——`SearchPreset.privacy`
是必填字段（`vendor` / `upstream-engines` / `local-only`），且有门禁测试
（`test-search-preset-privacy.ts`）禁止在非 `local-only` 的 preset 里写
「不出你的网络」这类绝对承诺。这个字段是补出来的：早先 searxng 的说明里
写过一句 `Nothing leaves your network if you run SearXNG yourself`，
那是假的。散文没人守得住，字段可以。

**真正 local-only 的只有自有索引**（YaCy intranet 模式一类）。代价是
搜索质量取决于你自己爬了多少——这不是配置问题，是索引问题。

---

## 2. 自托管 SearXNG（可照抄）

官方推荐 compose 部署，镜像 `docker.io/searxng/searxng:latest`。

```yaml
# docker-compose.yml
services:
  searxng:
    image: docker.io/searxng/searxng:latest
    container_name: searxng
    ports:
      - '127.0.0.1:8888:8080'   # 只绑 loopback：没有理由暴露到局域网
    volumes:
      - ./config:/etc/searxng            # settings.yml 等配置
      - ./data:/var/cache/searxng        # faviconcache.db 等持久数据
    environment:
      - SEARXNG_BASE_URL=http://127.0.0.1:8888/
    restart: unless-stopped
```

启动一次让它生成默认配置，然后**必须改一处**：

```yaml
# config/settings.yml
search:
  formats:
    - html
    - json        # ← 默认只有 html，不加这行任何 API 调用都拿不到结果
```

> 这是最容易卡住的一步：SearXNG **默认只开 `html`**，
> 官方文档原话是 "remove format to deny access"。不加 `json`，
> 桥连上了也只会拿到一堆 HTML。

改完 `docker compose restart searxng`，自测：

```bash
curl 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 200
```

拿到 JSON 才继续往下。

---

## 3. 把它接进 Bolo

SearXNG **不讲 MCP**，所以中间需要一个桥把 HTTP 翻成 MCP。

### 3.1 先说清楚你在信任什么

npm 上至少有 **十个**互相竞争的 SearXNG MCP 桥，**没有一个是权威实现**——
全部是单人维护的包。Bolo **不内置其中任何一个的 preset**，理由是具体的：

- 装 preset 意味着配置里会出现一条 `npx -y <package>` 之类的命令，
  而 `npx -y` 是**在你机器上下载并执行远端代码**。为一个「不信任第三方」的
  需求引入一个未经审计的第三方包，方向是反的。
- Bolo **不代跑第三方进程**（供应链 + 零运行时依赖红线）。
- 一个 preset 等于一次背书。在没有权威实现的领域，背书是误导。

**能做的是把配置写对、去向说清**，选包由你决定。挑的时候至少看三件事：
仓库是否开源可读、它有没有除 SearXNG 之外的出站连接、发布者是谁。

### 3.2 配置形状

桥跑起来后（stdio 或 http 都支持），写进 `.bolo/mcp.json`：

```jsonc
{
  "mcpServers": {
    "searxng": {
      // stdio：本地进程
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/your-bridge/index.js"],
      "env": { "SEARXNG_URL": "http://127.0.0.1:8888" },

      // 只注册你要的那个工具。桥往往还会带进来别的能力
      // （典型的是一个远程抓取工具，会顶掉本地 WebFetch）
      "allowTools": ["search"]
    }
  }
}
```

HTTP 桥则是：

```jsonc
{
  "mcpServers": {
    "searxng": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "allowTools": ["search"]
    }
  }
}
```

字段真源：`packages/mcp/src/types.ts` 的 `McpServerConfig`。
`type` 可省略——有 `command` 推断 stdio，有 `url` 推断 http。
`env` 的值支持 `${ENV_VAR}` 展开，**密钥不要写进文件**。

改完 `/mcp` 可以看连接状态与实际注册了哪些工具。

### 3.3 验证它真的在本地

```bash
# 断网也应该能搜（前提是 SearXNG 容器和桥都在本机）
# 若断网后搜索仍返回结果 → 说明确实没出机器
```

这一步值得做：**配置对不对，只有实测知道。**

---

## 4. 本地抓取：先看你是不是已经有了

`WebFetch` 是 Bolo 自己的工具，直接 HTTP 拉取，不经任何第三方。
**大多数场景不需要再装东西。**

真正的缺口只有一个：**需要执行 JavaScript 才出内容的页面**。
`WebFetch` 拉到的是原始 HTML，SPA 页面会是空壳。

要补这个缺口就得跑一个带无头浏览器的抓取 MCP server
（`fetcher-mcp` 一类，基于 Playwright）。同样**不做成 preset**，同样的理由：
它会下载并运行一个浏览器内核 + 一个第三方包。要装的话自己写进 `mcp.json`，
形状与 §3.2 相同。

**代价要摆在明面上：** 一个无头浏览器会执行目标站点的 JavaScript。
它是本地的，但它比 `WebFetch` 危险——`WebFetch` 只是把字节读回来，
浏览器是在**运行别人的代码**。为了少数几个 SPA 页面装它，值不值得由你判断。

---

## 5. 已评估但未实施：Bolo 直连 SearXNG

**现状的别扭之处：** SearXNG 暴露的是一个普通的 JSON HTTP 接口
（`/search?q=…&format=json`），而桥的全部工作就是把这个 GET 翻译成 MCP。
为此在一个隐私敏感的链路里插进一个未经审计的 npm 包，收益与代价不成比例。

**替代方案：** Bolo 直接打这个端点——用户给 URL，Bolo 发请求、解 JSON。
不需要桥、不需要第三方进程、不新增依赖（用全局 `fetch`）。

**为什么这里只是记录而不是直接做：**

`searchPresets.ts` 的模块头写着一条明确决定——「这条腿**不写新的 HTTP
搜索客户端**，搜索作为一个 MCP server 交付」。那条决定是针对**服务商**
线路做的，理由是复用已有的 MCP client 而不是造第二套客户端；
但自托管场景的目标恰恰相反——**不经过第三方**才是重点，
这时「多一个进程」不是省事而是引入风险。

**前提也是成立的：**服务商线路走 MCP 的理由（复用 client、结果进
`truncateMiddle` 与 per-tool 预算）对自托管同样可以满足——本地直连的结果
一样是 tool-result，一样过本地预算。

**推荐：实施。** 但它反转一条已写下的架构决定，且新增一个会发网络请求的
内置工具，属所有者决定。要立项的话，第一步是核实 SearXNG JSON 响应的
字段形状（`results[].url` / `.title` / `.content`）并按 fail-closed 解析，
而不是照着记忆写映射。

---

## 6. 相关文档

- [PROVIDER_UX.md](./PROVIDER_UX.md) — `search enable` / preset 与 `allowTools`
- [PERMISSIONS.md](./PERMISSIONS.md) §5 — headless 下按工具放行（`--allowed-tools`）
- [TOOLS.md](./TOOLS.md) — `WebFetch` / `WebSearch` 契约
- `packages/mcp/src/types.ts` — `McpServerConfig` 字段真源
- `packages/config/src/searchPresets.ts` — preset 与 `privacy` 字段
