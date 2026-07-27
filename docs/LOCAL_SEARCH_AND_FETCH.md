# 本地搜索与本地抓取

> 面向的问题：**「这些第三方工具是闭源的，我不放心。」**
>
> 本文给出可照抄的配置，并把每条路径「查询/URL 到底去了哪里」说清楚。
> 没有营销措辞——凡是会离开你机器的，这里都写明白。

本文给出 SearXNG compose 与 Bolo 直连配置。Bolo 不再为不存在的 `/mcp`
端点提供占位 preset，也不要求用户安装第三方桥；本地抓取仍由内置
`WebFetch` 完成。

---

## 0. 先确认你是不是真的需要它

`bolo search enable` 的那些 preset 会把查询发给服务商。但**抓取不会**：

| 能力 | 谁在做 | 出不出机器 |
|------|--------|-----------|
| `WebFetch`（读某个 URL） | **Bolo 自己**，直接 HTTP | 只连你给的那个站点 |
| `WebSearch`（找 URL） | hosted provider、显式 SearXNG 直连或 MCP server | 通常会出；取决于线路 |

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
| **SearXNG 自托管** | **仍然到达 Google/Bing/DuckDuckGo 等上游引擎** | docker + Bolo 显式配置 |
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

**200 但 `results: []` 仍然不算成功。** 真实上游会按出口 IP 限流、出
CAPTCHA 或超时；先看 JSON 的 `unresponsive_engines`。必要时在
`settings.yml` 显式启用当前网络可达的引擎，例如本仓 2026-07 live smoke
所在网络中 Bing 可用：

```yaml
engines:
  - name: bing
    disabled: false
```

这不是推荐所有人固定用 Bing，而是提醒：SearXNG 的“服务已启动”与“至少一个
上游能返回结果”是两个验收点。修改后 restart，再要求 `results` 非空。

---

## 3. 把它接进 Bolo

SearXNG 不讲 MCP，但它有稳定的 JSON 搜索接口。Bolo 直接调用该接口，
不需要桥。把下面配置写进用户 `~/.bolo/config.json` 或项目
`.bolo/config.json`：

```jsonc
{
  "search": {
    "searxng": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:8888",
      "timeoutMs": 15000,
      "maxResults": 8,
      "language": "zh-CN",
      "safeSearch": 1
    }
  }
}
```

`/search` 会自动追加；若 `baseUrl` 已以 `/search` 结尾则不会重复。字段含义：

| 字段 | 默认 | 约束 |
|------|------|------|
| `enabled` | 配置段存在即启用 | `false` 可关闭继承的用户配置 |
| `baseUrl` | 无 | 必填；公开地址必须 HTTPS |
| `timeoutMs` | `15000` | 100–60000 毫秒 |
| `maxResults` | `8` | 1–20 |
| `language` | 省略 | 字母、数字、`_`、`-`，最长 32 |
| `safeSearch` | `0` | 0 关闭、1 中等、2 严格 |

明文 HTTP 只允许显式 loopback/LAN 主机。URL 不能包含凭据、query 或 fragment；
无效配置会禁用工具并在 CLI/Desktop 显示 warning，不会猜测或回退到较低优先级
endpoint。项目配置只覆盖写出的子字段；要关闭用户层配置请写
`"enabled": false`。

查看解析后的线路：

```bash
bolo search status
```

输出会列出同时存在的 hosted、SearXNG direct 与 MCP 搜索线路，并对直连显示最终
endpoint。会话内 `/websearch off` 会把直连 `WebSearch` schema 从后续模型请求中
移除；`on` / `auto` 会恢复它。

### 3.1 验证边界

仓库内可重复的协议验证：

```bash
npm run test:searxng-search
```

它使用本地 HTTP fixture 覆盖参数、响应解析、错误分类、超时、响应/输出预算、
配置继承、reload 去重与生产 session 接线。它**没有**连接真实 SearXNG，也没有
验证上游引擎；这是可重复的默认门禁，不应改成依赖公网的测试。

OI-X1 已于 2026-07-27 在官方 Docker 镜像 `2026.7.26-b060c780d` 上完成真实
live smoke：直接 JSON 查询返回真实 URL；生产 status/session/permission-gated
`WebSearch` 全链通过，工具调用 2.32s 返回 5 条、6 个 URL。

活体也证明默认引擎会快速出现 Brave 429、Startpage CAPTCHA 和多引擎 timeout；
原始 JSON 与 Bolo 都如实返回空结果，启用当前网络可达的 Bing 后恢复。断网后
SearXNG 通常无法取得新结果，因为它仍依赖上游引擎；不能用“服务跑在本机”
推导“查询内容不出机器”。完整证据见 [OPEN_ISSUES.md](./OPEN_ISSUES.md) OI-X1。

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

## 5. 直连工具的安全与预算边界

- endpoint 只来自显式配置，不接受模型输入；这不是通用 SSRF 工具。
- 请求固定为 GET `/search?format=json`，重定向按错误处理。
- 单次响应最多 1,000,000 字节；结果最多 20 条，默认 8 条。
- title、URL、snippet 与元数据分别限长，最终工具输出最多 12,000 字符，
  并继续经过 compact 的 `WebSearch` 工具预算。
- 超时、HTTP 错误、非 JSON、错误响应形状、响应过大和网络失败使用不同
  `errorCode`，不把坏响应伪装成空结果。
- 结果 URL 只接受 HTTP/HTTPS；渲染为纯文本，不执行结果页面脚本。

---

## 6. 相关文档

- [PROVIDER_UX.md](./PROVIDER_UX.md) — `search enable` / preset 与 `allowTools`
- [PERMISSIONS.md](./PERMISSIONS.md) §5 — headless 下按工具放行（`--allowed-tools`）
- [CONFIG.md](./CONFIG.md) — `search.searxng` 配置字段与合并
- [TOOLS.md](./TOOLS.md) — `WebFetch` / `WebSearch` 契约
- `packages/config/src/searxng.ts` — 配置解析与 endpoint 策略真源
- `packages/tools/src/searxngSearch.ts` — 请求、解析与预算真源
